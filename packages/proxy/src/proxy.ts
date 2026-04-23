// Transparent HTTP forward proxy for the Bee API.
//
// Non-cacheable requests (GETs, non-upload POSTs) stream bodies end-to-end.
// Cacheable requests (POST /bytes | /chunks | /bzz | /soc with a postage
// batch header) are buffered: the request body is SHA-256'd and looked up
// in an on-disk SQLite cache keyed by (body hash, batch id, path). A hit
// returns the stored 2xx response without touching the upstream; a miss
// forwards, buffers the response, and stores it on 2xx.
//
// On connection-level upstream failures during the cacheable path
// (ETIMEDOUT, ECONNRESET, etc.), the proxy retries with exponential
// backoff instead of surfacing a 502 — the whole point of sitting in front
// of a flaky mainnet node is that the client doesn't have to care.

import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'

import { UploadCache, type CachedResponse } from './cache.js'
import { handleWsUpgrade } from './ws-proxy.js'

const MAX_BUFFERED_BYTES = 64 * 1024 * 1024 // 64 MiB — bodies above this bypass cache

// Content-addressed POST endpoints: identical (body, batch) → identical
// response every time. We skip /feeds (mutable updates), /stamps (creates
// state), /chunks/stream (GET + WebSocket upgrade, not POST).
const CACHEABLE_PATH_PREFIXES = ['/bytes', '/chunks', '/bzz', '/soc']

const MAX_ATTEMPTS = 5
const BASE_RETRY_DELAY_MS = 200

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTCONN',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
])

export interface ProxyConfig {
  listenHost: string
  listenPort: number
  upstreamHost: string
  upstreamPort: number
  cache?: UploadCache
}

export interface StampStats {
  uploads: number
  bytes: number
}

export function createProxyServer(cfg: ProxyConfig): Server {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 })
  const stamps = new Map<string, StampStats>()

  const server = http.createServer((clientReq, clientRes) => {
    const startedNs = process.hrtime.bigint()
    const batchId = headerOne(clientReq.headers['swarm-postage-batch-id'])
    const basePath = pathRoot(clientReq.url ?? '')

    if (cfg.cache && clientReq.method === 'POST' && batchId && isCacheable(basePath)) {
      void handleCacheable(cfg, agent, stamps, cfg.cache, clientReq, clientRes, {
        startedNs,
        batchId,
        basePath,
      })
    } else {
      handleStream(cfg, agent, stamps, clientReq, clientRes, startedNs)
    }
  })

  // WebSocket upgrades: Bee's /chunks/stream. Cached + reconnecting proxy.
  server.on('upgrade', (req, socket, head) => {
    handleWsUpgrade(req, socket, head, cfg, stamps)
  })

  return server
}

function handleStream(
  cfg: ProxyConfig,
  agent: http.Agent,
  stamps: Map<string, StampStats>,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  startedNs: bigint,
): void {
  let reqBytes = 0
  let respBytes = 0

  clientReq.on('data', (chunk: Buffer) => {
    reqBytes += chunk.length
  })

  const upstreamReq = http.request(
    {
      host: cfg.upstreamHost,
      port: cfg.upstreamPort,
      method: clientReq.method,
      path: clientReq.url,
      headers: forwardHeaders(clientReq.headers, cfg),
      agent,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.on('data', (chunk: Buffer) => {
        respBytes += chunk.length
      })
      upstreamRes.pipe(clientRes)
      upstreamRes.on('end', () => {
        logRequest(clientReq, upstreamRes.statusCode ?? 0, elapsedMs(startedNs), {
          reqBytes,
          respBytes,
          stamps,
          cacheTag: null,
        })
      })
    },
  )

  upstreamReq.on('error', (err) => {
    failUpstream(clientRes, err)
    process.stderr.write(
      `${clientReq.method} ${clientReq.url} -> ERR ${err.message} (${elapsedMs(startedNs)}ms)\n`,
    )
  })

  clientReq.pipe(upstreamReq)
}

interface CacheableCtx {
  startedNs: bigint
  batchId: string
  basePath: string
}

async function handleCacheable(
  cfg: ProxyConfig,
  agent: http.Agent,
  stamps: Map<string, StampStats>,
  cache: UploadCache,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  ctx: CacheableCtx,
): Promise<void> {
  try {
    const body = await readBody(clientReq, MAX_BUFFERED_BYTES)
    if (body === null) {
      // Oversized — fall back to streaming, skipping cache entirely.
      handleStream(cfg, agent, stamps, clientReq, clientRes, ctx.startedNs)
      return
    }
    const hash = UploadCache.hashBody(body)
    const cached = cache.lookup(hash, ctx.batchId, ctx.basePath)
    if (cached) {
      writeCached(clientRes, cached)
      logRequest(clientReq, cached.status, elapsedMs(ctx.startedNs), {
        reqBytes: body.length,
        respBytes: cached.body.length,
        stamps,
        cacheTag: 'cache=hit',
      })
      return
    }
    await forwardAndStore(cfg, agent, stamps, cache, clientReq, clientRes, body, hash, ctx)
  } catch (err) {
    const e = err as Error
    failUpstream(clientRes, e)
    process.stderr.write(
      `${clientReq.method} ${clientReq.url} -> ERR ${e.message} (${elapsedMs(ctx.startedNs)}ms)\n`,
    )
  }
}

interface UpstreamResult {
  status: number
  filteredHeaders: Record<string, string>
  body: Buffer
}

