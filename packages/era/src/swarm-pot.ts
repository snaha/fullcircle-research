// POT-JS-backed indexing of Ethereum blocks uploaded to Swarm.
//
// Shape mirrors ./swarm.ts (openManifest / addBlocksToManifest /
// addBalanceEventsToManifest / saveManifest) but uses five POT key-value
// stores instead of a single Mantaray manifest:
//
//   byNumber        key = block number (JS number -> 8-byte big-endian IEEE-754)
//                   val = 32-byte Swarm reference of the block bundle
//   byHash          key = 32-byte raw block hash
//                   val = 32-byte Swarm reference of the block bundle
//   byTx            key = 32-byte raw tx hash
//                   val = 32-byte Swarm reference of the block bundle (the
//                         block that contains the tx)
//   byAddress       key = 20-byte raw Ethereum address
//                   val = 32-byte Swarm reference of the per-address account
//                         record (balance + event history JSON chunk)
//   byBalanceBlock  key = block number (JS number -> 8-byte big-endian IEEE-754)
//                   val = 32-byte Swarm reference of the per-block
//                         balance-events JSON chunk
//
// Five KVSs is intentional: keys are capped at 32 bytes in POT, which is
// exactly the size of a hash, so there is no room for a type-prefix byte to
// multiplex block/tx/address hashes in a single KVS. Each save() yields one
// 32-byte reference; `PotIndexRefs` bundles all five (plus meta).
//
// Block bundles themselves (RLP([header, body, receipts, td])) are uploaded
// with bee.uploadData() and their reference is stored as the POT value. POT
// values are capped at 100 KiB by default, which is smaller than some block
// bodies, so we do NOT store bundles inside POT. Per-address / per-block
// balance records are JSON chunks uploaded the same way.
//
// A sixth reference — `meta` — is a Swarm data chunk carrying a small JSON
// summary (firstBlock / lastBlock / blockCount / txCount / addressCount /
// eventCount) of what's indexed. Mantaray derives this by walking the tree;
// POT KVSs can't be iterated, so we track counters during addBlocksToPot /
// addBalanceEventsToPot and rely on the caller to load previous stats when
// extending.

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
  // pot-node.js reads `global.potVerbosity` at init and defaults to a chatty
  // level that prints slot/loader lines for every KVS operation. Mute it
  // before require so the CLI output stays useful; override with
  // FULLCIRCLE_POT_VERBOSITY when debugging the runtime.
  const verbosity = process.env.FULLCIRCLE_POT_VERBOSITY
  ;(globalThis as { potVerbosity?: number }).potVerbosity = verbosity ? Number(verbosity) : 0
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

export interface PotMeta {
  firstBlock: string
  lastBlock: string
  blockCount: string
  txCount: string
  /** Total balance events indexed. "0" when the POT carries no state. */
  eventCount: string
  /**
   * Addresses that have had an account record written. Cumulative across
   * upload runs — can overcount when the same address appears in multiple
   * runs, since we don't dedupe against previously-uploaded addresses.
   */
  addressCount: string
}

interface PotStats {
  firstBlock: bigint | null
  lastBlock: bigint | null
  blockCount: bigint
  txCount: bigint
  addressCount: bigint
  eventCount: bigint
}

export interface PotIndexes {
  byNumber: PotKvs
  byHash: PotKvs
  byTx: PotKvs
  /** Keyed by 20-byte raw address → per-address account-record ref. */
  byAddress: PotKvs
  /** Keyed by block number (JS number) → per-block balance-events record ref. */
  byBalanceBlock: PotKvs
  // Mutable counters, updated by addBlocksToPot / addBalanceEventsToPot and
  // serialised by writePotBlockRangeMeta. Seeded from an existing meta chunk
  // when extending.
  stats: PotStats
  // Swarm reference of the last-written meta chunk. Set by
  // writePotBlockRangeMeta; read by savePotIndexes.
  metaRef: string | null
}

export interface PotIndexRefs {
  byNumber: string
  byHash: string
  byTx: string
  /**
   * Null on envelopes produced before state indexing was added, or when the
   * caller opted out of state upload. A saved KVS ref is always a valid
   * non-null string — even an empty KVS saves to a real ref.
   */
  byAddress: string | null
  byBalanceBlock: string | null
  meta: string | null
}

