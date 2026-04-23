// Integration tests for the /chunks/stream WebSocket proxy. Like the HTTP
// tests, each test runs a fresh mock upstream + proxy on ephemeral ports so
// they never collide with a running proxy/Bee.

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'

import { UploadCache } from './cache.js'
import {
  randomBatchId,
  randomBody,
  startProxy,
  startUpstream,
  type ProxyHandle,
  type UpstreamHandle,
} from './test-helpers.js'

const EMPTY = Buffer.alloc(0)

interface ClientHandle {
  ws: WebSocket
  binaryFrames: Buffer[]
  close(): Promise<void>
}

function connectClient(
  proxy: ProxyHandle,
  path: string,
  headers: Record<string, string> = {},
): Promise<ClientHandle> {
  return new Promise((resolve, reject) => {
    const binaryFrames: Buffer[] = []
    const ws = new WebSocket(`ws://${proxy.host}:${proxy.port}${path}`, { headers })
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return
      binaryFrames.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
    })
    ws.once('open', () =>
      resolve({
        ws,
        binaryFrames,
        close() {
          return new Promise<void>((res) => {
            if (ws.readyState === WebSocket.CLOSED) {
              res()
              return
            }
            ws.once('close', () => res())
            ws.close()
          })
        },
      }),
    )
    ws.once('error', reject)
  })
}

