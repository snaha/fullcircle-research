// Swarm upload logic for Ethereum block data.
//
// Uploads a per-block bundle (RLP-encoded [rawHeader, rawBody, rawReceipts,
// totalDifficulty]) and builds a unified Mantaray manifest with three index
// prefixes:
//   /number/<blockNumber> -> block bundle
//   /hash/<blockHash>     -> block bundle
//   /tx/<txHash>          -> block bundle (containing that tx)

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import MantarayJs from 'mantaray-js'
import { encodeBlockBundle } from './bundle.js'

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
  options: { manifestHash?: string; onProgress?: (msg: string) => void },
): Promise<MantarayNodeInstance> {
  const log = options.onProgress ?? console.log
  const manifest = new MantarayNode()

  if (options.manifestHash) {
    log(`loading existing manifest ${options.manifestHash}...`)
    const storageLoader = async (ref: Reference) => {
      const data = await bee.downloadData(bytesToHex(ref))
      return new Uint8Array(data)
    }
    const existingRef = hexToBytes(options.manifestHash) as Reference
    await manifest.load(storageLoader, existingRef)
    // `load` only materializes the root node; descendants stay lazy. If we
    // start adding forks without hydrating the tree, unloaded subtrees get
    // dropped on save. Force-load everything before mutating.
    await loadAllNodes(storageLoader, manifest)
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
  const numbers = collectIndexedBlockNumbers(manifest)
  if (numbers.length === 0) {
    log('no indexed blocks — skipping meta')
    return null
  }
  let min = numbers[0]
  let max = numbers[0]
  for (const n of numbers) {
    if (n < min) min = n
    if (n > max) max = n
  }
  const meta: ManifestMeta = { firstBlock: min.toString(), lastBlock: max.toString() }
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
  log(`meta: firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock}`)
  return meta
}

/**
 * Persist the in-memory manifest to Swarm. Only dirty nodes are re-uploaded,
 * so this is cheap to call once at the end of a multi-file run.
 */
export async function saveManifest(
  bee: Bee,
  manifest: MantarayNodeInstance,
  options: { batchId: string; concurrency?: number; onProgress?: (msg: string) => void },
): Promise<string> {
  const log = options.onProgress ?? console.log
  const totalChunks = countMantarayNodes(manifest)
  log(`uploading manifest (${totalChunks} chunks)...`)

  const concurrency = options.concurrency ?? 32

  const queuedUpload = createUploadQueue(
    concurrency,
    totalChunks,
    async (data: Uint8Array) => {
      const result = await bee.uploadData(options.batchId, data)
      return hexToBytes(result.reference) as Reference
    },
    (uploaded, total) => {
      if (uploaded % 100 === 0 || uploaded === total) {
        log(`manifest chunks: ${uploaded}/${total}`)
      }
    },
  )

  const manifestRef = await manifest.save(queuedUpload)
  const manifestReference = bytesToHex(manifestRef)
  log(`manifest saved: ${manifestReference}`)
  return manifestReference
}

// ---------- Internal helpers ----------

const textEncoder = new TextEncoder()

const textDecoder = new TextDecoder()
const NUMBER_PREFIX = 'number/'

/**
 * Walk every path in the manifest and collect block numbers from forks at
 * `number/<n>`. Assumes the tree is already hydrated (openManifest does this
 * via loadAllNodes).
 */
function collectIndexedBlockNumbers(root: MantarayNodeInstance): bigint[] {
  const numbers: bigint[] = []

  function walk(node: MantarayNodeInstance, accumulated: Uint8Array): void {
    if (node.getEntry) {
      const path = textDecoder.decode(accumulated)
      if (path.startsWith(NUMBER_PREFIX)) {
        const rest = path.slice(NUMBER_PREFIX.length)
        if (/^\d+$/.test(rest)) numbers.push(BigInt(rest))
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
  return numbers
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
