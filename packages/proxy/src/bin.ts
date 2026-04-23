// CLI entry. Parses --listen / --upstream / --cache-db and starts the proxy.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DownloadCache, UploadCache } from './cache.js'
import { createProxyServer, type ProxyConfig } from './proxy.js'

const USAGE = `swarm-dev-proxy — forward HTTP proxy for the Bee API

Usage: proxy [options]

Options:
  --listen HOST:PORT     address to listen on (default 127.0.0.1:1733)
  --upstream HOST:PORT   upstream Bee node (default 127.0.0.1:1633)
  --cache-db PATH        sqlite cache for POST /bytes | /chunks | /bzz | /soc
                         responses. Default is per-upstream:
                         <data>/proxy-cache-<host>_<port>.db (data dir via
                         FULLCIRCLE_DATA_DIR, else repo-root data/). Set to
                         "off" to disable caching entirely.
  --help, -h             show this message
`

const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data')

const parsed = parseArgs(process.argv.slice(2))
const cacheEnabled = parsed.cacheDb !== 'off'
const cache = cacheEnabled ? new UploadCache(parsed.cacheDb) : undefined
const downloadCacheDb = defaultDownloadCacheDb(parsed.upstreamHost, parsed.upstreamPort)
const downloadCache = cacheEnabled ? new DownloadCache(downloadCacheDb) : undefined
const cfg: ProxyConfig = {
  listenHost: parsed.listenHost,
  listenPort: parsed.listenPort,
  upstreamHost: parsed.upstreamHost,
  upstreamPort: parsed.upstreamPort,
  cache,
  downloadCache,
}
const server = createProxyServer(cfg)
server.listen(cfg.listenPort, cfg.listenHost, () => {
  const uploadLabel = cache ? parsed.cacheDb : 'disabled'
  const downloadLabel = downloadCache ? downloadCacheDb : 'disabled'
  process.stderr.write(
    `swarm-dev-proxy listening on http://${cfg.listenHost}:${cfg.listenPort}` +
      ` -> http://${cfg.upstreamHost}:${cfg.upstreamPort}` +
      ` (upload-cache: ${uploadLabel}, download-cache: ${downloadLabel})\n`,
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close()
    cache?.close()
    downloadCache?.close()
    process.exit(0)
  })
}

interface ParsedArgs {
  listenHost: string
  listenPort: number
  upstreamHost: string
  upstreamPort: number
  cacheDb: string
}

function parseArgs(args: string[]): ParsedArgs {
  let listen = '127.0.0.1:1733'
  let upstream = '127.0.0.1:1633'
  let cacheDb: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (a === '--') continue
    if (a === '--listen') {
      listen = requireValue(args, ++i, '--listen')
    } else if (a === '--upstream') {
      upstream = requireValue(args, ++i, '--upstream')
    } else if (a === '--cache-db') {
      cacheDb = requireValue(args, ++i, '--cache-db')
    } else {
      die(`unknown argument: ${a}`)
    }
  }
  const [listenHost, listenPort] = parseHostPort(listen, '--listen')
  const [upstreamHost, upstreamPort] = parseHostPort(upstream, '--upstream')
  return {
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    cacheDb: cacheDb ?? defaultCacheDb(upstreamHost, upstreamPort),
  }
}

function defaultCacheDb(upstreamHost: string, upstreamPort: number): string {
  const dataDir = process.env.FULLCIRCLE_DATA_DIR ?? DEFAULT_DATA_DIR
  const safeHost = upstreamHost.replace(/[^a-zA-Z0-9.-]/g, '_')
  return resolve(dataDir, `proxy-cache-${safeHost}_${upstreamPort}.db`)
}

function defaultDownloadCacheDb(upstreamHost: string, upstreamPort: number): string {
  const dataDir = process.env.FULLCIRCLE_DATA_DIR ?? DEFAULT_DATA_DIR
  const safeHost = upstreamHost.replace(/[^a-zA-Z0-9.-]/g, '_')
  return resolve(dataDir, `proxy-download-cache-${safeHost}_${upstreamPort}.db`)
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i]
  if (!v) die(`${flag} requires a value`)
  return v
}

function parseHostPort(spec: string, flag: string): [string, number] {
  const colon = spec.lastIndexOf(':')
  if (colon < 0) die(`${flag}: expected HOST:PORT, got ${spec}`)
  const host = spec.slice(0, colon)
  const port = Number(spec.slice(colon + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    die(`${flag}: invalid HOST:PORT ${spec}`)
  }
  return [host, port]
}

function die(msg: string): never {
  process.stderr.write(`swarm-dev-proxy: ${msg}\n\n${USAGE}`)
  process.exit(2)
}