function waitFor(pred: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (pred()) {
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'))
        return
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

describe('WebSocket /chunks/stream', () => {
  let upstream: UpstreamHandle | undefined
  let proxy: ProxyHandle | undefined

  afterEach(async () => {
    await proxy?.close()
    await upstream?.close()
    upstream = undefined
    proxy = undefined
  })

  it('non-/chunks/stream upgrade requests are rejected', async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    proxy = await startProxy({ upstream })

    const ws = new WebSocket(`ws://${proxy.host}:${proxy.port}/not-stream`)
    await new Promise<void>((resolve) => {
      ws.once('error', () => resolve())
      ws.once('close', () => resolve())
    })
  })

  it('forwards binary frames upstream and relays acks to client', async () => {
    const received: Buffer[] = []
    upstream = await startUpstream(() => {
      /* HTTP unused on this test */
    })
    upstream.onUpgrade = (ws) => {
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) return
        received.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
        ws.send(EMPTY, { binary: true })
      })
    }
    proxy = await startProxy({ upstream })

    const client = await connectClient(proxy, '/chunks/stream', {
      'swarm-postage-batch-id': randomBatchId(),
    })
    const payload = randomBody(100)
    client.ws.send(payload, { binary: true })
    await waitFor(() => client.binaryFrames.length === 1)
    expect(received).toHaveLength(1)
    expect(received[0]!.equals(payload)).toBe(true)
    expect(client.binaryFrames[0]!.length).toBe(0)
    await client.close()
  })

  it('caches frames per batch: re-sending same bytes skips upstream', async () => {
    let upstreamRx = 0
    upstream = await startUpstream(() => {})
    upstream.onUpgrade = (ws) => {
      ws.on('message', (_data: RawData, isBinary: boolean) => {
        if (!isBinary) return
        upstreamRx++
        ws.send(EMPTY, { binary: true })
      })
    }
    proxy = await startProxy({ upstream })

    const batchId = randomBatchId()
    const payload = randomBody(64)

    // Session 1: miss -> upstream -> ack.
    const c1 = await connectClient(proxy, '/chunks/stream', {
      'swarm-postage-batch-id': batchId,
    })
    c1.ws.send(payload, { binary: true })
    await waitFor(() => c1.binaryFrames.length === 1)
    expect(upstreamRx).toBe(1)
    await c1.close()

    // Session 2: same (payload, batch) should hit cache and get a synthesised ack.
    const c2 = await connectClient(proxy, '/chunks/stream', {
      'swarm-postage-batch-id': batchId,
    })
    c2.ws.send(payload, { binary: true })
    await waitFor(() => c2.binaryFrames.length === 1)
    expect(upstreamRx).toBe(1)
    expect(c2.binaryFrames[0]!.length).toBe(0)
    await c2.close()
  })

  it('preserves FIFO ack order when a hit follows a miss', async () => {
    let upstreamRx = 0
    const pendingAcks: Array<() => void> = []
    upstream = await startUpstream(() => {})
    upstream.onUpgrade = (ws) => {
      ws.on('message', (_data: RawData, isBinary: boolean) => {
        if (!isBinary) return
        upstreamRx++
        // Hold the ack until the test releases it, so we can observe order.
        pendingAcks.push(() => ws.send(EMPTY, { binary: true }))
      })
    }
    proxy = await startProxy({ upstream })

    const batchId = randomBatchId()
    const missPayload = randomBody(32)
    const hitPayload = randomBody(48)

    // Pre-populate cache directly so hitPayload is a cache hit without
    // routing any prior frames through upstream.
    proxy.cache!.store(UploadCache.hashBody(hitPayload), batchId, '/chunks/stream', {
      status: 200,
      headers: {},
      body: EMPTY,
    })

    // Send miss then cached hit. The cached hit must wait behind the unacked
    // miss — FIFO order guarantees clients can't see hit's ack before miss's.
    const client = await connectClient(proxy, '/chunks/stream', {
      'swarm-postage-batch-id': batchId,
    })
    client.ws.send(missPayload, { binary: true })
    client.ws.send(hitPayload, { binary: true })

    // Wait for the miss to reach upstream.
    await waitFor(() => pendingAcks.length === 1)
    // Give the proxy a beat to do anything wrong; neither ack should flow.
    await new Promise((r) => setTimeout(r, 50))
    expect(client.binaryFrames).toHaveLength(0)

    // Release the miss ack; both acks should now flow through in order.
    pendingAcks.shift()!()
    await waitFor(() => client.binaryFrames.length === 2)
    expect(upstreamRx).toBe(1) // upstream only ever saw the miss
    await client.close()
  })

  it('without batch id, every frame hits upstream (no caching)', async () => {
    let upstreamRx = 0
    upstream = await startUpstream(() => {})
    upstream.onUpgrade = (ws) => {
      ws.on('message', (_data: RawData, isBinary: boolean) => {
        if (!isBinary) return
        upstreamRx++
        ws.send(EMPTY, { binary: true })
      })
    }
    proxy = await startProxy({ upstream })

    const payload = randomBody(32)
    const c1 = await connectClient(proxy, '/chunks/stream')
    c1.ws.send(payload, { binary: true })
    c1.ws.send(payload, { binary: true })
    await waitFor(() => c1.binaryFrames.length === 2)
    expect(upstreamRx).toBe(2)
    await c1.close()
  })

  it('reconnects to upstream after drop and replays pending frames', async () => {
    const received: Buffer[] = []
    let upstreamConns = 0
    upstream = await startUpstream(() => {})
    upstream.onUpgrade = (ws) => {
      upstreamConns++
      if (upstreamConns === 1) {
        // Drop before replying so the proxy has a pending unacked miss.
        ws.on('message', () => {
          /* swallow; socket will be terminated */
        })
        setTimeout(() => ws.terminate(), 50)
        return
      }
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) return
        received.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
        ws.send(EMPTY, { binary: true })
      })
    }
    proxy = await startProxy({ upstream })

    const client = await connectClient(proxy, '/chunks/stream', {
      'swarm-postage-batch-id': randomBatchId(),
    })
    const payload = randomBody(32)
    client.ws.send(payload, { binary: true })

    // Eventually the frame lands on the *second* upstream connection and gets acked.
    await waitFor(() => client.binaryFrames.length === 1, 5000)
    expect(received).toHaveLength(1)
    expect(received[0]!.equals(payload)).toBe(true)
    expect(upstreamConns).toBeGreaterThanOrEqual(2)
    await client.close()
  })
})
