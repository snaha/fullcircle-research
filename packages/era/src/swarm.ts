// Swarm upload logic for Ethereum block data and state-balance events.
//
// Uploads per-block bundles (RLP-encoded [rawHeader, rawBody, rawReceipts,
// totalDifficulty]) plus per-address / per-block balance-event records, and
// builds FIVE Mantaray sub-manifests — one per index:
//
//   numberManifest        forks keyed by `<blockNumber>`   -> block bundle
//   hashManifest          forks keyed by `<blockHash>`     -> block bundle
//   txManifest            forks keyed by `<txHash>`        -> block bundle
//   addressManifest       forks keyed by `<addressHex>`    -> account record
//   balanceBlockManifest  forks keyed by `<blockNumber>`   -> block-events record
//
// At save time the five sub-manifest roots are stitched into one combined
// root manifest whose top-level forks are `number/`, `hash/`, `tx/`,
// `address/`, `balance-block/` (plus an optional `meta` leaf). Consumption
// stays identical — `GET /bzz/<root>/number/123` and
// `GET /bzz/<root>/address/<hex>` both resolve — but the build path is
// independent trees that can be saved in parallel.
//
// Each sub-manifest is wrapped in `StreamingMantaray` from
// `@fullcircle/mantaray-stream`, which lazy-loads only the spine touched by
// each `addFork` instead of hydrating the whole tree up front. Adding to an
// existing manifest of billions of entries is therefore O(spine) per
// insert, not O(tree).

import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import {
  MantarayFork,
  MantarayNode,
  StreamingMantaray,
  Utils,
  saveTree,
  type MantarayNodeInstance,
  type StorageHandler,
  type StorageLoader,
  type StorageSaver,
} from '@fullcircle/mantaray-stream'
import { encodeBlockBundle } from './bundle.js'
import { DATA_DIR } from './cli-shared.js'
import { MAX_PAYLOAD_SIZE } from './swarm-chunk.js'
import type { BeeChunkStream } from './swarm-ws.js'

type Reference = Uint8Array & { length: 32 | 64 }

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

