// Swarm upload logic for Ethereum block data.
//
// Uploads a per-block bundle (RLP-encoded [rawHeader, rawBody, rawReceipts,
// totalDifficulty]) and builds a unified Mantaray manifest with three index
// prefixes:
//   /number/<blockNumber> -> block bundle
//   /hash/<blockHash>     -> block bundle
//   /tx/<txHash>          -> block bundle (containing that tx)

import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import MantarayJs from 'mantaray-js'
import { encodeBlockBundle } from './bundle.js'
import { DATA_DIR } from './cli-shared.js'

const { MantarayNode, Utils, loadAllNodes } = MantarayJs

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

export interface UploadResult {
  manifestReference: string // Single root hash for all indexes
  blocksUploaded: number
  txHashesIndexed: number
}

export interface AddBlocksResult {
  blocksUploaded: number
  txHashesIndexed: number
}

export interface ManifestMeta {
  firstBlock: string
  lastBlock: string
  blockCount: string
  txCount: string
}

export interface UploadOptions {
  beeUrl?: string // default: http://localhost:1633
  batchId: string // required postage batch ID
  onProgress?: (msg: string) => void
  concurrency?: number // max concurrent uploads (default: 32)
  manifestHash?: string // existing manifest to extend
}

type MantarayNodeInstance = InstanceType<typeof MantarayJs.MantarayNode>

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
 * Create an in-memory Mantaray manifest — either fresh or by fully loading an
 * existing manifest so it can be extended in place.
 *
 * Use this together with `addBlocksToManifest` and `saveManifest` to upload
 * many blocks.ndjson files into a single manifest that is saved exactly once.
 */
export async function openManifest(
  bee: Bee,
  options: {
    manifestHash?: string
    onProgress?: (msg: string) => void
    cacheManifest?: boolean
  },
): Promise<MantarayNodeInstance> {
  const log = options.onProgress ?? console.log
  const manifest = new MantarayNode()

  if (options.manifestHash) {
    log(`loading existing manifest ${options.manifestHash}...`)
    const cacheEnabled = options.cacheManifest !== false
    const rootHex = options.manifestHash.toLowerCase()
    const existingRef = hexToBytes(rootHex) as Reference

    // Fast path: a consolidated snapshot for this root exists on disk. Slurp
    // it once, serve loadAllNodes from the resulting in-memory map.
    const snapshot = cacheEnabled ? await readSnapshot(rootHex) : null
    if (snapshot) {
      log(`snapshot hit: ${snapshot.size} chunks`)
      const snapLoader = async (ref: Reference) => {
        const refHex = bytesToHex(ref)
        const hit = snapshot.get(refHex)
        // Must return a fresh copy: mantaray-js's deserialize XOR-decrypts the
        // buffer in place. Deduped subtrees share a contentAddress, so the
        // same ref gets loaded more than once; reusing the Map's Uint8Array
        // would corrupt subsequent deserializations ("Wrong mantaray version").
        if (hit) return new Uint8Array(hit)
        const cached = await readCachedChunk(refHex)
        if (cached) return cached
        return new Uint8Array(await bee.downloadData(refHex))
      }
      await manifest.load(snapLoader, existingRef)
      await loadAllNodes(snapLoader, manifest)
    } else {
      const counters = { hits: 0, misses: 0 }
      const storageLoader = cacheEnabled
        ? makeCachedLoader(bee, counters)
        : async (ref: Reference) => new Uint8Array(await bee.downloadData(bytesToHex(ref)))
      await manifest.load(storageLoader, existingRef)
      // `load` only materializes the root node; descendants stay lazy. If we
      // start adding forks without hydrating the tree, unloaded subtrees get
      // dropped on save. Force-load everything before mutating.
      await loadAllNodes(storageLoader, manifest)
      if (cacheEnabled) {
        log(`manifest cache: ${counters.hits} hits, ${counters.misses} misses`)
        // First-time load from chunk cache / Swarm — consolidate into a
        // snapshot so subsequent opens take the fast path.
        try {
          const chunks = await collectTreeChunks(manifest)
          const bytes = await writeSnapshot(rootHex, chunks)
          await pruneOldSnapshots(rootHex)
          log(`snapshot written: ${chunks.size} chunks, ${bytes} bytes`)
        } catch (err) {
          log(`snapshot skipped: ${(err as Error).message}`)
        }
      }
    }
  } else {
    manifest.setObfuscationKey = Utils.gen32Bytes()
  }

  return manifest
}

