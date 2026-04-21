// POT-JS-backed indexing of Ethereum blocks uploaded to Swarm.
//
// Shape mirrors ./swarm.ts (openManifest / addBlocksToManifest / saveManifest)
// but uses three POT key-value stores instead of a single Mantaray manifest:
//
//   byNumber  key = block number (JS number -> 8-byte big-endian IEEE-754)
//             val = 32-byte Swarm reference of the block bundle
//   byHash    key = 32-byte raw block hash
//             val = 32-byte Swarm reference of the block bundle
//   byTx      key = 32-byte raw tx hash
//             val = 32-byte Swarm reference of the block bundle (the block
//                   that contains the tx)
//
// Three KVSs is intentional: keys are capped at 32 bytes in POT, which is
// exactly the size of a hash, so there is no room for a type-prefix byte to
// multiplex block/tx hashes in a single KVS. Each save() yields one 32-byte
// reference; `PotIndexRefs` bundles all three.
//
// Block bundles themselves (RLP([header, body, receipts, td])) are uploaded
// with bee.uploadData() and their reference is stored as the POT value. POT
// values are capped at 100 KiB by default, which is smaller than some block
// bodies, so we do NOT store bundles inside POT.

import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import { encodeBlockBundle } from './bundle.js'

// `PotKvs` comes from ./pot.d.ts, which declares the global `pot` plus a
// small surface of types. Ambient types are auto-picked up by tsconfig's
// `include: ["src/**/*"]`, so no import is needed.
type PotKvs = ReturnType<typeof globalThis.pot.new> extends Promise<infer T> ? T : never

// ---------- One-time POT runtime load ----------

// pot-node.js is CommonJS and attaches `pot` to globalThis on require. The
// auto-init fires if `pot.wasm` is next to pot-node.js — which is the case in
// vendor/pot/.
let readyPromise: Promise<void> | null = null

function loadPotRuntime(): Promise<void> {
  if (readyPromise) return readyPromise
  // Node 18 doesn't expose globalThis.crypto without --experimental-global-webcrypto;
  // pot-node.js throws at top level if it's missing. Safe to set on Node 19+ too.
  if (!(globalThis as { crypto?: unknown }).crypto) {
    ;(globalThis as { crypto?: unknown }).crypto = webcrypto
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const potNodePath = resolve(here, '../vendor/pot/pot-node.js')
  const req = createRequire(import.meta.url)
  req(potNodePath)
  readyPromise = globalThis.pot.ready().then(() => undefined)
  return readyPromise
}

// ---------- Public types ----------

export interface BlockRecord {
  number: string
  hash: string
  totalDifficulty: string | null
  txHashes: string[]
  rawHeader: string
  rawBody: string
  rawReceipts: string
}

export interface PotIndexes {
  byNumber: PotKvs
  byHash: PotKvs
  byTx: PotKvs
}

export interface PotIndexRefs {
  byNumber: string
  byHash: string
  byTx: string
}

export interface AddBlocksResult {
  blocksUploaded: number
  txHashesIndexed: number
}

export interface OpenPotIndexesOptions {
  beeUrl?: string // default: http://localhost:1633
  batchId: string // required postage batch ID
  existingRefs?: PotIndexRefs // extend previously-saved indexes
  onProgress?: (msg: string) => void
}

// ---------- Public functions ----------

/**
 * Convert a 0x-prefixed hex string to Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Stream block records from an ndjson file. Identical shape to the reader in
 * ./swarm.ts — duplicated here only to keep this module self-contained.
 */
export async function* readBlocksNdjson(path: string): AsyncGenerator<BlockRecord> {
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (line.trim()) {
      yield JSON.parse(line) as BlockRecord
    }
  }
}

/**
 * Open three POT KVSs — either fresh, or by loading existing references for
 * in-place extension. Mirrors `openManifest` in ./swarm.ts.
 *
 * Returns handles to use with `addBlocksToPot` and `savePotIndexes`.
 */
export async function openPotIndexes(options: OpenPotIndexesOptions): Promise<PotIndexes> {
  await loadPotRuntime()
  const log = options.onProgress ?? console.log
  const beeUrl = options.beeUrl ?? 'http://localhost:1633'
  const { batchId, existingRefs } = options

  if (existingRefs) {
    log(`loading existing POT indexes...`)
    const [byNumber, byHash, byTx] = await Promise.all([
      globalThis.pot.load(existingRefs.byNumber, beeUrl, batchId),
      globalThis.pot.load(existingRefs.byHash, beeUrl, batchId),
      globalThis.pot.load(existingRefs.byTx, beeUrl, batchId),
    ])
    return { byNumber, byHash, byTx }
  }

  const [byNumber, byHash, byTx] = await Promise.all([
    globalThis.pot.new(beeUrl, batchId),
    globalThis.pot.new(beeUrl, batchId),
    globalThis.pot.new(beeUrl, batchId),
  ])
  return { byNumber, byHash, byTx }
}

/**
 * For every block in a blocks.ndjson file: upload the block bundle via
 * bee.uploadData, then record its reference in all three POT KVSs.
 *
 * The KVSs are NOT saved here — call `savePotIndexes` once per run.
 *
 * Puts within a block are awaited sequentially so the POT runtime (a single
 * Go goroutine tree per KVS) sees them in a well-defined order; per-block
 * parallelism across bundle uploads would be the next obvious win, and is
 * left for a follow-up along with the same optimisation in ./swarm.ts.
 */
export async function addBlocksToPot(
  bee: Bee,
  indexes: PotIndexes,
  blocksPath: string,
  options: { batchId: string; onProgress?: (msg: string) => void },
): Promise<AddBlocksResult> {
  const log = options.onProgress ?? console.log
  let blocksUploaded = 0
  let txHashesIndexed = 0

  for await (const block of readBlocksNdjson(blocksPath)) {
    const bundleBytes = encodeBlockBundle({
      rawHeader: hexToBytes(block.rawHeader),
      rawBody: hexToBytes(block.rawBody),
      rawReceipts: hexToBytes(block.rawReceipts),
      totalDifficulty: block.totalDifficulty === null ? null : BigInt(block.totalDifficulty),
    })
    const uploadResult = await bee.uploadData(options.batchId, bundleBytes)
    const refBytes = hexToBytes(uploadResult.reference)

    const numberKey = Number(block.number)
    if (!Number.isSafeInteger(numberKey)) {
      throw new Error(`block number ${block.number} exceeds Number.MAX_SAFE_INTEGER`)
    }
    await indexes.byNumber.putRaw(numberKey, refBytes)
    await indexes.byHash.putRaw(hexToBytes(block.hash), refBytes)
    for (const txHash of block.txHashes) {
      await indexes.byTx.putRaw(hexToBytes(txHash), refBytes)
      txHashesIndexed++
    }

    blocksUploaded++
    if (blocksUploaded % 100 === 0) {
      log(`uploaded ${blocksUploaded} blocks, ${txHashesIndexed} tx hashes indexed`)
    }
  }

  return { blocksUploaded, txHashesIndexed }
}

/**
 * Save all three KVSs to Swarm and return their root references.
 */
export async function savePotIndexes(indexes: PotIndexes): Promise<PotIndexRefs> {
  const [byNumber, byHash, byTx] = await Promise.all([
    indexes.byNumber.save(),
    indexes.byHash.save(),
    indexes.byTx.save(),
  ])
  return { byNumber, byHash, byTx }
}
