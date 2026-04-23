// CLI entry. Parses --listen / --upstream / --cache-db and starts the proxy.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UploadCache } from './cache.js'
import { createProxyServer, type ProxyConfig } from './proxy.js'

const USAGE = `swarm-dev-proxy — forward HTTP proxy for the Bee API

Usage: proxy [options]

Options:
  --listen HOST:PORT     address to listen on (default 127.0.0.1:1733)
  --upstream HOST:PORT   upstream Bee node (default 127.0.0.1:1633)
  --cache-db PATH        sqlite cache for POST /bytes | /chunks | /bzz
                         responses (default <repo>/data/proxy-cache.db,
                         override via FULLCIRCLE_DATA_DIR; set to "off"
                         to disable caching entirely)
  --help, -h             show this message
`

const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data')

const parsed = parseArgs(process.argv.slice(2))
const cache = parsed.cacheDb === 'off' ? undefined : new UploadCache(parsed.cacheDb)
const cfg: ProxyConfig = {
  listenHost: parsed.listenHost,
  listenPort: parsed.listenPort,
  upstreamHost: parsed.upstreamHost,
  upstreamPort: parsed.upstreamPort,
  cache,
}
const server = createProxyServer(cfg)
server.listen(cfg.listenPort, cfg.listenHost, () => {
  const cacheLabel = cache ? parsed.cacheDb : 'disabled'
  process.stderr.write(
    `swarm-dev-proxy listening on http://${cfg.listenHost}:${cfg.listenPort}` +
      ` -> http://${cfg.upstreamHost}:${cfg.upstreamPort} (cache: ${cacheLabel})\n`,
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close()
    cache?.close()
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
  let cacheDb = resolve(process.env.FULLCIRCLE_DATA_DIR ?? DEFAULT_DATA_DIR, 'proxy-cache.db')
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
  return { listenHost, listenPort, upstreamHost, upstreamPort, cacheDb }
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