export interface AddBlocksResult {
  blocksUploaded: number
  txHashesIndexed: number
}

export interface AddBalanceEventsResult {
  addressCount: number
  blockCount: number
  eventCount: number
}

export interface OpenPotIndexesOptions {
  bee: Bee // for meta chunk download when extending
  beeUrl?: string // default: http://localhost:1633 — passed to POT runtime
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
 * Open five POT KVSs — either fresh, or by loading existing references for
 * in-place extension. Mirrors `openManifest` in ./swarm.ts.
 *
 * When extending, also fetches the previous meta chunk (if any) and seeds
 * the running stats so `writePotBlockRangeMeta` emits the cumulative totals.
 *
 * `byAddress` / `byBalanceBlock` are created fresh when the supplied
 * `existingRefs` lack them (envelopes produced before state indexing was
 * added) — those runs just won't have prior per-address history to extend.
 */
export async function openPotIndexes(options: OpenPotIndexesOptions): Promise<PotIndexes> {
  await loadPotRuntime()
  const log = options.onProgress ?? console.log
  const beeUrl = options.beeUrl ?? 'http://localhost:1633'
  const { bee, batchId, existingRefs } = options

  if (existingRefs) {
    log(`loading existing POT indexes...`)
    const loadOrNew = (ref: string | null): Promise<PotKvs> =>
      ref ? globalThis.pot.load(ref, beeUrl, batchId) : globalThis.pot.new(beeUrl, batchId)
    const [byNumber, byHash, byTx, byAddress, byBalanceBlock, stats] = await Promise.all([
      globalThis.pot.load(existingRefs.byNumber, beeUrl, batchId),
      globalThis.pot.load(existingRefs.byHash, beeUrl, batchId),
      globalThis.pot.load(existingRefs.byTx, beeUrl, batchId),
      loadOrNew(existingRefs.byAddress),
      loadOrNew(existingRefs.byBalanceBlock),
      loadMetaStats(bee, existingRefs.meta),
    ])
    return {
      byNumber,
      byHash,
      byTx,
      byAddress,
      byBalanceBlock,
      stats,
      metaRef: existingRefs.meta,
    }
  }

  const [byNumber, byHash, byTx, byAddress, byBalanceBlock] = await Promise.all([
    globalThis.pot.new(beeUrl, batchId),
    globalThis.pot.new(beeUrl, batchId),
    globalThis.pot.new(beeUrl, batchId),
    globalThis.pot.new(beeUrl, batchId),
    globalThis.pot.new(beeUrl, batchId),
  ])
  return {
    byNumber,
    byHash,
    byTx,
    byAddress,
    byBalanceBlock,
    stats: {
      firstBlock: null,
      lastBlock: null,
      blockCount: 0n,
      txCount: 0n,
      addressCount: 0n,
      eventCount: 0n,
    },
    metaRef: null,
  }
}

/**
 * For every block in a blocks.ndjson file: upload the block bundle via
 * bee.uploadData, then record its reference in all three POT KVSs and update
 * the running stats (min/max block number, block/tx counters).
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
    const refBytes = uploadResult.reference.toUint8Array()

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

    const blockNumber = BigInt(block.number)
    const stats = indexes.stats
    if (stats.firstBlock === null || blockNumber < stats.firstBlock) stats.firstBlock = blockNumber
    if (stats.lastBlock === null || blockNumber > stats.lastBlock) stats.lastBlock = blockNumber
    stats.blockCount += 1n
    stats.txCount += BigInt(block.txHashes.length)

    blocksUploaded++
    if (blocksUploaded % 100 === 0) {
      log(`uploaded ${blocksUploaded} blocks, ${txHashesIndexed} tx hashes indexed`)
    }
  }

  return { blocksUploaded, txHashesIndexed }
}

/**
 * Snapshot of the running stats as a `PotMeta`. Null when nothing has been
 * indexed yet (no blocks AND no state events). Pure read — does not touch
 * Swarm.
 */
export function getPotBlockRange(indexes: PotIndexes): PotMeta | null {
  const { firstBlock, lastBlock, blockCount, txCount, addressCount, eventCount } = indexes.stats
  const hasBlocks = firstBlock !== null && lastBlock !== null && blockCount > 0n
  const hasState = eventCount > 0n
  if (!hasBlocks && !hasState) return null
  return {
    firstBlock: firstBlock !== null ? firstBlock.toString() : '0',
    lastBlock: lastBlock !== null ? lastBlock.toString() : '0',
    blockCount: blockCount.toString(),
    txCount: txCount.toString(),
    eventCount: eventCount.toString(),
    addressCount: addressCount.toString(),
  }
}

/**
 * Serialise current stats as JSON, upload the chunk to Swarm, and stash its
 * reference on `indexes.metaRef` so `savePotIndexes` includes it in the
 * returned `PotIndexRefs`. Mirrors `writeBlockRangeMeta` in ./swarm.ts.
 */
export async function writePotBlockRangeMeta(
  bee: Bee,
  indexes: PotIndexes,
  options: { batchId: string; onProgress?: (msg: string) => void },
): Promise<PotMeta | null> {
  const log = options.onProgress ?? console.log
  const meta = getPotBlockRange(indexes)
  if (!meta) {
    log('no indexed blocks — skipping meta')
    return null
  }
  const metaBytes = textEncoder.encode(JSON.stringify(meta))
  const { reference } = await bee.uploadData(options.batchId, metaBytes)
  indexes.metaRef = reference.toHex()
  log(
    `meta: firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock}` +
      ` blockCount=${meta.blockCount} txCount=${meta.txCount}` +
      ` addressCount=${meta.addressCount} eventCount=${meta.eventCount}`,
  )
  return meta
}

/**
 * Save all five KVSs to Swarm and return their root references together
 * with the last-written meta reference (null if `writePotBlockRangeMeta`
 * wasn't called this run).
 */
export async function savePotIndexes(indexes: PotIndexes): Promise<PotIndexRefs> {
  const [byNumber, byHash, byTx, byAddress, byBalanceBlock] = await Promise.all([
    indexes.byNumber.save(),
    indexes.byHash.save(),
    indexes.byTx.save(),
    indexes.byAddress.save(),
    indexes.byBalanceBlock.save(),
  ])
  return {
    byNumber,
    byHash,
    byTx,
    byAddress,
    byBalanceBlock,
    meta: indexes.metaRef,
  }
}

// ---------- Balance-events indexing ----------

interface BalanceEvent {
  block: string
  addr: string
  pre: string
  post: string
}

interface AccountRecord {
  addr: string
  balance: string
  eventCount: number
  events: { block: string; pre: string; post: string }[]
}

interface BlockEventsRecord {
  block: string
  events: { addr: string; pre: string; post: string }[]
}

async function* readBalanceEventsNdjson(path: string): AsyncGenerator<BalanceEvent> {
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as BalanceEvent
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let nextIndex = 0
  let done = 0
  const total = items.length

  const runOne = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= total) return
      await worker(items[i], i)
      done++
      if (onProgress && done % 500 === 0) onProgress(done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runOne))
  if (onProgress) onProgress(done, total)
}

