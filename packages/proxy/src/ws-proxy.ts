// WebSocket proxy for Bee's /chunks/stream endpoint.
//
// Upstream protocol: client sends binary frames (8-byte span || ≤4 KiB
// payload) and receives empty binary frames as acks in FIFO order. We
// cache each frame by (sha256(payload), batch_id, '/chunks/stream') — a
// cache hit skips the upstream round-trip entirely and synthesises an
// ack. Order is preserved via a per-connection FIFO: acks to the client
// only drain once the head of the queue has resolved, so hits behind an
// unacked miss wait their turn instead of being delivered out of order.
//
// On upstream drops the proxy reconnects with exponential backoff and
// replays still-pending chunks in queue order — Bee is content-addressed
// so duplicate sends are idempotent. The client sees a single continuous
// stream.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { UploadCache } from './cache.js'
import type { ProxyConfig, StampStats } from './proxy.js'

const WS_PATH_PREFIX = '/chunks/stream'
const WS_CACHE_PATH = '/chunks/stream'
const EMPTY = Buffer.alloc(0)

const MAX_WS_ATTEMPTS = 5
const BASE_WS_DELAY_MS = 200

// Headers that the ws library manages or that are hop-by-hop: don't
// forward to upstream (it would confuse the upgrade handshake).
const SKIP_UPGRADE_HEADERS = new Set([
  'connection',
  'upgrade',
  'host',
  'content-length',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'sec-websocket-accept',
])

const wss = new WebSocketServer({ noServer: true })

export function handleWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  cfg: ProxyConfig,
  stamps: Map<string, StampStats>,
): void {
  const path = (req.url ?? '').split('?')[0]
  if (path !== WS_PATH_PREFIX && !path.startsWith(WS_PATH_PREFIX + '/')) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    void runWsSession(clientWs, req, cfg, stamps)
  })
}

type EntryState = 'hit' | 'miss-pending' | 'miss-sent' | 'miss-acked'

interface QueueEntry {
  hash: Buffer
  payload: Buffer
  state: EntryState
}

