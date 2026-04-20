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

const { MantarayNode, Utils } = MantarayJs

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

export interface UploadOptions {
  beeUrl?: string // default: http://localhost:1633
  batchId: string // required postage batch ID
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
 * Stream block records from an ndjson file.
 */
export async function* readBlocksNdjson(
  path: string,
): AsyncGenerator<BlockRecord> {
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
 * Upload all blocks from a blocks.ndjson file and build a unified manifest.
 *
 * The manifest has three index prefixes:
 *   - /number/<blockNumber> -> Swarm reference of the block bundle
 *   - /hash/<blockHash>     -> Swarm reference of the block bundle
 *   - /tx/<txHash>          -> Swarm reference of the block bundle containing the tx
 *
 * The bundle is `encodeBlockBundle(...)` — one fetch returns header, body,
 * receipts, and totalDifficulty for a block.
 *
 * Returns a single manifest reference that serves all three indexes.
 */
export async function uploadBlocksAndBuildManifest(
  blocksPath: string,
  options: UploadOptions,
): Promise<UploadResult> {
  const beeUrl = options.beeUrl ?? 'http://localhost:1633'
  const bee = new Bee(beeUrl)
  const log = options.onProgress ?? console.log

  const manifest = new MantarayNode()
  manifest.setObfuscationKey = Utils.gen32Bytes()

  let blocksUploaded = 0
  let txHashesIndexed = 0

  for await (const block of readBlocksNdjson(blocksPath)) {
    // Encode the bundle: header + body + receipts + totalDifficulty
    const bundleBytes = encodeBlockBundle({
      rawHeader: hexToBytes(block.rawHeader),
      rawBody: hexToBytes(block.rawBody),
      rawReceipts: hexToBytes(block.rawReceipts),
      totalDifficulty:
        block.totalDifficulty === null ? null : BigInt(block.totalDifficulty),
    })
    const uploadResult = await bee.uploadData(options.batchId, bundleBytes)
    const ref = hexToBytes(uploadResult.reference) as Reference

    // Add to manifest under /number/<blockNumber>
    manifest.addFork(
      textEncoder.encode(`number/${block.number}`),
      ref,
      { 'Content-Type': 'application/octet-stream' },
    )

    // Add to manifest under /hash/<blockHash>
    // Keep the 0x prefix and lowercase for consistency with standard Ethereum hex encoding
    const normalizedHash = block.hash.toLowerCase()
    manifest.addFork(
      textEncoder.encode(`hash/${normalizedHash}`),
      ref,
      { 'Content-Type': 'application/octet-stream' },
    )

    // Add to manifest under /tx/<txHash> for each transaction
    for (const txHash of block.txHashes) {
      const normalizedTx = txHash.toLowerCase()
      manifest.addFork(
        textEncoder.encode(`tx/${normalizedTx}`),
        ref,
        { 'Content-Type': 'application/octet-stream' },
      )
      txHashesIndexed++
    }

    blocksUploaded++
    if (blocksUploaded % 100 === 0) {
      log(`uploaded ${blocksUploaded} blocks, ${txHashesIndexed} tx hashes indexed`)
    }
  }

  log(`uploading manifest with ${blocksUploaded} blocks...`)

  // Save manifest to Swarm
  const manifestRef = await manifest.save(async (data: Uint8Array) => {
    const result = await bee.uploadData(options.batchId, data)
    return hexToBytes(result.reference) as Reference
  })

  const manifestReference = bytesToHex(manifestRef)

  log(`manifest saved: ${manifestReference}`)

  return {
    manifestReference,
    blocksUploaded,
    txHashesIndexed,
  }
}

// ---------- Internal helpers ----------

const textEncoder = new TextEncoder()

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