export interface ManifestRefs {
  root: string
  /** Null when the sub-manifest is empty (e.g. tx/ for pre-Homestead eras). */
  numberManifest: string | null
  hashManifest: string | null
  txManifest: string | null
  addressManifest: string | null
  balanceBlockManifest: string | null
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

export interface ManifestMeta {
  firstBlock: string
  lastBlock: string
  blockCount: string
  /** Total balance events uploaded. 0 when the manifest carries no state. */
  eventCount: string
  txCount: string
  /**
   * Addresses that have had an account record written. Cumulative across
   * upload runs — can overcount when the same address appears in multiple
   * runs, since we don't dedupe against previously-uploaded addresses.
   */
  addressCount: string
}

export interface UploadOptions {
  beeUrl?: string // default: http://localhost:1633
  batchId: string // required postage batch ID
  onProgress?: (msg: string) => void
  concurrency?: number // max concurrent uploads per sub-tree (default: 32)
  manifestHash?: string // existing root manifest to extend
}

interface ManifestStats {
  firstBlock: bigint | null
  lastBlock: bigint | null
  blockCount: bigint
  txCount: bigint
  addressCount: bigint
  eventCount: bigint
}

export interface Manifest {
  /** Sub-manifest keyed by `<blockNumber>`. */
  numberManifest: StreamingMantaray
  /** Sub-manifest keyed by `<blockHash>` (lowercase hex, no 0x prefix). */
  hashManifest: StreamingMantaray
  /** Sub-manifest keyed by `<txHash>` (lowercase hex, no 0x prefix). */
  txManifest: StreamingMantaray
  /** Sub-manifest keyed by `<addressHex>` (lowercase hex, no 0x prefix). */
  addressManifest: StreamingMantaray
  /** Sub-manifest keyed by `<blockNumber>` — balance-mutation events at that block. */
  balanceBlockManifest: StreamingMantaray
  /** Running counters — serialised by `writeBlockRangeMeta`. */
  stats: ManifestStats
  /** Swarm ref of the last-written meta chunk; stitched into root at save. */
  metaRef: Reference | null
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
 * Stream block records from an ndjson file.
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
 * Create a fresh `Manifest` (five empty sub-manifests) or open an existing
 * root manifest and extract its `number/`, `hash/`, `tx/`, `address/`,
 * `balance-block/` sub-manifests plus the `meta` ref if present.
 *
 * Sub-manifests are wrapped in `StreamingMantaray`, so opening an existing
 * billion-entry manifest only fetches the root chunk plus its immediate
 * children — descendants stay lazy until a mutation walks past them.
 *
 * Use this together with `addBlocksToManifest` and `saveManifest` to upload
 * many blocks.ndjson files into one combined root manifest that is saved
 * exactly once.
 */
export async function openManifest(
  bee: Bee,
  options: {
    batchId: string
    manifestHash?: string
    onProgress?: (msg: string) => void
    cacheManifest?: boolean
  },
): Promise<Manifest> {
  const log = options.onProgress ?? console.log
  const cacheEnabled = options.cacheManifest !== false
  const handler = makeStorageHandler(bee, options.batchId, cacheEnabled)

  if (!options.manifestHash) {
    return {
      numberManifest: freshSubManifest(handler),
      hashManifest: freshSubManifest(handler),
      txManifest: freshSubManifest(handler),
      addressManifest: freshSubManifest(handler),
      balanceBlockManifest: freshSubManifest(handler),
      stats: emptyStats(),
      metaRef: null,
    }
  }

  log(`loading existing manifest ${options.manifestHash}...`)
  const rootHex = options.manifestHash.toLowerCase()
  const existingRef = hexToBytes(rootHex) as Reference

  const root = new MantarayNode()
  await loadRootStub(root, existingRef, handler.loader)

  const numberManifest = extractSubManifest(root, 'number/', handler)
  const hashManifest = extractSubManifest(root, 'hash/', handler)
  const txManifest = extractSubManifest(root, 'tx/', handler)
  const addressManifest = extractSubManifest(root, 'address/', handler)
  const balanceBlockManifest = extractSubManifest(root, 'balance-block/', handler)
  const metaRef = extractMetaRef(root)
  const stats = metaRef ? await loadStatsFromMeta(bee, metaRef) : emptyStats()

  return {
    numberManifest,
    hashManifest,
    txManifest,
    addressManifest,
    balanceBlockManifest,
    stats,
    metaRef,
  }
}

/**
 * Upload every block in a blocks.ndjson file and add one leaf per index
 * (number, hash, tx) into the three sub-manifests. Nothing is saved to Swarm
 * here beyond the block bundles themselves — call `saveManifest` once per run.
 */
export async function addBlocksToManifest(
  bee: Bee,
  manifest: Manifest,
  blocksPath: string,
  options: {
    batchId: string
    onProgress?: (msg: string) => void
    /**
     * Persist the manifest to Swarm after every N blocks. Only dirty nodes
     * are re-uploaded each time (Mantaray tracks this internally), so this
     * buys resumability at modest extra cost. Omit for one final save.
     */
    checkpoint?: {
      every: number
      fn: (blocksProcessed: number, lastBlockNumber: string) => Promise<void>
    }
  },
): Promise<AddBlocksResult> {
  const log = options.onProgress ?? console.log
  let blocksUploaded = 0
  let txHashesIndexed = 0

  const every = options.checkpoint?.every
  const logEvery = every !== undefined ? Math.max(1, Math.min(100, Math.ceil(every / 5))) : 100

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
    const ref = uploadResult.reference.toUint8Array() as Reference
    const leafMeta = { 'Content-Type': 'application/octet-stream' }

    await manifest.numberManifest.addFork(textEncoder.encode(block.number), ref, leafMeta)

    const normalizedHash = block.hash.toLowerCase().replace(/^0x/, '')
    await manifest.hashManifest.addFork(textEncoder.encode(normalizedHash), ref, leafMeta)

    for (const txHash of block.txHashes) {
      const normalizedTx = txHash.toLowerCase().replace(/^0x/, '')
      await manifest.txManifest.addFork(textEncoder.encode(normalizedTx), ref, leafMeta)
      txHashesIndexed++
    }

    const blockNumber = BigInt(block.number)
    const stats = manifest.stats
    if (stats.firstBlock === null || blockNumber < stats.firstBlock) stats.firstBlock = blockNumber
    if (stats.lastBlock === null || blockNumber > stats.lastBlock) stats.lastBlock = blockNumber
    stats.blockCount += 1n
    stats.txCount += BigInt(block.txHashes.length)

    blocksUploaded++
    if (blocksUploaded % logEvery === 0) {
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

    if (options.checkpoint && blocksUploaded % options.checkpoint.every === 0) {
      await options.checkpoint.fn(blocksUploaded, block.number)
    }
  }

  return { blocksUploaded, txHashesIndexed }
}

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
 * them to the manifest's `addressManifest` and `balanceBlockManifest`
 * sub-trees. Events are accumulated in memory across all input files first
 * so per-address history spans every era in the run — that's why this isn't
 * called per-era the way `addBlocksToManifest` is.
 *
 * Per address, uploads one `AccountRecord` JSON chunk with the final balance
 * and the full event log (block-ordered). Per block, uploads one
 * `BlockEventsRecord` JSON chunk with every balance change at that block.
 *
 * Overwrite semantics: if `manifest` already has a fork for an address, it
 * gets replaced by the new record (previous chunk is orphaned). Upload all
 * eras in one run to keep per-address history coherent.
 */
export async function addBalanceEventsToManifest(
  bee: Bee,
  manifest: Manifest,
  eventsPaths: string[],
  options: {
    batchId: string
    onProgress?: (msg: string) => void
    concurrency?: number
  },
): Promise<AddBalanceEventsResult> {
  const log = options.onProgress ?? console.log
  const concurrency = options.concurrency ?? 32
  const leafMeta = { 'Content-Type': 'application/json' }

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
      const ref = reference.toUint8Array() as Reference
      const normalizedAddr = addr.toLowerCase().replace(/^0x/, '')
      await manifest.addressManifest.addFork(textEncoder.encode(normalizedAddr), ref, leafMeta)
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
      const ref = reference.toUint8Array() as Reference
      await manifest.balanceBlockManifest.addFork(textEncoder.encode(blockStr), ref, leafMeta)
    },
    (done, total) => log(`  blocks ${done}/${total}`),
  )