async function runWsSession(
  clientWs: WebSocket,
  req: IncomingMessage,
  cfg: ProxyConfig,
  stamps: Map<string, StampStats>,
): Promise<void> {
  const batchId = headerOne(req.headers['swarm-postage-batch-id'])
  const cache = cfg.cache
  const canCache = Boolean(cache && batchId)

  const queue: QueueEntry[] = []
  let upstreamWs: WebSocket | null = null
  let clientClosed = false
  let frameCount = 0
  let hitCount = 0
  let missCount = 0
  const startedMs = Date.now()

  const upstreamHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (SKIP_UPGRADE_HEADERS.has(k.toLowerCase())) continue
    upstreamHeaders[k] = Array.isArray(v) ? v.join(', ') : v
  }
  const upstreamUrl = `ws://${cfg.upstreamHost}:${cfg.upstreamPort}${req.url ?? '/'}`
  const label = `WS ${req.url ?? WS_PATH_PREFIX}`
  const batchLabel = batchId ? ` (batch=${batchId.slice(0, 8)})` : ''

  function onUpstreamMessage(data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data as Buffer)
      }
      return
    }
    // Empty binary frame = ack for next sent miss (Bee acks in FIFO order).
    const entry = queue.find((e) => e.state === 'miss-sent')
    if (entry) {
      entry.state = 'miss-acked'
      drain()
    }
  }

  function onUpstreamClose(code: number): void {
    if (clientClosed) return
    upstreamWs = null
    for (const entry of queue) {
      if (entry.state === 'miss-sent') entry.state = 'miss-pending'
    }
    process.stderr.write(`${label} -> upstream closed (code=${code}), reconnecting\n`)
    void connect()
  }

  function onUpstreamError(_err: Error): void {
    // The close handler handles cleanup and reconnect.
  }

  async function connect(): Promise<boolean> {
    if (clientClosed) return false
    let attempt = 0
    while (!clientClosed) {
      attempt++
      try {
        const ws = new WebSocket(upstreamUrl, { headers: upstreamHeaders })
        await new Promise<void>((resolve, reject) => {
          const onOpen = (): void => {
            ws.off('error', onErr)
            resolve()
          }
          const onErr = (err: Error): void => {
            ws.off('open', onOpen)
            reject(err)
          }
          ws.once('open', onOpen)
          ws.once('error', onErr)
        })
        upstreamWs = ws
        ws.on('message', onUpstreamMessage)
        ws.on('close', onUpstreamClose)
        ws.on('error', onUpstreamError)
        // Replay in-order anything that was pending (including frames that
        // arrived while upstream was down).
        for (const entry of queue) {
          if (entry.state === 'miss-pending') {
            ws.send(entry.payload, { binary: true })
            entry.state = 'miss-sent'
          }
        }
        return true
      } catch (err) {
        const e = err as Error
        if (attempt >= MAX_WS_ATTEMPTS) {
          process.stderr.write(
            `${label} -> upstream unreachable after ${attempt} attempts (${e.message})\n`,
          )
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'upstream unreachable')
          }
          return false
        }
        const delay = BASE_WS_DELAY_MS * Math.pow(2, attempt - 1)
        process.stderr.write(
          `${label} -> upstream retry ${attempt}/${MAX_WS_ATTEMPTS - 1} in ${delay}ms (${e.message})\n`,
        )
        await sleep(delay)
      }
    }
    return false
  }

  function drain(): void {
    while (
      queue.length > 0 &&
      (queue[0]!.state === 'hit' || queue[0]!.state === 'miss-acked')
    ) {
      const entry = queue.shift()!
      if (entry.state === 'miss-acked' && canCache) {
        cache!.store(entry.hash, batchId!, WS_CACHE_PATH, {
          status: 200,
          headers: {},
          body: EMPTY,
        })
      }
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(EMPTY, { binary: true })
      }
    }
  }

  function onClientMessage(data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      if (upstreamWs?.readyState === WebSocket.OPEN) {
        upstreamWs.send(data as Buffer)
      }
      return
    }
    const payload = Buffer.isBuffer(data)
      ? (data as Buffer)
      : Buffer.from(data as ArrayBuffer)
    frameCount++

    if (!canCache) {
      const connected = upstreamWs?.readyState === WebSocket.OPEN
      queue.push({
        hash: EMPTY,
        payload,
        state: connected ? 'miss-sent' : 'miss-pending',
      })
      if (connected) upstreamWs!.send(payload, { binary: true })
      return
    }

    const hash = UploadCache.hashBody(payload)
    if (cache!.lookup(hash, batchId!, WS_CACHE_PATH)) {
      hitCount++
      queue.push({ hash, payload, state: 'hit' })
      drain()
      return
    }
    missCount++
    const connected = upstreamWs?.readyState === WebSocket.OPEN
    queue.push({ hash, payload, state: connected ? 'miss-sent' : 'miss-pending' })
    if (connected) upstreamWs!.send(payload, { binary: true })
  }

  clientWs.on('message', onClientMessage)
  clientWs.on('error', (err) => {
    process.stderr.write(`${label} client error: ${err.message}\n`)
  })
  clientWs.on('close', () => {
    clientClosed = true
    const durationS = ((Date.now() - startedMs) / 1000).toFixed(1)
    process.stderr.write(
      `${label} closed${batchLabel} frames=${frameCount} hit=${hitCount} miss=${missCount} duration=${durationS}s\n`,
    )
    if (batchId) {
      const short = batchId.slice(0, 8)
      const stats = stamps.get(short) ?? { uploads: 0, bytes: 0 }
      stats.uploads += frameCount
      stamps.set(short, stats)
    }
    if (upstreamWs) upstreamWs.close()
  })

  const ok = await connect()
  if (ok) {
    process.stderr.write(`${label} -> upstream connected${batchLabel}\n`)
  }
}

function headerOne(h: string | string[] | undefined): string | null {
  if (!h) return null
  return Array.isArray(h) ? (h[0] ?? null) : h
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