async function forwardAndStore(
  cfg: ProxyConfig,
  agent: http.Agent,
  stamps: Map<string, StampStats>,
  cache: UploadCache,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  body: Buffer,
  hash: Buffer,
  ctx: CacheableCtx,
): Promise<void> {
  const headers = forwardHeaders(clientReq.headers, cfg)
  headers['content-length'] = body.length
  const requestLabel = `${clientReq.method} ${clientReq.url}`

  const result = await sendUpstreamWithRetry(
    cfg,
    agent,
    clientReq.method ?? 'POST',
    clientReq.url ?? '',
    headers,
    body,
    requestLabel,
  )

  clientRes.writeHead(result.status, {
    ...result.filteredHeaders,
    'content-length': result.body.length,
  })
  clientRes.end(result.body)

  const isSuccess = result.status >= 200 && result.status < 300
  if (isSuccess) {
    cache.store(hash, ctx.batchId, ctx.basePath, {
      status: result.status,
      headers: result.filteredHeaders,
      body: result.body,
    })
  }
  logRequest(clientReq, result.status, elapsedMs(ctx.startedNs), {
    reqBytes: body.length,
    respBytes: result.body.length,
    stamps,
    cacheTag: isSuccess ? 'cache=miss' : 'cache=skip',
  })
}

async function sendUpstreamWithRetry(
  cfg: ProxyConfig,
  agent: http.Agent,
  method: string,
  path: string,
  headers: OutgoingHttpHeaders,
  body: Buffer,
  requestLabel: string,
): Promise<UpstreamResult> {
  let attempt = 0
  for (;;) {
    attempt++
    try {
      return await sendUpstreamOnce(cfg, agent, method, path, headers, body)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (attempt >= MAX_ATTEMPTS || !isRetryable(e)) throw err
      const delay = backoffDelay(attempt)
      const tag = e.code ?? e.message
      process.stderr.write(
        `${requestLabel} -> retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms (${tag})\n`,
      )
      await sleep(delay)
    }
  }
}

function sendUpstreamOnce(
  cfg: ProxyConfig,
  agent: http.Agent,
  method: string,
  path: string,
  headers: OutgoingHttpHeaders,
  body: Buffer,
): Promise<UpstreamResult> {
  return new Promise<UpstreamResult>((resolve, reject) => {
    const upstreamReq = http.request(
      {
        host: cfg.upstreamHost,
        port: cfg.upstreamPort,
        method,
        path,
        headers,
        agent,
      },
      (upstreamRes) => {
        const chunks: Buffer[] = []
        upstreamRes.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        upstreamRes.on('end', () => {
          resolve({
            status: upstreamRes.statusCode ?? 502,
            filteredHeaders: UploadCache.filterHeaders(upstreamRes.headers),
            body: Buffer.concat(chunks),
          })
        })
        upstreamRes.on('error', reject)
      },
    )
    upstreamReq.on('error', reject)
    upstreamReq.end(body)
  })
}

function isRetryable(err: NodeJS.ErrnoException): boolean {
  if (err.code && RETRYABLE_CODES.has(err.code)) return true
  return err.message === 'socket hang up'
}

function backoffDelay(attempt: number): number {
  const base = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
  const jitter = Math.floor(Math.random() * base * 0.25)
  return base + jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeCached(clientRes: ServerResponse, cached: CachedResponse): void {
  const headers: OutgoingHttpHeaders = { ...cached.headers, 'content-length': cached.body.length }
  clientRes.writeHead(cached.status, headers)
  clientRes.end(cached.body)
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > max) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}

function forwardHeaders(
  raw: NodeJS.Dict<string | string[]>,
  cfg: ProxyConfig,
): OutgoingHttpHeaders {
  return { ...raw, host: `${cfg.upstreamHost}:${cfg.upstreamPort}` }
}

function failUpstream(clientRes: ServerResponse, err: Error): void {
  if (!clientRes.headersSent) {
    clientRes.writeHead(502, { 'content-type': 'text/plain' })
    clientRes.end(`proxy error: ${err.message}\n`)
  } else {
    clientRes.end()
  }
}

function pathRoot(url: string): string {
  const q = url.indexOf('?')
  return q < 0 ? url : url.slice(0, q)
}

function isCacheable(path: string): boolean {
  return CACHEABLE_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))
}

function headerOne(h: string | string[] | undefined): string | null {
  if (!h) return null
  return Array.isArray(h) ? (h[0] ?? null) : h
}

function elapsedMs(startedNs: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - startedNs) / 1e6)
}

interface LogMeta {
  reqBytes: number
  respBytes: number
  stamps: Map<string, StampStats>
  cacheTag: string | null
}

function logRequest(req: IncomingMessage, status: number, ms: number, meta: LogMeta): void {
  const { reqBytes, respBytes, stamps, cacheTag } = meta
  let line = `${req.method} ${req.url} -> ${status} (${ms}ms req=${reqBytes}B resp=${respBytes}B)`
  const stampId = headerOne(req.headers['swarm-postage-batch-id'])
  if (stampId && reqBytes > 0) {
    const short = stampId.slice(0, 8)
    const stats = stamps.get(short) ?? { uploads: 0, bytes: 0 }
    stats.uploads += 1
    stats.bytes += reqBytes
    stamps.set(short, stats)
    line += ` stamp=${short} #${stats.uploads} up=${reqBytes}B total_up=${stats.bytes}B`
  }
  if (cacheTag) line += ` ${cacheTag}`
  process.stderr.write(line + '\n')
}
