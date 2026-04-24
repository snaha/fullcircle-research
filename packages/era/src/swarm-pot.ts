// POT-JS-backed indexing of Ethereum blocks uploaded to Swarm.
//
// Shape mirrors ./swarm.ts (openManifest / addBlocksToManifest / saveManifest)
// but uses five POT key-value stores instead of a single Mantaray manifest:
//
//   byNumber       key = block number (JS number -> 8-byte big-endian IEEE-754)
//                  val = 32-byte Swarm reference of the block bundle
//   byHash         key = 32-byte raw block hash
//                  val = 32-byte Swarm reference of the block bundle
//   byTx           key = 32-byte raw tx hash
//                  val = 32-byte Swarm reference of the block bundle (the block
//                        that contains the tx)
//   byAddress      key = 20-byte raw address
//                  val = 32-byte Swarm reference of the AccountRecord JSON
//   byBalanceBlock key = block number (JS number -> 8-byte big-endian IEEE-754)
//                  val = 32-byte Swarm reference of the BlockEventsRecord JSON
//
// Five KVSs is intentional: keys are capped at 32 bytes in POT, which is
// exactly the size of a hash, so there is no room for a type-prefix byte to
// multiplex block/tx hashes in a single KVS. Each save() yields one 32-byte
// reference; `PotIndexRefs` bundles all five.
//
// Block bundles themselves (RLP([header, body, receipts, td])) are uploaded
// with bee.uploadData() and their reference is stored as the POT value. POT
// values are capped at 100 KiB by default, which is smaller than some block
// bodies, so we do NOT store bundles inside POT.
//
// A fourth reference — `meta` — is a Swarm data chunk carrying a small JSON
// summary (firstBlock / lastBlock / blockCount / txCount) of what's indexed.
// Mantaray derives this by walking the tree; POT KVSs can't be iterated, so
// we track counters during `addBlocksToPot` and rely on the caller to load
// previous stats when extending.

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import { installPotCompat } from '@fullcircle/pot'
import { encodeBlockBundle } from './bundle.js'

// `PotKvs` comes from ./pot.d.ts, which declares the global `pot` plus a
// small surface of types. Ambient types are auto-picked up by tsconfig's
// `include: ["src/**/*"]`, so no import is needed.
type PotKvs = ReturnType<typeof globalThis.pot.new> extends Promise<infer T> ? T : never

// ---------- One-time POT runtime load ----------

let readyPromise: Promise<void> | null = null