/**
 * Aggregate balance-mutation events from one or more NDJSON files and add
 * them to the POT `byAddress` / `byBalanceBlock` KVSs. Mirrors
 * `addBalanceEventsToManifest` in ./swarm.ts — events are accumulated in
 * memory across all input files first so per-address history spans every
 * era in the run.
 *
 * Per address, uploads one `AccountRecord` JSON chunk with the final
 * balance and the full event log (block-ordered); the ref goes under the
 * 20-byte raw address key in `byAddress`. Per block, uploads one
 * `BlockEventsRecord` JSON chunk; the ref goes under the block number in
 * `byBalanceBlock`.
 *
 * Overwrite semantics: POT `putRaw` replaces any prior value for the same
 * key, so re-indexing an address replaces its previous account record
 * (previous chunk is orphaned). Upload all eras in one run to keep
 * per-address history coherent.
 *
 * Bundle uploads run concurrently (`options.concurrency`, default 32) but
 * the POT `putRaw` calls for each record are awaited sequentially within
 * the worker so the KVS goroutine tree sees puts in a well-defined order.
 */
export async function addBalanceEventsToPot(
  bee: Bee,
  indexes: PotIndexes,
  eventsPaths: string[],
  options: {
    batchId: string
    onProgress?: (msg: string) => void
    concurrency?: number
  },
): Promise<AddBalanceEventsResult> {
  const log = options.onProgress ?? console.log
  const concurrency = options.concurrency ?? 32

  const byAddr = new Map<string, { block: string; pre: string; post: string }[]>()
  const byBlock = new Map<string, { addr: string; pre: string; post: string }[]>()
  let eventCount = 0

  for (const path of eventsPaths) {
    log(`reading ${path}`)
    let perFile = 0
    for await (const ev of readBalanceEventsNdjson(path)) {
      const addrEntry = byAddr.get(ev.addr)
      if (addrEntry === undefined) {
        byAddr.set(ev.addr, [{ block: ev.block, pre: ev.pre, post: ev.post }])
      } else {
        addrEntry.push({ block: ev.block, pre: ev.pre, post: ev.post })
      }
      const blockEntry = byBlock.get(ev.block)
      if (blockEntry === undefined) {
        byBlock.set(ev.block, [{ addr: ev.addr, pre: ev.pre, post: ev.post }])
      } else {
        blockEntry.push({ addr: ev.addr, pre: ev.pre, post: ev.post })
      }
      eventCount++
      perFile++
    }
    log(`  ${perFile} events from ${path}`)
  }

  if (eventCount === 0) {
    log('no balance events — skipping state upload')
    return { addressCount: 0, blockCount: 0, eventCount: 0 }
  }

  log(`aggregated ${eventCount} events across ${byAddr.size} addresses and ${byBlock.size} blocks`)

  const accountEntries = [...byAddr.entries()]
  log(`uploading ${accountEntries.length} account records...`)
  await runWithConcurrency(
    accountEntries,
    concurrency,
    async ([addr, events]) => {
      events.sort((a, b) => {
        const da = BigInt(a.block) - BigInt(b.block)
        return da < 0n ? -1 : da > 0n ? 1 : 0
      })
      const record: AccountRecord = {
        addr,
        balance: events[events.length - 1].post,
        eventCount: events.length,
        events,
      }
      const bytes = textEncoder.encode(JSON.stringify(record))
      const { reference } = await bee.uploadData(options.batchId, bytes)
      const refBytes = reference.toUint8Array()
      await indexes.byAddress.putRaw(hexToBytes(addr), refBytes)
    },
    (done, total) => log(`  accounts ${done}/${total}`),
  )

  const blockEntries = [...byBlock.entries()]
  log(`uploading ${blockEntries.length} per-block event records...`)
  await runWithConcurrency(
    blockEntries,
    concurrency,
    async ([blockStr, events]) => {
      events.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
      const record: BlockEventsRecord = { block: blockStr, events }
      const bytes = textEncoder.encode(JSON.stringify(record))
      const { reference } = await bee.uploadData(options.batchId, bytes)
      const refBytes = reference.toUint8Array()
      const numberKey = Number(blockStr)
      if (!Number.isSafeInteger(numberKey)) {
        throw new Error(`block number ${blockStr} exceeds Number.MAX_SAFE_INTEGER`)
      }
      await indexes.byBalanceBlock.putRaw(numberKey, refBytes)
    },
    (done, total) => log(`  blocks ${done}/${total}`),
  )

  indexes.stats.addressCount += BigInt(byAddr.size)
  indexes.stats.eventCount += BigInt(eventCount)

  return { addressCount: byAddr.size, blockCount: byBlock.size, eventCount }
}

// ---------- Internal helpers ----------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

async function loadMetaStats(bee: Bee, metaRef: string | null): Promise<PotStats> {
  const empty: PotStats = {
    firstBlock: null,
    lastBlock: null,
    blockCount: 0n,
    txCount: 0n,
    addressCount: 0n,
    eventCount: 0n,
  }
  if (!metaRef) return empty
  const bytes = (await bee.downloadData(metaRef)).toUint8Array()
  const parsed = JSON.parse(textDecoder.decode(bytes)) as Partial<PotMeta>
  return {
    firstBlock: parsed.firstBlock !== undefined ? BigInt(parsed.firstBlock) : null,
    lastBlock: parsed.lastBlock !== undefined ? BigInt(parsed.lastBlock) : null,
    blockCount: parsed.blockCount !== undefined ? BigInt(parsed.blockCount) : 0n,
    txCount: parsed.txCount !== undefined ? BigInt(parsed.txCount) : 0n,
    addressCount: parsed.addressCount !== undefined ? BigInt(parsed.addressCount) : 0n,
    eventCount: parsed.eventCount !== undefined ? BigInt(parsed.eventCount) : 0n,
  }
}