/**
 * Upload every block in a blocks.ndjson file and add three fork entries
 * (/number/, /hash/, /tx/) per block into the given in-memory manifest.
 *
 * The manifest is NOT saved here — call `saveManifest` once after adding
 * every range/era you want to include.
 */
export async function addBlocksToManifest(
  bee: Bee,
  manifest: MantarayNodeInstance,
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
    const ref = hexToBytes(uploadResult.reference) as Reference

    manifest.addFork(textEncoder.encode(`number/${block.number}`), ref, {
      'Content-Type': 'application/octet-stream',
    })

    const normalizedHash = block.hash.toLowerCase()
    manifest.addFork(textEncoder.encode(`hash/${normalizedHash}`), ref, {
      'Content-Type': 'application/octet-stream',
    })

    for (const txHash of block.txHashes) {
      const normalizedTx = txHash.toLowerCase()
      manifest.addFork(textEncoder.encode(`tx/${normalizedTx}`), ref, {
        'Content-Type': 'application/octet-stream',
      })
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
 * Compute the block range from the manifest's own `number/<n>` forks without
 * mutating or uploading anything. Returns null if the manifest has no blocks.
 */
export function getManifestBlockRange(manifest: MantarayNodeInstance): ManifestMeta | null {
  const { numbers, txCount } = scanManifestTree(manifest)
  if (numbers.length === 0) return null
  let min = numbers[0]
  let max = numbers[0]
  for (const n of numbers) {
    if (n < min) min = n
    if (n > max) max = n
  }
  return {
    firstBlock: min.toString(),
    lastBlock: max.toString(),
    blockCount: numbers.length.toString(),
    txCount: txCount.toString(),
  }
}

/**
 * Compute the block range from the manifest's own `number/<n>` forks and
 * upsert it at path `meta` as a small JSON chunk. Deriving the range from the
 * manifest tree (rather than tracking it during `addBlocksToManifest`) makes
 * `/meta` a pure function of the indexed blocks — it cannot drift out of sync
 * with what the manifest actually contains.
 */
export async function writeBlockRangeMeta(
  bee: Bee,
  manifest: MantarayNodeInstance,
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
  const ref = hexToBytes(reference) as Reference

  // addFork on an existing path would collide with the old entry's metadata;
  // remove first so the new meta chunk fully replaces any prior one.
  try {
    manifest.removePath(textEncoder.encode('meta'))
  } catch {
    // no prior meta fork — fine
  }
  manifest.addFork(textEncoder.encode('meta'), ref, {
    'Content-Type': 'application/json',
  })
  log(
    `meta: firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock} blockCount=${meta.blockCount} txCount=${meta.txCount}`,
  )
  return meta
}

/**
 * Persist the in-memory manifest to Swarm. Only dirty nodes are re-uploaded,
 * so this is cheap to call once at the end of a multi-file run.
 */
export async function saveManifest(
  bee: Bee,
  manifest: MantarayNodeInstance,
  options: {
    batchId: string
    concurrency?: number
    onProgress?: (msg: string) => void
    cacheManifest?: boolean
  },
): Promise<string> {
  const log = options.onProgress ?? console.log
  const totalChunks = countMantarayNodes(manifest)
  log(`uploading manifest (${totalChunks} chunks)...`)

  const concurrency = options.concurrency ?? 32
  const cacheEnabled = options.cacheManifest !== false

  const rawUpload = async (data: Uint8Array) => {
    const result = await bee.uploadData(options.batchId, data)
    return hexToBytes(result.reference) as Reference
  }
  const uploadFn = cacheEnabled ? makeCachedSaver(rawUpload) : rawUpload

  const queuedUpload = createUploadQueue(concurrency, totalChunks, uploadFn, (uploaded, total) => {
    if (uploaded % 100 === 0 || uploaded === total) {
      log(`manifest chunks: ${uploaded}/${total}`)
    }
  })

  const manifestRef = await manifest.save(queuedUpload)
  const manifestReference = bytesToHex(manifestRef)
  log(`manifest saved: ${manifestReference}`)

  if (cacheEnabled) {
    try {
      const chunks = await collectTreeChunks(manifest)
      const bytes = await writeSnapshot(manifestReference, chunks)
      await pruneOldSnapshots(manifestReference)
      log(`snapshot written: ${chunks.size} chunks, ${bytes} bytes`)
    } catch (err) {
      log(`snapshot skipped: ${(err as Error).message}`)
    }
  }

  return manifestReference
}

// ---------- Internal helpers ----------

const textEncoder = new TextEncoder()

const textDecoder = new TextDecoder()
const NUMBER_PREFIX = 'number/'
const TX_PREFIX = 'tx/'

interface ManifestScan {
  numbers: bigint[]
  txCount: bigint
}

/**
 * Walk every path in the manifest once and collect block numbers from
 * `number/<n>` forks plus the count of `tx/<hash>` forks. Assumes the tree is
 * already hydrated (openManifest does this via loadAllNodes).
 */
function scanManifestTree(root: MantarayNodeInstance): ManifestScan {
  const numbers: bigint[] = []
  let txCount = 0n

  function walk(node: MantarayNodeInstance, accumulated: Uint8Array): void {
    if (node.getEntry) {
      const path = textDecoder.decode(accumulated)
      if (path.startsWith(NUMBER_PREFIX)) {
        const rest = path.slice(NUMBER_PREFIX.length)
        if (/^\d+$/.test(rest)) numbers.push(BigInt(rest))
      } else if (path.startsWith(TX_PREFIX)) {
        txCount++
      }
    }
    if (!node.forks) return
    for (const fork of Object.values(node.forks)) {
      const combined = new Uint8Array(accumulated.length + fork.prefix.length)
      combined.set(accumulated)
      combined.set(fork.prefix, accumulated.length)
      walk(fork.node, combined)
    }
  }

  walk(root, new Uint8Array())
  return { numbers, txCount }
}

/**
 * Count all nodes in a MantarayNode tree.
 * Each node = 1 chunk when uploaded to Swarm.
 */
function countMantarayNodes(node: MantarayNodeInstance): number {
  let count = 1 // This node
  if (!node.forks) return count
  for (const fork of Object.values(node.forks)) {
    count += countMantarayNodes(fork.node)
  }
  return count
}

/**
 * Create a concurrent upload queue with a sliding window.
 *
 * This prevents overwhelming the Bee node with too many parallel requests
 * while still maximizing throughput within the concurrency limit.
 */
function createUploadQueue(
  maxConcurrent: number,
  totalChunks: number,
  uploadFn: (data: Uint8Array) => Promise<Reference>,
  onProgress: (uploaded: number, total: number) => void,
): (data: Uint8Array) => Promise<Reference> {
  let inFlight = 0
  let uploaded = 0
  const waiting: Array<{ resolve: () => void }> = []

  return async (data: Uint8Array): Promise<Reference> => {
    // Wait for a slot if at capacity
    while (inFlight >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push({ resolve }))
    }

    inFlight++
    try {
      const ref = await uploadFn(data)
      uploaded++
      onProgress(uploaded, totalChunks)
      return ref
    } finally {
      inFlight--
      // Release next waiting upload
      const next = waiting.shift()
      if (next) next.resolve()
    }
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
    // Clean up the tmp file if rename failed mid-flight; ignore errors from
    // unlink since the tmp may already be gone.
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