  manifest.stats.addressCount += BigInt(byAddr.size)
  manifest.stats.eventCount += BigInt(eventCount)

  return { addressCount: byAddr.size, blockCount: byBlock.size, eventCount }
}

/**
 * Snapshot of the running stats as a `ManifestMeta`. Null when nothing has
 * been indexed yet. Pure read — does not touch Swarm.
 */
export function getManifestBlockRange(manifest: Manifest): ManifestMeta | null {
  const { firstBlock, lastBlock, blockCount, txCount, addressCount, eventCount } = manifest.stats
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
 * reference on `manifest.metaRef` so `saveManifest` wires it into the root.
 */
export async function writeBlockRangeMeta(
  bee: Bee,
  manifest: Manifest,
  options: { batchId: string; onProgress?: (msg: string) => void },
): Promise<ManifestMeta | null> {
  const log = options.onProgress ?? console.log
  const meta = getManifestBlockRange(manifest)
  if (!meta) {
    log('no indexed blocks — skipping meta')
    return null
  }
  const metaBytes = textEncoder.encode(JSON.stringify(meta))
  const { reference } = await bee.uploadData(options.batchId, metaBytes)
  manifest.metaRef = reference.toUint8Array() as Reference
  log(
    `meta: firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock} blockCount=${meta.blockCount}` +
      ` txCount=${meta.txCount} addressCount=${meta.addressCount} eventCount=${meta.eventCount}`,
  )
  return meta
}

/**
 * Persist the manifest to Swarm.
 *
 * Saves the five sub-manifests concurrently, then stitches a fresh root
 * manifest whose top-level forks are `number/`, `hash/`, `tx/`, `address/`,
 * `balance-block/` (plus `meta` if present) and saves that too. Only dirty
 * nodes are re-uploaded.
 */
export async function saveManifest(
  bee: Bee,
  manifest: Manifest,
  options: {
    batchId: string
    concurrency?: number
    onProgress?: (msg: string) => void
    cacheManifest?: boolean
    chunkStream?: BeeChunkStream
  },
): Promise<ManifestRefs> {
  const log = options.onProgress ?? console.log
  const cacheEnabled = options.cacheManifest !== false
  const concurrency = options.concurrency ?? 32

  const saver = makeUploadFn(bee, options.batchId, options.chunkStream, cacheEnabled)
  const tracker = makeSaveProgressTracker(log)

  const subSave = async (label: string, sub: StreamingMantaray): Promise<Reference | null> => {
    const node = sub.rootNode
    if (!hasAnyFork(node) && !node.getEntry) {
      log(`[${label}] empty sub-manifest — skipping save`)
      return null
    }
    const ref = await sub.save()
    tracker.markSubDone(label)
    log(`[${label}] tree saved: ${bytesToHex(ref)}`)
    return ref
  }

  let numberRef: Reference | null
  let hashRef: Reference | null
  let txRef: Reference | null
  let addressRef: Reference | null
  let balanceBlockRef: Reference | null
  let rootRef: Reference
  try {
    ;[numberRef, hashRef, txRef, addressRef, balanceBlockRef] = await Promise.all([
      subSave('number', manifest.numberManifest),
      subSave('hash', manifest.hashManifest),
      subSave('tx', manifest.txManifest),
      subSave('address', manifest.addressManifest),
      subSave('balance-block', manifest.balanceBlockManifest),
    ])

    // Build a fresh root manifest with the (now-clean) sub-manifest roots
    // mounted as forks. Each sub.rootNode has contentAddress set after save,
    // so the iterative dirty-walk only re-uploads the new root chunk.
    const root = new MantarayNode()
    root.setObfuscationKey = Utils.gen32Bytes()
    root.forks = {}
    mountSubManifest(root, 'number/', manifest.numberManifest.rootNode)
    mountSubManifest(root, 'hash/', manifest.hashManifest.rootNode)
    mountSubManifest(root, 'tx/', manifest.txManifest.rootNode)
    mountSubManifest(root, 'address/', manifest.addressManifest.rootNode)
    mountSubManifest(root, 'balance-block/', manifest.balanceBlockManifest.rootNode)
    if (manifest.metaRef) {
      root.addFork(textEncoder.encode('meta'), manifest.metaRef, {
        'Content-Type': 'application/json',
      })
    }

    rootRef = await saveTree(root, { saver, concurrency })
    log(`[root] tree saved: ${bytesToHex(rootRef)}`)
  } finally {
    tracker.stop()
  }

  const refs: ManifestRefs = {
    root: bytesToHex(rootRef),
    numberManifest: numberRef ? bytesToHex(numberRef) : null,
    hashManifest: hashRef ? bytesToHex(hashRef) : null,
    txManifest: txRef ? bytesToHex(txRef) : null,
    addressManifest: addressRef ? bytesToHex(addressRef) : null,
    balanceBlockManifest: balanceBlockRef ? bytesToHex(balanceBlockRef) : null,
    meta: manifest.metaRef ? bytesToHex(manifest.metaRef) : null,
  }

  log(
    `manifest saved: root=${refs.root} number=${refs.numberManifest ?? '(empty)'}` +
      ` hash=${refs.hashManifest ?? '(empty)'} tx=${refs.txManifest ?? '(empty)'}` +
      ` address=${refs.addressManifest ?? '(empty)'} balance-block=${refs.balanceBlockManifest ?? '(empty)'}`,
  )

  return refs
}

// ---------- Internal helpers ----------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function emptyStats(): ManifestStats {
  return {
    firstBlock: null,
    lastBlock: null,
    blockCount: 0n,
    txCount: 0n,
    addressCount: 0n,
    eventCount: 0n,
  }
}