function loadPotRuntime(): Promise<void> {
  if (readyPromise) return readyPromise
  installPotCompat()
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
  /** Total balance events uploaded. 0 when the POT set carries no state. */
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
  byAddress: PotKvs
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
  byAddress: string
  byBalanceBlock: string
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
 * Open three POT KVSs — either fresh, or by loading existing references for
 * in-place extension. Mirrors `openManifest` in ./swarm.ts.
 *
 * When extending, also fetches the previous meta chunk (if any) and seeds
 * the running stats so `writePotBlockRangeMeta` emits the cumulative totals.
 */
export async function openPotIndexes(options: OpenPotIndexesOptions): Promise<PotIndexes> {
  await loadPotRuntime()
  const log = options.onProgress ?? console.log
  const beeUrl = options.beeUrl ?? 'http://localhost:1633'
  const { bee, batchId, existingRefs } = options

  if (existingRefs) {
    log(`loading existing POT indexes...`)
    const [byNumber, byHash, byTx, byAddress, byBalanceBlock, stats] = await Promise.all([
      globalThis.pot.load(existingRefs.byNumber, beeUrl, batchId),
      globalThis.pot.load(existingRefs.byHash, beeUrl, batchId),
      globalThis.pot.load(existingRefs.byTx, beeUrl, batchId),
      existingRefs.byAddress
        ? globalThis.pot.load(existingRefs.byAddress, beeUrl, batchId)
        : globalThis.pot.new(beeUrl, batchId),
      existingRefs.byBalanceBlock
        ? globalThis.pot.load(existingRefs.byBalanceBlock, beeUrl, batchId)
        : globalThis.pot.new(beeUrl, batchId),
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
    stats: emptyStats(),
    metaRef: null,
  }
}

function emptyStats(): PotStats {
  return {
    firstBlock: null,
    lastBlock: null,
    blockCount: 0n,
    txCount: 0n,
    addressCount: 0n,
    eventCount: 0n,
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

  const startedAt = Date.now()
  let windowStartAt = startedAt
  let windowStartBlocks = 0
  let windowStartTxs = 0

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
      const now = Date.now()
      const windowMs = Math.max(1, now - windowStartAt)
      const windowBlocks = blocksUploaded - windowStartBlocks
      const windowTxs = txHashesIndexed - windowStartTxs
      const totalMs = Math.max(1, now - startedAt)
      log(
        `uploaded ${blocksUploaded} blocks, ${txHashesIndexed} txs` +
          ` (window ${windowBlocks} blk / ${windowTxs} tx in ${windowMs} ms,` +
          ` ${((windowBlocks / windowMs) * 1000).toFixed(1)} blk/s,` +
          ` ${((windowTxs / windowMs) * 1000).toFixed(0)} tx/s;` +
          ` avg ${((blocksUploaded / totalMs) * 1000).toFixed(1)} blk/s)`,
      )
      windowStartAt = now
      windowStartBlocks = blocksUploaded
      windowStartTxs = txHashesIndexed
    }
  }

  return { blocksUploaded, txHashesIndexed }
}

/**
 * Aggregate balance-mutation events from one or more NDJSON files and add them
 * to the POT `byAddress` and `byBalanceBlock` KVSs. Events are accumulated
 * in memory across all input files first so per-address history spans every
 * era in the run — that's why this isn't called per-era the way
 * `addBlocksToPot` is. Mirrors `addBalanceEventsToManifest` in ./swarm.ts.
 *
 * Per address, uploads one `AccountRecord` JSON chunk with the final balance
 * and the full event log (block-ordered), then stores its 32-byte ref under
 * the raw address bytes in `byAddress`. Per block, uploads one
 * `BlockEventsRecord` JSON chunk and stores its ref under the block number
 * in `byBalanceBlock`.
 *
 * Overwrite semantics: if the POT already has a value for a key (e.g. the
 * same address was uploaded in a previous run), `putRaw` replaces it; the
 * previous record chunk is orphaned. Upload all eras in one run to keep
 * per-address history coherent.
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
  // Two-phase: upload all record JSON chunks in parallel, then putRaw into
  // the KVS sequentially in the same order. POT KVS mutations have to stay
  // serialized per-store, but bee.uploadData can happily run in parallel.
  const accountRefs: { key: Uint8Array; ref: Uint8Array }[] = new Array(accountEntries.length)
  const accountUploadRate = makeRateLogger(log, '  accounts upload', accountEntries.length)
  await runWithConcurrency(
    accountEntries,
    concurrency,
    async ([addr, events], i) => {
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
      const normalizedAddr = addr.toLowerCase().replace(/^0x/, '')
      if (!/^[0-9a-f]{40}$/.test(normalizedAddr)) {
        throw new Error(`invalid address in balance events: ${addr}`)
      }
      accountRefs[i] = { key: hexToBytes(normalizedAddr), ref: reference.toUint8Array() }
    },
    (done) => accountUploadRate(done),
  )
  const accountIndexRate = makeRateLogger(log, '  accounts indexed', accountRefs.length)
  for (let i = 0; i < accountRefs.length; i++) {
    const { key, ref } = accountRefs[i]
    await indexes.byAddress.putRaw(key, ref)
    accountIndexRate(i + 1)
  }

  const blockEntries = [...byBlock.entries()]
  log(`uploading ${blockEntries.length} per-block event records...`)
  const blockRefs: { key: number; ref: Uint8Array }[] = new Array(blockEntries.length)
  const blockUploadRate = makeRateLogger(log, '  blocks upload', blockEntries.length)
  await runWithConcurrency(
    blockEntries,
    concurrency,
    async ([blockStr, events], i) => {
      events.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
      const record: BlockEventsRecord = { block: blockStr, events }
      const bytes = textEncoder.encode(JSON.stringify(record))
      const { reference } = await bee.uploadData(options.batchId, bytes)
      const numberKey = Number(blockStr)
      if (!Number.isSafeInteger(numberKey)) {
        throw new Error(`block number ${blockStr} exceeds Number.MAX_SAFE_INTEGER`)
      }
      blockRefs[i] = { key: numberKey, ref: reference.toUint8Array() }
    },
    (done) => blockUploadRate(done),
  )
  const blockIndexRate = makeRateLogger(log, '  blocks indexed', blockRefs.length)
  for (let i = 0; i < blockRefs.length; i++) {
    const { key, ref } = blockRefs[i]
    await indexes.byBalanceBlock.putRaw(key, ref)
    blockIndexRate(i + 1)
  }

  indexes.stats.addressCount += BigInt(byAddr.size)
  indexes.stats.eventCount += BigInt(eventCount)

  return { addressCount: byAddr.size, blockCount: byBlock.size, eventCount }
}

/**
 * Snapshot of the running stats as a `PotMeta`. Null when nothing has been
 * indexed yet. Pure read — does not touch Swarm.
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
    `meta: firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock} blockCount=${meta.blockCount}` +
      ` txCount=${meta.txCount} addressCount=${meta.addressCount} eventCount=${meta.eventCount}`,
  )
  return meta
}

/**
 * Save all five KVSs to Swarm and return their root references together with
 * the last-written meta reference (null if `writePotBlockRangeMeta` wasn't
 * called this run).
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

// ---------- Internal helpers ----------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

async function loadMetaStats(bee: Bee, metaRef: string | null): Promise<PotStats> {
  if (!metaRef) return emptyStats()
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

// ---------- Balance-events types + readers ----------

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

/**
 * Progress logger that mirrors `makeSaveProgressTracker` in ./swarm.ts: rate
 * is computed over a rolling wall-clock window (default 5 s) and lines are
 * throttled to at most one every 500 ms. Always emits when done === total so
 * the caller doesn't have to special-case the tail.
 */
function makeRateLogger(
  log: (msg: string) => void,
  label: string,
  total: number,
  windowMs = 5_000,
): (done: number) => void {
  let lastLoggedAt = 0
  const samples: Array<{ t: number; done: number }> = []
  let head = 0

  const rateOverWindow = (): number | null => {
    if (samples.length - head < 2) return null
    const first = samples[head]
    const last = samples[samples.length - 1]
    const dt = Math.max(1, last.t - first.t)
    return ((last.done - first.done) / dt) * 1000
  }

  return (done: number): void => {
    const now = Date.now()
    const tail = samples.length > 0 ? samples[samples.length - 1] : null
    if (tail && tail.t === now) {
      tail.done = done
    } else {
      samples.push({ t: now, done })
    }
    while (head < samples.length && now - samples[head].t > windowMs) head++
    if (head > 1_000 && head > samples.length >> 1) {
      samples.splice(0, head)
      head = 0
    }
    const isFinal = done === total
    if (!isFinal && now - lastLoggedAt < 500) return
    const rate = rateOverWindow()
    const rateStr = rate !== null ? `${rate.toFixed(1)}/s over ${windowMs / 1000}s` : 'warming up'
    log(`${label} ${done}/${total} (${rateStr})`)
    lastLoggedAt = now
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
