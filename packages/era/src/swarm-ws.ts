// WebSocket client for Bee's /chunks/stream endpoint.
//
// The HTTP /chunks endpoint pays a full request round-trip per chunk. For
// manifest uploads that emit tens of thousands of small chunks, that overhead
// dominates. /chunks/stream keeps a single socket open, accepts binary frames
// (span || payload) for each chunk, and replies with an empty binary frame
// per successful write. Bee acks in send order, so we track pending chunks in
// a FIFO queue.

import WebSocket, { type RawData } from 'ws'
import { bmtHash, makeChunk, MAX_PAYLOAD_SIZE } from './swarm-chunk.js'

export interface BeeChunkStreamOptions {
  beeUrl: string // e.g. http://localhost:1633
  batchId: string
  tag?: number
  maxInFlight?: number // default: 256
  /**
   * If the oldest pending chunk has been waiting for an ack longer than this
   * (ms), fail the stream. Default: 30s. Set to 0 to disable. Bee sometimes
   * silently drops chunks over /chunks/stream (e.g. mid-upload stamp trouble);
   * without a timeout a hang is indistinguishable from a slow node.
   */
  ackTimeoutMs?: number
}

interface Pending {
  resolve: (address: Uint8Array) => void
  reject: (err: Error) => void
  address: Uint8Array
  sentAt: number
}

/**
 * Pipelined chunk uploader over Bee's `/chunks/stream` WebSocket. Callers
 * send chunks and receive the chunk's BMT address once Bee acknowledges it.
 * Ordering is FIFO — Bee acks in send order.
 */
export class BeeChunkStream {
  private ws: WebSocket | null = null
  private pending: Pending[] = []
  private queued: Array<() => void> = []
  private closed = false
  private error: Error | null = null
  private watchdog: NodeJS.Timeout | null = null

  constructor(private opts: BeeChunkStreamOptions) {}

  async open(): Promise<void> {
    const wsUrl = httpToWs(this.opts.beeUrl) + '/chunks/stream'
    const headers: Record<string, string> = {
      'Swarm-Postage-Batch-Id': this.opts.batchId,
    }
    if (this.opts.tag !== undefined) {
      headers['Swarm-Tag'] = String(this.opts.tag)
    } else {
      // Without a tag there's no way for Bee to track queued chunks, so ask
      // for synchronous push (deferred=false) — required on gateways where
      // /tags is unavailable and useful in general for tag-less uploads.
      headers['Swarm-Deferred-Upload'] = 'false'
    }

    const ws = new WebSocket(wsUrl, { headers })
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onErr)
        resolve()
      }
      const onErr = (err: Error) => {
        ws.off('open', onOpen)
        reject(err)
      }
      ws.once('open', onOpen)
      ws.once('error', onErr)
    })

    ws.on('message', (msg: RawData, isBinary: boolean) => this.onMessage(msg, isBinary))
    ws.on('close', (code, reason) => this.onClose(code, reason))
    ws.on('error', (err) => this.onError(err))

    const ackTimeoutMs = this.opts.ackTimeoutMs ?? 30_000
    if (ackTimeoutMs > 0) {
      this.watchdog = setInterval(
        () => {
          const oldest = this.pending[0]
          if (!oldest) return
          const waited = Date.now() - oldest.sentAt
          if (waited > ackTimeoutMs) {
            this.fail(
              new Error(
                `chunk stream stalled: no ack for ${waited} ms on oldest pending chunk (${this.pending.length} pending)`,
              ),
            )
          }
        },
        Math.min(5_000, Math.max(1_000, ackTimeoutMs / 6)),
      )
      this.watchdog.unref?.()
    }
  }

  /**
   * Build a single-chunk CAC from `payload`, send it, and resolve with the
   * chunk's 32-byte BMT address once Bee acks. Payload must be ≤4096 bytes.
   */
  async uploadChunkPayload(payload: Uint8Array): Promise<Uint8Array> {
    const chunk = makeChunk(payload)
    await this.sendChunkData(chunk.data, chunk.address)
    return chunk.address
  }

  /**
   * Send a raw pre-built chunk (`span || payload`) whose BMT address is
   * already known. Used when the caller has built a Swarm tree locally.
   */
  async sendChunkData(chunkData: Uint8Array, address: Uint8Array): Promise<void> {
    if (chunkData.length - 8 > MAX_PAYLOAD_SIZE) {
      throw new Error('chunk payload exceeds 4096 bytes')
    }

    await this.waitForSlot()

    if (this.error) throw this.error
    if (this.closed || !this.ws) throw new Error('chunk stream closed')

    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        resolve: () => resolve(),
        reject,
        address,
        sentAt: Date.now(),
      })
      this.ws!.send(chunkData, { binary: true }, (err) => {
        if (err) {
          // Send failed before the frame left the socket — pop the matching
          // pending entry so the queue stays aligned with server-side acks.
          const idx = this.pending.findIndex((p) => p.address === address)
          if (idx !== -1) this.pending.splice(idx, 1)
          reject(err)
        }
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    // Wait for all pending acks to drain before closing, otherwise Bee
    // may drop the in-flight chunks.
    while (this.pending.length > 0 && !this.error && this.ws?.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }

    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }

  private async waitForSlot(): Promise<void> {
    const max = this.opts.maxInFlight ?? 256
    while (this.pending.length >= max && !this.error && !this.closed) {
      await new Promise<void>((resolve) => this.queued.push(resolve))
    }
  }

  private onMessage(msg: RawData, isBinary: boolean): void {
    if (!isBinary) {
      // Text frames indicate errors (e.g. stamp issues) — propagate to the
      // oldest pending send and fail fast.
      const text = msg.toString()
      this.fail(new Error(`chunk stream error: ${text}`))
      return
    }
    // Empty binary = ack for the next-in-order chunk.
    const next = this.pending.shift()
    if (!next) {
      this.fail(new Error('received ack with no pending chunk'))
      return
    }
    next.resolve(next.address)
    this.releaseSlot()
  }

  private onClose(code: number, reason: Buffer): void {
    if (this.pending.length > 0 && !this.error) {
      this.fail(
        new Error(`chunk stream closed mid-flight (code=${code} reason=${reason.toString()})`),
      )
    }
    this.closed = true
    this.releaseAllSlots()
  }

  private onError(err: Error): void {
    this.fail(err)
  }

  private fail(err: Error): void {
    if (this.error) return
    this.error = err
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    for (const p of this.pending) p.reject(err)
    this.pending = []
    this.releaseAllSlots()
  }

  private releaseSlot(): void {
    const next = this.queued.shift()
    if (next) next()
  }

  private releaseAllSlots(): void {
    const waiters = this.queued
    this.queued = []
    for (const w of waiters) w()
  }
}

function httpToWs(url: string): string {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length)
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length)
  return url
}

// Re-export for callers that only need the address without sending.
export { bmtHash, makeChunk }