function freshSubManifest(handler: StorageHandler): StreamingMantaray {
  return StreamingMantaray.create(handler)
}

// Minimal port of `loadAndStub` for use during root extraction. After this,
// the root has its forks populated and each immediate child is stamped with
// contentAddress so the subsequent extractSubManifest can hand them out as
// clean StreamingMantaray instances.
async function loadRootStub(
  node: MantarayNodeInstance,
  ref: Reference,
  loader: StorageLoader,
): Promise<void> {
  await node.load(loader, ref)
  if (!node.forks) return
  for (const fork of Object.values(node.forks)) {
    const childRef = fork.node.getEntry
    if (childRef && !fork.node.getContentAddress) {
      fork.node.setContentAddress = childRef
    }
  }
}

/**
 * Extract a top-level fork as its own StreamingMantaray. When the fork's
 * prefix exactly matches `prefix`, we hand out fork.node directly (its
 * `contentAddress` is already set by `loadRootStub`). For the edge case of
 * a longer combined prefix (single-entry sub-index where the trie didn't
 * split at `prefix`), we synthesise a fresh parent whose single fork carries
 * the remainder. Returns an empty sub-manifest when no matching fork exists.
 */
function extractSubManifest(
  root: MantarayNodeInstance,
  prefix: string,
  handler: StorageHandler,
): StreamingMantaray {
  const prefixBytes = textEncoder.encode(prefix)
  const fork = root.forks?.[prefixBytes[0]]
  if (!fork) return freshSubManifest(handler)

  if (bytesEqual(fork.prefix, prefixBytes)) {
    return StreamingMantaray.fromNode(fork.node, handler)
  }

  if (!bytesStartWith(fork.prefix, prefixBytes)) {
    return freshSubManifest(handler)
  }

  const remainder = fork.prefix.slice(prefixBytes.length)
  const synth = new MantarayNode()
  synth.setObfuscationKey = Utils.gen32Bytes()
  synth.forks = {}
  synth.forks[remainder[0]] = new MantarayFork(remainder, fork.node)
  return StreamingMantaray.fromNode(synth, handler)
}

