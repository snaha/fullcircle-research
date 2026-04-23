// Browser SQLite client using sql.js-httpvfs for lazy-loading database pages.
//
// Instead of downloading the entire database upfront, this uses HTTP Range
// requests to fetch only the pages SQLite needs for each query. The database
// is hosted as a single blob on Swarm and accessed via `/bytes/{dbRef}`.
//
// Schema (matches packages/era/src/swarm-sqlite.ts):
//   blocks(number INTEGER PRIMARY KEY, hash BLOB, swarm_ref BLOB)
//   transactions(tx_hash BLOB PRIMARY KEY, block_number INTEGER)

import { browser } from '$app/environment'
import { createDbWorker, type WorkerHttpvfs } from 'sql.js-httpvfs'

// Cached worker instances by beeUrl + dbRef
const workerCache = new Map<string, Promise<WorkerHttpvfs>>()

function cacheKey(dbRef: string, beeUrl: string): string {
  return `${beeUrl}\x00${dbRef}`
}

// ---------- Lookup Options ----------

export interface SqliteLookupOptions {
  beeUrl: string
  dbRef: string // Single database blob reference (replaces pageTableRef)
}

// ---------- Worker Management ----------

/**
 * Get or create a sql.js-httpvfs worker for the given database.
 */
async function getWorker(options: SqliteLookupOptions): Promise<WorkerHttpvfs> {
  if (!browser) throw new Error('SQLite runtime is browser-only')

  const key = cacheKey(options.dbRef, options.beeUrl)
  const existing = workerCache.get(key)
  if (existing) return existing

  const promise = createDbWorker(
    [
      {
        from: 'inline',
        config: {
          serverMode: 'full',
          requestChunkSize: 4096,
          url: `${options.beeUrl}/bytes/${options.dbRef}`,
        },
      },
    ],
    '/sql.js-httpvfs/sqlite.worker.js',
    '/sql.js-httpvfs/sql-wasm.wasm',
  )

  workerCache.set(key, promise)

  try {
    return await promise
  } catch (err) {
    workerCache.delete(key)
    throw err
  }
}

// ---------- Hex Utilities ----------

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ---------- Lookup Functions ----------

/**
 * Get swarm_ref for a block by number.
 */
export async function getRefByNumber(
  blockNumber: string,
  options: SqliteLookupOptions,
): Promise<string | null> {
  const worker = await getWorker(options)
  const n = Number(blockNumber)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`invalid block number: ${blockNumber}`)
  }

  const result = (await worker.db.query(
    'SELECT hex(swarm_ref) as ref FROM blocks WHERE number = ?',
    [n],
  )) as Array<{ ref: string }>
  return result.length > 0 ? result[0].ref.toLowerCase() : null
}

/**
 * Get swarm_ref for a block by hash.
 */
export async function getRefByHash(
  blockHash: string,
  options: SqliteLookupOptions,
): Promise<string | null> {
  const worker = await getWorker(options)
  const normalized = blockHash.toLowerCase().startsWith('0x') ? blockHash.slice(2) : blockHash
  if (!/^[0-9a-f]{64}$/.test(normalized.toLowerCase())) {
    throw new Error(`invalid block hash: ${blockHash}`)
  }

  const hashBytes = hexToBytes(normalized)
  const result = (await worker.db.query('SELECT hex(swarm_ref) as ref FROM blocks WHERE hash = ?', [
    hashBytes,
  ])) as Array<{ ref: string }>
  return result.length > 0 ? result[0].ref.toLowerCase() : null
}

/**
 * Get swarm_ref for a block by transaction hash.
 * First looks up block_number from transactions table, then gets swarm_ref from blocks.
 */
export async function getRefByTxHash(
  txHash: string,
  options: SqliteLookupOptions,
): Promise<string | null> {
  const worker = await getWorker(options)
  const normalized = txHash.toLowerCase().startsWith('0x') ? txHash.slice(2) : txHash
  if (!/^[0-9a-f]{64}$/.test(normalized.toLowerCase())) {
    throw new Error(`invalid tx hash: ${txHash}`)
  }

  const hashBytes = hexToBytes(normalized)

  // Look up block number from transactions table
  const txResult = (await worker.db.query(
    'SELECT block_number FROM transactions WHERE tx_hash = ?',
    [hashBytes],
  )) as Array<{ block_number: number }>
  if (txResult.length === 0) {
    return null
  }

  const blockNumber = txResult[0].block_number

  // Get swarm_ref from blocks table
  const blockResult = (await worker.db.query(
    'SELECT hex(swarm_ref) as ref FROM blocks WHERE number = ?',
    [blockNumber],
  )) as Array<{ ref: string }>
  if (blockResult.length === 0) {
    return null
  }

  return blockResult[0].ref.toLowerCase()
}

// ---------- Probe Functions (for existence checks) ----------

/**
 * Check if a block exists by number.
 */
export async function hasBlockByNumber(
  blockNumber: string,
  options: SqliteLookupOptions,
): Promise<boolean> {
  try {
    const ref = await getRefByNumber(blockNumber, options)
    return ref !== null
  } catch {
    return false
  }
}

/**
 * Check if a block exists by hash.
 */
export async function hasBlockByHash(
  blockHash: string,
  options: SqliteLookupOptions,
): Promise<boolean> {
  try {
    const ref = await getRefByHash(blockHash, options)
    return ref !== null
  } catch {
    return false
  }
}

/**
 * Check if a transaction exists by hash.
 */
export async function hasTx(txHash: string, options: SqliteLookupOptions): Promise<boolean> {
  try {
    const ref = await getRefByTxHash(txHash, options)
    return ref !== null
  } catch {
    return false
  }
}
