// Transparent HTTP forward proxy for the Bee API.
//
// Non-cacheable requests (GETs, non-upload POSTs) stream bodies end-to-end.
// Cacheable requests (POST /bytes | /chunks | /bzz with a postage batch
// header) are buffered: the request body is SHA-256'd and looked up in an
// on-disk SQLite cache keyed by (body hash, batch id, path). A hit returns
// the stored 2xx response without touching the upstream; a miss forwards,
// buffers the response, and stores it on 2xx.

import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'

import { UploadCache, type CachedResponse } from './cache.js'

const MAX_BUFFERED_BYTES = 64 * 1024 * 1024 // 64 MiB — bodies above this bypass cache

const CACHEABLE_PATH_PREFIXES = ['/bytes', '/chunks', '/bzz']

export interface ProxyConfig {
  listenHost: string
  listenPort: number
  upstreamHost: string
  upstreamPort: number
  cache?: UploadCache
}

interface StampStats {
  uploads: number
  bytes: number
}

export function createProxyServer(cfg: ProxyConfig): Server {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 })
  const stamps = new Map<string, StampStats>()

  return http.createServer((clientReq, clientRes) => {
    const startedNs = process.hrtime.bigint()
    const batchId = headerOne(clientReq.headers['swarm-postage-batch-id'])
    const basePath = pathRoot(clientReq.url ?? '')

    if (cfg.cache && clientReq.method === 'POST' && batchId && isCacheable(basePath)) {
      handleCacheable(cfg, agent, stamps, cfg.cache, clientReq, clientRes, {
        startedNs,
        batchId,
        basePath,
      })
    } else {
      handleStream(cfg, agent, stamps, clientReq, clientRes, startedNs)
    }
  })
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

function handleCacheable(
  cfg: ProxyConfig,
  agent: http.Agent,
  stamps: Map<string, StampStats>,
  cache: UploadCache,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  ctx: CacheableCtx,
): void {
  readBody(clientReq, MAX_BUFFERED_BYTES)
    .then((body) => {
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
      forwardAndStore(cfg, agent, stamps, cache, clientReq, clientRes, body, hash, ctx)
    })
    .catch((err: Error) => {
      failUpstream(clientRes, err)
      process.stderr.write(
        `${clientReq.method} ${clientReq.url} -> ERR ${err.message} (${elapsedMs(ctx.startedNs)}ms)\n`,
      )
    })
}

function forwardAndStore(
  cfg: ProxyConfig,
  agent: http.Agent,
  stamps: Map<string, StampStats>,
  cache: UploadCache,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  body: Buffer,
  hash: Buffer,
  ctx: CacheableCtx,
): void {
  const headers = forwardHeaders(clientReq.headers, cfg)
  headers['content-length'] = body.length

  const upstreamReq = http.request(
    {
      host: cfg.upstreamHost,
      port: cfg.upstreamPort,
      method: clientReq.method,
      path: clientReq.url,
      headers,
      agent,
    },
    (upstreamRes) => {
      const chunks: Buffer[] = []
      upstreamRes.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      upstreamRes.on('end', () => {
        const respBody = Buffer.concat(chunks)
        const status = upstreamRes.statusCode ?? 502
        const filteredHeaders = UploadCache.filterHeaders(upstreamRes.headers)
        clientRes.writeHead(status, { ...filteredHeaders, 'content-length': respBody.length })
        clientRes.end(respBody)
        if (status >= 200 && status < 300) {
          cache.store(hash, ctx.batchId, ctx.basePath, {
            status,
            headers: filteredHeaders,
            body: respBody,
          })
        }
        logRequest(clientReq, status, elapsedMs(ctx.startedNs), {
          reqBytes: body.length,
          respBytes: respBody.length,
          stamps,
          cacheTag: status >= 200 && status < 300 ? 'cache=miss' : 'cache=skip',
        })
      })
    },
  )

  upstreamReq.on('error', (err) => {
    failUpstream(clientRes, err)
    process.stderr.write(
      `${clientReq.method} ${clientReq.url} -> ERR ${err.message} (${elapsedMs(ctx.startedNs)}ms)\n`,
    )
  })

  upstreamReq.end(body)
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
