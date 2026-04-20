// CLI entry point. Boots the HTTP server on FULLCIRCLE_RPC_PORT (default 8545)
// and loads eras from FULLCIRCLE_DATA_DIR (default: repo-root data/).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRpcServer } from './server.js'
import { DataStore } from './store.js'

const DEFAULT_DATA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../data',
)

const dataDir = process.env.FULLCIRCLE_DATA_DIR ?? DEFAULT_DATA_DIR
const port = Number(process.env.FULLCIRCLE_RPC_PORT ?? 8545)
const host = process.env.FULLCIRCLE_RPC_HOST ?? '127.0.0.1'

const started = Date.now()
const store = new DataStore(dataDir)
await store.load()
const eraCount = store.loadedEras.length
const latest = store.latestBlockNumber
console.log(
  `loaded ${eraCount} era(s) from ${dataDir} in ${Date.now() - started} ms (latest block ${latest})`,
)

const server = createRpcServer({ store })
server.listen(port, host, () => {
  console.log(`fullcircle-rpc listening on http://${host}:${port}`)
})