function extractMetaRef(root: MantarayNodeInstance): Reference | null {
  const metaBytes = textEncoder.encode('meta')
  const fork = root.forks?.[metaBytes[0]]
  if (!fork || !bytesEqual(fork.prefix, metaBytes)) return null
  return (fork.node.getEntry ?? null) as Reference | null
}

function mountSubManifest(
  root: MantarayNodeInstance,
  prefix: string,
  sub: MantarayNodeInstance,
): void {
  if (!hasAnyFork(sub) && !sub.getEntry) return // empty sub-manifest — skip
  const prefixBytes = textEncoder.encode(prefix)
  const forks = root.forks ?? (root.forks = {})
  forks[prefixBytes[0]] = new MantarayFork(prefixBytes, sub)
}

function hasAnyFork(node: MantarayNodeInstance): boolean {
  if (!node.forks) return false
  for (const _ in node.forks) return true
  return false
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function bytesStartWith(haystack: Uint8Array, prefix: Uint8Array): boolean {
  if (haystack.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (haystack[i] !== prefix[i]) return false
  return true
}

async function loadStatsFromMeta(bee: Bee, metaRef: Reference): Promise<ManifestStats> {
  try {
    const bytes = (await bee.downloadData(bytesToHex(metaRef))).toUint8Array()
    const parsed = JSON.parse(textDecoder.decode(bytes)) as Partial<ManifestMeta>
    return {
      firstBlock: parsed.firstBlock !== undefined ? BigInt(parsed.firstBlock) : null,
      lastBlock: parsed.lastBlock !== undefined ? BigInt(parsed.lastBlock) : null,
      blockCount: parsed.blockCount !== undefined ? BigInt(parsed.blockCount) : 0n,
      txCount: parsed.txCount !== undefined ? BigInt(parsed.txCount) : 0n,
      addressCount: parsed.addressCount !== undefined ? BigInt(parsed.addressCount) : 0n,
      eventCount: parsed.eventCount !== undefined ? BigInt(parsed.eventCount) : 0n,
    }
  } catch {
    return emptyStats()
  }
}

function makeStorageHandler(bee: Bee, batchId: string, cacheEnabled: boolean): StorageHandler {
  const counters = { hits: 0, misses: 0 }
  const loader: StorageLoader = cacheEnabled
    ? makeCachedLoader(bee, counters)
    : async (ref: Reference) => (await bee.downloadData(bytesToHex(ref))).toUint8Array()
  const rawSaver: StorageSaver = async (data: Uint8Array) => {
    const result = await bee.uploadData(batchId, data)
    return result.reference.toUint8Array() as Reference
  }
  const saver = cacheEnabled ? makeCachedSaver(rawSaver) : rawSaver
  return { loader, saver }
}

function makeUploadFn(
  bee: Bee,
  batchId: string,
  chunkStream: BeeChunkStream | undefined,
  cacheEnabled: boolean,
): StorageSaver {
  const rawHttpUpload = async (data: Uint8Array) => {
    const result = await bee.uploadData(batchId, data)
    return result.reference.toUint8Array() as Reference
  }
  // Manifest nodes are almost always ≤4 KB (one chunk). The rare fatter node
  // spills into a Swarm tree whose root ref we can only get from /bytes —
  // fall back to HTTP just for those.
  const rawUpload: StorageSaver = chunkStream
    ? async (data: Uint8Array) => {
        if (data.length <= MAX_PAYLOAD_SIZE) {
          const address = await chunkStream.uploadChunkPayload(data)
          return address as Reference
        }
        return rawHttpUpload(data)
      }
    : rawHttpUpload
  return cacheEnabled ? makeCachedSaver(rawUpload) : rawUpload
}

/**
 * Tracks per-sub progress and emits a heartbeat every 2s during long saves.
 */
interface SaveProgressTracker {
  markSubDone(label: string): void
  stop(): void
}

function makeSaveProgressTracker(log: (msg: string) => void): SaveProgressTracker {
  const startedAt = Date.now()
  let subsDone = 0
  const heartbeat = setInterval(() => {
    log(`save in progress: ${subsDone}/5 sub-manifests done (${Date.now() - startedAt} ms elapsed)`)
  }, 2_000)
  heartbeat.unref?.()
  return {
    markSubDone(_label) {
      subsDone++
    },
    stop() {
      clearInterval(heartbeat)
    },
  }
}

/**
 * Convert Uint8Array to hex string (no 0x prefix).
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

// ---------- Manifest chunk cache ----------
//
// Content-addressed on-disk cache for Mantaray manifest nodes. Keyed by the
// chunk's Swarm ref (BMT hash), so entries are immutable by construction —
// wiping data/.manifest-cache/ is always safe. Backs the StreamingMantaray
// loader so repeat fetches across runs (and re-fetches after eviction)
// short-circuit at disk instead of going to Bee.

const MANIFEST_CACHE_DIR = resolve(DATA_DIR, '.manifest-cache')

function cachePathFor(refHex: string): string {
  return resolve(MANIFEST_CACHE_DIR, refHex.slice(0, 2), `${refHex.slice(2)}.bin`)
}

async function readCachedChunk(refHex: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(cachePathFor(refHex))
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

let tmpCounter = 0

async function writeCachedChunk(refHex: string, data: Uint8Array): Promise<void> {
  const path = cachePathFor(refHex)
  await mkdir(resolve(path, '..'), { recursive: true })
  // temp + rename for atomic write so readers never see torn bytes. Tmp name
  // must be unique per call — Mantaray's concurrent save can emit the same ref
  // twice for deduped subtrees, which would otherwise collide on the tmp path.
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {
      /* noop */
    }
    throw err
  }
}

function makeCachedLoader(
  bee: Bee,
  counters: { hits: number; misses: number },
): (ref: Reference) => Promise<Uint8Array> {
  return async (ref: Reference) => {
    const refHex = bytesToHex(ref)
    const cached = await readCachedChunk(refHex)
    if (cached) {
      counters.hits++
      return cached
    }
    counters.misses++
    const data = (await bee.downloadData(refHex)).toUint8Array()
    await writeCachedChunk(refHex, data)
    return data
  }
}

function makeCachedSaver(inner: StorageSaver): StorageSaver {
  return async (data: Uint8Array) => {
    const ref = await inner(data)
    await writeCachedChunk(bytesToHex(ref), data)
    return ref
  }
}
