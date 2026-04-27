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

import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import MantarayJs from 'mantaray-js'
import { encodeBlockBundle } from './bundle.js'
import { DATA_DIR } from './cli-shared.js'
import { MAX_PAYLOAD_SIZE } from './swarm-chunk.js'
import type { BeeChunkStream } from './swarm-ws.js'

const { MantarayNode, MantarayFork, Utils, loadAllNodes } = MantarayJs

// Reference type from mantaray-js (can't import from CJS module)
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
  txCount: string
  /** Total balance events uploaded. 0 when the manifest carries no state. */
  eventCount: string
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

type MantarayNodeInstance = InstanceType<typeof MantarayJs.MantarayNode>

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
  numberManifest: MantarayNodeInstance
  /** Sub-manifest keyed by `<blockHash>` (lowercase hex, no 0x prefix). */
  hashManifest: MantarayNodeInstance
  /** Sub-manifest keyed by `<txHash>` (lowercase hex, no 0x prefix). */
  txManifest: MantarayNodeInstance
  /** Sub-manifest keyed by `<addressHex>` (lowercase hex, no 0x prefix). */
  addressManifest: MantarayNodeInstance
  /** Sub-manifest keyed by `<blockNumber>` — balance-mutation events at that block. */
  balanceBlockManifest: MantarayNodeInstance
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
 * Create a fresh `Manifest` (three empty sub-manifests) or load an existing
 * root manifest and extract its `number/`, `hash/`, `tx/` sub-manifests plus
 * the `meta` ref if present.
 *
 * Use this together with `addBlocksToManifest` and `saveManifest` to upload
 * many blocks.ndjson files into one combined root manifest that is saved
 * exactly once.
 */
