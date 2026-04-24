// Test harness: spins up a mock upstream Bee (HTTP + WS) and the proxy, both
// on ephemeral ports (port 0) so tests never collide with any real Bee/proxy
// the developer has running. Every test gets a fresh throwaway SQLite cache.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocketServer, type WebSocket } from 'ws'

import { UploadCache } from './cache.js'
import { createProxyServer, type ProxyConfig } from './proxy.js'

export interface UpstreamRequest {
  method: string
  url: string
  headers: NodeJS.Dict<string | string[]>
  body: Buffer
}

export type UpstreamHandler = (req: UpstreamRequest, res: ServerResponse) => void | Promise<void>

export interface UpstreamHandle {
  port: number
  host: string
  requests: UpstreamRequest[]
  close(): Promise<void>
  server: Server
  wss: WebSocketServer
  onUpgrade?: (ws: WebSocket, req: IncomingMessage) => void
}

export async function startUpstream(handler: UpstreamHandler): Promise<UpstreamHandle> {
  const requests: UpstreamRequest[] = []
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const captured: UpstreamRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      }
      requests.push(captured)
      await handler(captured, res)
    })()
  })

  const wss = new WebSocketServer({ noServer: true })
  const handle: UpstreamHandle = {
    port: 0,
    host: '127.0.0.1',
    requests,
    server,
    wss,
    async close() {
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
      })
    },
  }

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handle.onUpgrade?.(ws, req)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  handle.port = (server.address() as AddressInfo).port
  return handle
}

export interface ProxyHandle {
  port: number
  host: string
  cache: UploadCache | undefined
  cacheDbPath: string | undefined
  tmpDir: string | undefined
  close(): Promise<void>
}

export interface StartProxyOpts {
  upstream: UpstreamHandle
  withCache?: boolean
}

export async function startProxy(opts: StartProxyOpts): Promise<ProxyHandle> {
  let cache: UploadCache | undefined
  let cacheDbPath: string | undefined
  let tmpDir: string | undefined
  if (opts.withCache !== false) {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'))
    cacheDbPath = join(tmpDir, 'cache.db')
    cache = new UploadCache(cacheDbPath)
  }
  const cfg: ProxyConfig = {
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: opts.upstream.host,
    upstreamPort: opts.upstream.port,
    cache,
  }
  const server = createProxyServer(cfg)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    host: '127.0.0.1',
    cache,
    cacheDbPath,
    tmpDir,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      cache?.close()
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/**
 * Make a request to the proxy and return a fully-buffered response. Avoids
 * global `fetch` to keep behaviour predictable across Node versions.
 */
export function proxyRequest(
  proxy: ProxyHandle,
  opts: {
    method?: string
    path: string
    headers?: Record<string, string>
    body?: Buffer | string
  },
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const body = typeof opts.body === 'string' ? Buffer.from(opts.body) : opts.body
    const req = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          ...(opts.headers ?? {}),
          ...(body ? { 'content-length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export function randomBatchId(): string {
  return randomBytes(32).toString('hex')
}

export function randomBody(size = 256): Buffer {
  return randomBytes(size)
}