export async function openManifest(
  bee: Bee,
  options: {
    manifestHash?: string
    onProgress?: (msg: string) => void
    cacheManifest?: boolean
  },
): Promise<Manifest> {
  const log = options.onProgress ?? console.log

  if (!options.manifestHash) {
    return {
      numberManifest: freshSubManifest(),
      hashManifest: freshSubManifest(),
      txManifest: freshSubManifest(),
      addressManifest: freshSubManifest(),
      balanceBlockManifest: freshSubManifest(),
      stats: emptyStats(),
      metaRef: null,
    }
  }

  log(`loading existing manifest ${options.manifestHash}...`)
  const cacheEnabled = options.cacheManifest !== false
  const rootHex = options.manifestHash.toLowerCase()
  const existingRef = hexToBytes(rootHex) as Reference
  const root = new MantarayNode()

  // Fast path: a consolidated snapshot for this root exists on disk.
  const snapshot = cacheEnabled ? await readSnapshot(rootHex) : null
  if (snapshot) {
    log(`snapshot hit: ${snapshot.size} chunks`)
    const snapLoader = async (ref: Reference) => {
      const refHex = bytesToHex(ref)
      const hit = snapshot.get(refHex)
      // Must return a fresh copy: mantaray-js's deserialize XOR-decrypts the
      // buffer in place. Deduped subtrees share a contentAddress, so the same
      // ref gets loaded more than once; reusing the Map's Uint8Array would
      // corrupt subsequent deserializations ("Wrong mantaray version").
      if (hit) return new Uint8Array(hit)
      const cached = await readCachedChunk(refHex)
      if (cached) return cached
      return new Uint8Array(await bee.downloadData(refHex))
    }
    await root.load(snapLoader, existingRef)
    await loadAllNodes(snapLoader, root)
  } else {
    const counters = { hits: 0, misses: 0 }
    const storageLoader = cacheEnabled
      ? makeCachedLoader(bee, counters)
      : async (ref: Reference) => new Uint8Array(await bee.downloadData(bytesToHex(ref)))
    await root.load(storageLoader, existingRef)
    // `load` only materializes the root node; descendants stay lazy. If we
    // start adding forks without hydrating the tree, unloaded subtrees get
    // dropped on save. Force-load everything before mutating.
    await loadAllNodes(storageLoader, root)
    if (cacheEnabled) {
      log(`manifest cache: ${counters.hits} hits, ${counters.misses} misses`)
    }
  }

  const numberManifest = extractSubManifest(root, 'number/')
  const hashManifest = extractSubManifest(root, 'hash/')
  const txManifest = extractSubManifest(root, 'tx/')
  const addressManifest = extractSubManifest(root, 'address/')
  const balanceBlockManifest = extractSubManifest(root, 'balance-block/')
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
/**
 * Bundle uploader callback: bytes in, 32-byte Swarm ref out. Default behaviour
 * is `bee.uploadData` (`POST /bytes`). Callers can swap in a `/chunks`- or
 * `/chunks/stream`-based uploader (see `uploadBundleAsTree` in swarm-chunk.ts)
 * without any changes in this module.
 */
export type BundleUploader = (bundleBytes: Uint8Array) => Promise<Uint8Array>

export async function addBlocksToManifest(
  bee: Bee,
  manifest: Manifest,
  blocksPath: string,
  options: {
    batchId: string
    onProgress?: (msg: string) => void
    /** Replace the per-block bundle upload path. Omit to use `bee.uploadData`. */
    bundleUploader?: BundleUploader
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
  const uploadBundle: BundleUploader =
    options.bundleUploader ??
    (async (bytes) => {
      const { reference } = await bee.uploadData(options.batchId, bytes)
      return hexToBytes(reference)
    })
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
    const ref = (await uploadBundle(bundleBytes)) as Reference
    const leafMeta = { 'Content-Type': 'application/octet-stream' }

    manifest.numberManifest.addFork(textEncoder.encode(block.number), ref, leafMeta)

    const normalizedHash = block.hash.toLowerCase().replace(/^0x/, '')
    manifest.hashManifest.addFork(textEncoder.encode(normalizedHash), ref, leafMeta)

    for (const txHash of block.txHashes) {
      const normalizedTx = txHash.toLowerCase().replace(/^0x/, '')
      manifest.txManifest.addFork(textEncoder.encode(normalizedTx), ref, leafMeta)
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
      const ref = hexToBytes(reference.toString()) as Reference
      const normalizedAddr = addr.toLowerCase().replace(/^0x/, '')
      manifest.addressManifest.addFork(textEncoder.encode(normalizedAddr), ref, leafMeta)
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
      const ref = hexToBytes(reference.toString()) as Reference
      manifest.balanceBlockManifest.addFork(textEncoder.encode(blockStr), ref, leafMeta)
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
  manifest.metaRef = hexToBytes(reference) as Reference
  log(
    `meta: firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock} blockCount=${meta.blockCount}` +
      ` txCount=${meta.txCount} addressCount=${meta.addressCount} eventCount=${meta.eventCount}`,
  )
  return meta
}

/**
 * Persist the manifest to Swarm.
 *
 * Saves the three sub-manifests concurrently, then stitches a fresh root
 * manifest whose top-level forks are `number/`, `hash/`, `tx/` (plus `meta`
 * if present) and saves that too. Only dirty nodes are re-uploaded.
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
    /**
     * Rewrite the consolidated on-disk snapshot after saving. Walks every
     * node in the tree to read their cached chunks, so it's expensive for
     * big manifests — skip on intermediate checkpoints and only write on the
     * final save of a run.
     */
    writeTreeSnapshot?: boolean
  },
): Promise<ManifestRefs> {
  const log = options.onProgress ?? console.log
  const cacheEnabled = options.cacheManifest !== false
  const concurrency = options.concurrency ?? 32

  const upload = makeUploadFn(bee, options.batchId, options.chunkStream, cacheEnabled)
  const tracker = makeSaveProgressTracker(log)

  const subSave = async (label: string, node: MantarayNodeInstance): Promise<Reference | null> => {
    if (!hasAnyFork(node) && !node.getEntry) {
      log(`[${label}] empty sub-manifest — skipping save`)
      return null
    }
    return saveMantarayTree(
      node,
      upload,
      concurrency,
      (msg) => log(`[${label}] ${msg}`),
      tracker,
      label,
    )
  }

  let numberRef: Reference | null
  let hashRef: Reference | null
  let txRef: Reference | null
  let addressRef: Reference | null
  let balanceBlockRef: Reference | null
  let rootRef: Reference
  const root = new MantarayNode()
  try {
    ;[numberRef, hashRef, txRef, addressRef, balanceBlockRef] = await Promise.all([
      subSave('number', manifest.numberManifest),
      subSave('hash', manifest.hashManifest),
      subSave('tx', manifest.txManifest),
      subSave('address', manifest.addressManifest),
      subSave('balance-block', manifest.balanceBlockManifest),
    ])

    // Stitch a fresh root with the clean sub-manifests as descendants.
    // Since each sub-manifest's root has `contentAddress` set after save, our
    // dirty-walk will upload only the new root chunk.
    root.setObfuscationKey = Utils.gen32Bytes()
    root.forks = {}
    mountSubManifest(root, 'number/', manifest.numberManifest)
    mountSubManifest(root, 'hash/', manifest.hashManifest)
    mountSubManifest(root, 'tx/', manifest.txManifest)
    mountSubManifest(root, 'address/', manifest.addressManifest)
    mountSubManifest(root, 'balance-block/', manifest.balanceBlockManifest)
    if (manifest.metaRef) {
      root.addFork(textEncoder.encode('meta'), manifest.metaRef, {
        'Content-Type': 'application/json',
      })
    }

    rootRef = await saveMantarayTree(
      root,
      upload,
      concurrency,
      (msg) => log(`[root] ${msg}`),
      tracker,
      'root',
    )
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

  if (cacheEnabled && options.writeTreeSnapshot !== false) {
    const snapStartedAt = Date.now()
    try {
      const chunks = await collectTreeChunks(root)
      const bytes = await writeSnapshot(refs.root, chunks)
      await pruneOldSnapshots(refs.root)
      log(
        `snapshot written: ${chunks.size} chunks, ${bytes} bytes (${Date.now() - snapStartedAt} ms)`,
      )
    } catch (err) {
      log(`snapshot skipped: ${(err as Error).message}`)
    }
  }

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

function freshSubManifest(): MantarayNodeInstance {
  const node = new MantarayNode()
  node.setObfuscationKey = Utils.gen32Bytes()
  return node
}

/**
 * Find the top-level fork whose prefix starts with `prefix` and return its
 * node as the sub-manifest. When the fork's prefix exactly matches `prefix`
 * (the normal case for a mature tree), we return `fork.node` directly so its
 * clean `contentAddress` is preserved. In the edge case of a longer prefix
 * (e.g. a single-entry sub-index where the trie didn't split at `prefix`),
 * we synthesize a fresh parent whose single fork carries the remainder.
 *
 * Returns an empty sub-manifest when the root has no matching fork.
 */
function extractSubManifest(root: MantarayNodeInstance, prefix: string): MantarayNodeInstance {
  const prefixBytes = textEncoder.encode(prefix)
  const fork = root.forks?.[prefixBytes[0]]
  if (!fork) return freshSubManifest()

  if (bytesEqual(fork.prefix, prefixBytes)) {
    return fork.node
  }

  if (!bytesStartWith(fork.prefix, prefixBytes)) {
    // Fork exists under the same first byte but diverges before `prefix` —
    // nothing to extract for this index.
    return freshSubManifest()
  }

  const remainder = fork.prefix.slice(prefixBytes.length)
  const sub = freshSubManifest()
  sub.forks = {}
  sub.forks[remainder[0]] = new MantarayFork(remainder, fork.node)
  return sub
}

function extractMetaRef(root: MantarayNodeInstance): Reference | null {
  const metaBytes = textEncoder.encode('meta')
  const fork = root.forks?.[metaBytes[0]]
  if (!fork || !bytesEqual(fork.prefix, metaBytes)) return null
  return fork.node.getEntry ?? null
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
    const bytes = new Uint8Array(await bee.downloadData(bytesToHex(metaRef)))
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

function makeUploadFn(
  bee: Bee,
  batchId: string,
  chunkStream: BeeChunkStream | undefined,
  cacheEnabled: boolean,
): (data: Uint8Array) => Promise<Reference> {
  const rawHttpUpload = async (data: Uint8Array): Promise<Reference> => {
    const result = await uploadDataWithRetry(bee, batchId, data)
    return hexToBytes(result.reference) as Reference
  }
  // Manifest nodes are almost always ≤4 KB (one chunk). The rare fatter node
  // spills into a Swarm tree whose root ref we can only get from /bytes —
  // fall back to HTTP just for those. The chunk-stream side has no retry:
  // a WS failure tears down the pipeline, so recovering a single in-flight
  // chunk without reopening the socket isn't meaningful.
  const rawUpload = chunkStream
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

// ---------- Upload retry ----------
//
// A local Bee (or the dev-proxy in front of one) will transiently refuse
// /bytes requests when it's overloaded — connections reset mid-request,
// sockets hang, the proxy returns 502 "bad gateway". bee-js propagates
// these straight up as BeeResponseError. Retrying is safe because
// uploads are content-addressed (same bytes ⇒ same ref).

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'])
const MAX_UPLOAD_RETRIES = 5

// bee-js wraps axios errors in BeeResponseError but doesn't re-export the
// class, so we shape-match instead of instanceof.
function isTransientUploadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; status?: number; statusText?: string; message?: string }
  if (e.code && RETRYABLE_CODES.has(e.code)) return true
  if (e.statusText && RETRYABLE_CODES.has(e.statusText)) return true
  if (typeof e.status === 'number' && (e.status === 429 || (e.status >= 500 && e.status < 600)))
    return true
  if (e.message && /socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE/i.test(e.message))
    return true
  return false
}

function describeErr(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const e = err as { code?: string; status?: number; statusText?: string; message?: string }
  const parts = [e.message ?? 'unknown']
  if (e.code) parts.push(`code=${e.code}`)
  if (e.status) parts.push(`status=${e.status}`)
  if (e.statusText && e.statusText !== e.code) parts.push(`statusText=${e.statusText}`)
  return parts.join(' ')
}

async function uploadDataWithRetry(
  bee: Bee,
  batchId: string,
  data: Uint8Array,
): Promise<{ reference: string }> {
  let attempt = 0
  for (;;) {
    try {
      return await bee.uploadData(batchId, data)
    } catch (err) {
      attempt++
      if (attempt > MAX_UPLOAD_RETRIES || !isTransientUploadError(err)) throw err
      // Exponential backoff w/ jitter: 200, 400, 800, 1600, 3200 ms (±25%)
      const base = 200 * 2 ** (attempt - 1)
      const delay = base + base * (Math.random() * 0.5 - 0.25)
      console.warn(
        `/bytes retry ${attempt}/${MAX_UPLOAD_RETRIES} after ${Math.round(delay)}ms: ${describeErr(err)}`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

/**
 * Iterative dirty-walk save for a single Mantaray tree. Replaces mantaray-js's
 * built-in `save()`, which spawns a Promise per fork of every dirty node —
 * including clean forks that short-circuit. For a big tree that means
 * millions of Promise allocations before the first chunk ever flows; this
 * walker only allocates work for dirty nodes and enforces post-order via
 * child-count decrements.
 */
async function saveMantarayTree(
  root: MantarayNodeInstance,
  upload: (data: Uint8Array) => Promise<Reference>,
  concurrency: number,
  log: (msg: string) => void,
  tracker: SaveProgressTracker,
  label: string,
): Promise<Reference> {
  const totalChunks = countMantarayNodes(root)
  const saveStartedAt = Date.now()
  let uploadedCount = 0
  let dirtyCount = 0

  const remaining = new Map<MantarayNodeInstance, number>()
  const parents = new Map<MantarayNodeInstance, MantarayNodeInstance>()
  const ready: MantarayNodeInstance[] = []
  let readyHead = 0

  // Phase 1: synchronously find every dirty node and record its dirty-child
  // count. A clean node (contentAddress set) is a dead end — we don't descend
  // into it and don't allocate anything for it. That's what keeps us out of
  // the O(dirty × 256) Promise explosion.
  ;(function walk(node: MantarayNodeInstance): void {
    if (node.getContentAddress) return
    let dirtyChildren = 0
    if (node.forks) {
      for (const fork of Object.values(node.forks)) {
        const child = fork.node
        if (child.getContentAddress) continue
        dirtyChildren++
        parents.set(child, node)
        walk(child)
      }
    }
    remaining.set(node, dirtyChildren)
    dirtyCount++
    if (dirtyChildren === 0) ready.push(node)
  })(root)

  const walkMs = Date.now() - saveStartedAt
  log(`dirty nodes: ${dirtyCount} (tree=${totalChunks}, walk=${walkMs} ms)`)
  tracker.addPlan(label, dirtyCount)

  if (dirtyCount === 0) {
    const existing = root.getContentAddress
    if (!existing) throw new Error('saveMantarayTree: root is clean but has no contentAddress')
    log(`tree saved: ${bytesToHex(existing)} (0 dirty / ${totalChunks} total chunks in 0 ms)`)
    return existing
  }

  // Phase 2: drain the ready queue with bounded concurrency. When a node's
  // upload completes, decrement its parent's remaining count; parent becomes
  // ready when it hits 0. Post-order is enforced by this dependency.
  let inFlight = 0
  let rootRef: Reference | null = null

  await new Promise<void>((resolveAll, rejectAll) => {
    let failed = false

    const startNext = (): void => {
      while (!failed && inFlight < concurrency && readyHead < ready.length) {
        const node = ready[readyHead++]
        inFlight++
        processNode(node).catch((err: unknown) => {
          inFlight--
          if (failed) return
          failed = true
          log(`  !! processNode rejected: ${(err as Error)?.message ?? String(err)}`)
          rejectAll(err instanceof Error ? err : new Error(String(err)))
        })
      }
      if (!failed && inFlight === 0 && readyHead >= ready.length) {
        resolveAll()
      }
    }

    const processNode = async (node: MantarayNodeInstance): Promise<void> => {
      const data = node.serialize()
      const ref = await upload(data)
      node.setContentAddress = ref
      if (node === root) rootRef = ref
      uploadedCount++
      tracker.markChunk(label)
      const parent = parents.get(node)
      if (parent) {
        const rem = (remaining.get(parent) ?? 0) - 1
        remaining.set(parent, rem)
        if (rem === 0) ready.push(parent)
      }
      inFlight--
      startNext()
    }

    startNext()
  })

  if (!rootRef) {
    const addr = root.getContentAddress
    if (!addr) throw new Error('saveMantarayTree: root was not uploaded')
    rootRef = addr
  }

  const saveElapsed = Date.now() - saveStartedAt
  log(
    `tree saved: ${bytesToHex(rootRef)} (${uploadedCount} dirty / ${totalChunks} total chunks in ${saveElapsed} ms)`,
  )

  return rootRef
}

/**
 * Aggregates upload progress across parallel `saveMantarayTree` calls and
 * emits one combined log line throttled to every 500 ms (plus a 2 s
 * heartbeat when nothing else has printed). The chunks/s rate uses a
 * sliding window (`windowMs`, default 5 s) rather than since-start, so it
 * reflects current throughput even after a slow start.
 */
interface SaveProgressTracker {
  addPlan(label: string, dirty: number): void
  markChunk(label: string): void
  stop(): void
}

function makeSaveProgressTracker(
  log: (msg: string) => void,
  windowMs = 5_000,
): SaveProgressTracker {
  const perLabel = new Map<string, { dirty: number; uploaded: number }>()
  let totalDirty = 0
  let totalUploaded = 0
  let lastLoggedAt = 0
  const samples: Array<{ t: number; uploaded: number }> = []
  let head = 0

  const rateOverWindow = (): number | null => {
    if (samples.length - head < 2) return null
    const first = samples[head]
    const last = samples[samples.length - 1]
    const dt = Math.max(1, last.t - first.t)
    return ((last.uploaded - first.uploaded) / dt) * 1000
  }

  const formatPerLabel = (): string =>
    Array.from(perLabel.entries())
      .map(([l, v]) => `${l}=${v.uploaded}/${v.dirty}`)
      .join(' ')

  const emit = (now: number): void => {
    const rate = rateOverWindow()
    const rateStr =
      rate !== null ? `${rate.toFixed(0)} chunks/s over ${windowMs / 1000}s` : 'warming up'
    log(`uploaded ${totalUploaded}/${totalDirty} (${rateStr}) — ${formatPerLabel()}`)
    lastLoggedAt = now
  }

  const heartbeat = setInterval(() => {
    const now = Date.now()
    if (now - lastLoggedAt < 2_000) return
    emit(now)
  }, 2_000)
  heartbeat.unref?.()

  return {
    addPlan(label, dirty) {
      perLabel.set(label, { dirty, uploaded: 0 })
      totalDirty += dirty
    },
    markChunk(label) {
      const entry = perLabel.get(label)
      if (entry) entry.uploaded++
      totalUploaded++
      const now = Date.now()
      const tail = samples.length > 0 ? samples[samples.length - 1] : null
      if (tail && tail.t === now) {
        tail.uploaded = totalUploaded
      } else {
        samples.push({ t: now, uploaded: totalUploaded })
      }
      // Drop samples older than the window; compact once `head` gets large
      // so the array doesn't grow unbounded for long saves.
      while (head < samples.length && now - samples[head].t > windowMs) head++
      if (head > 1_000 && head > samples.length >> 1) {
        samples.splice(0, head)
        head = 0
      }
      if (now - lastLoggedAt >= 500) emit(now)
    },
    stop() {
      clearInterval(heartbeat)
    },
  }
}

/**
 * Count all nodes in a MantarayNode tree.
 * Each node = 1 chunk when uploaded to Swarm.
 */
function countMantarayNodes(node: MantarayNodeInstance): number {
  let count = 1
  if (!node.forks) return count
  for (const fork of Object.values(node.forks)) {
    count += countMantarayNodes(fork.node)
  }
  return count
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
// wiping data/.manifest-cache/ is always safe.

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
    const data = new Uint8Array(await bee.downloadData(refHex))
    await writeCachedChunk(refHex, data)
    return data
  }
}

function makeCachedSaver(
  inner: (data: Uint8Array) => Promise<Reference>,
): (data: Uint8Array) => Promise<Reference> {
  return async (data: Uint8Array) => {
    const ref = await inner(data)
    await writeCachedChunk(bytesToHex(ref), data)
    return ref
  }
}

// ---------- Manifest snapshot ----------
//
// Single-file consolidation of every chunk belonging to one manifest tree.
// Lets openManifest hydrate the full tree with one sequential read instead of
// O(nodes) per-chunk file reads. Falls back to the chunk cache on miss or
// corruption; can always be regenerated, so wiping snapshots is safe.

const SNAPSHOT_MAGIC = new TextEncoder().encode('FCMS')
const SNAPSHOT_VERSION = 1
const SNAPSHOT_PREFIX = 'snapshot-'
const SNAPSHOT_SUFFIX = '.bin'
const REF_LEN = 32

function snapshotPathFor(rootHex: string): string {
  return resolve(MANIFEST_CACHE_DIR, `${SNAPSHOT_PREFIX}${rootHex}${SNAPSHOT_SUFFIX}`)
}

async function readSnapshot(rootHex: string): Promise<Map<string, Uint8Array> | null> {
  let buf: Uint8Array
  try {
    const fileBuf = await readFile(snapshotPathFor(rootHex))
    buf = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  if (buf.length < SNAPSHOT_MAGIC.length + 1 + 4) return null
  for (let i = 0; i < SNAPSHOT_MAGIC.length; i++) {
    if (buf[i] !== SNAPSHOT_MAGIC[i]) return null
  }
  let off = SNAPSHOT_MAGIC.length
  if (buf[off++] !== SNAPSHOT_VERSION) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = view.getUint32(off, true)
  off += 4

  const map = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    if (off + REF_LEN + 4 > buf.length) return null
    const refHex = bytesToHex(buf.subarray(off, off + REF_LEN))
    off += REF_LEN
    const len = view.getUint32(off, true)
    off += 4
    if (off + len > buf.length) return null
    map.set(refHex, buf.subarray(off, off + len))
    off += len
  }
  return map
}

async function writeSnapshot(rootHex: string, chunks: Map<string, Uint8Array>): Promise<number> {
  let total = SNAPSHOT_MAGIC.length + 1 + 4
  for (const data of chunks.values()) total += REF_LEN + 4 + data.length

  const buf = new Uint8Array(total)
  buf.set(SNAPSHOT_MAGIC, 0)
  let off = SNAPSHOT_MAGIC.length
  buf[off++] = SNAPSHOT_VERSION
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint32(off, chunks.size, true)
  off += 4
  for (const [refHex, data] of chunks) {
    buf.set(hexToBytes(refHex), off)
    off += REF_LEN
    view.setUint32(off, data.length, true)
    off += 4
    buf.set(data, off)
    off += data.length
  }

  const path = snapshotPathFor(rootHex)
  await mkdir(MANIFEST_CACHE_DIR, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, buf)
  await rename(tmp, path)
  return total
}

async function collectTreeChunks(root: MantarayNodeInstance): Promise<Map<string, Uint8Array>> {
  const map = new Map<string, Uint8Array>()

  async function walk(node: MantarayNodeInstance): Promise<void> {
    const addr = node.getContentAddress
    if (!addr) throw new Error('manifest node missing contentAddress after save')
    const refHex = bytesToHex(addr)
    if (!map.has(refHex)) {
      const data = await readCachedChunk(refHex)
      if (!data) throw new Error(`manifest chunk ${refHex} missing from cache`)
      map.set(refHex, data)
    }
    if (!node.forks) return
    for (const fork of Object.values(node.forks)) {
      await walk(fork.node)
    }
  }

  await walk(root)
  return map
}

async function pruneOldSnapshots(keepRootHex: string): Promise<void> {
  const keep = `${SNAPSHOT_PREFIX}${keepRootHex}${SNAPSHOT_SUFFIX}`
  let entries: string[]
  try {
    entries = await readdir(MANIFEST_CACHE_DIR)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (const name of entries) {
    if (name === keep) continue
    if (!name.startsWith(SNAPSHOT_PREFIX) || !name.endsWith(SNAPSHOT_SUFFIX)) continue
    await unlink(resolve(MANIFEST_CACHE_DIR, name))
  }
}
