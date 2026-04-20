// Swarm upload logic for Ethereum block data.
//
// Uploads block rawBody data to Swarm and builds a unified Mantaray manifest
// with three index prefixes:
//   /number/<blockNumber> -> block data
//   /hash/<blockHash>     -> block data
//   /tx/<txHash>          -> block data

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { Bee } from '@ethersphere/bee-js'
import MantarayJs from 'mantaray-js'

const { MantarayNode, Utils } = MantarayJs

// Reference type from mantaray-js (can't import from CJS module)
type Reference = Uint8Array & { length: 32 | 64 }

// ---------- Public types ----------

export interface BlockRecord {
  number: string
  hash: string
  txHashes: string[]
  rawBody: string
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
 *   - /number/<blockNumber> -> Swarm reference of block rawBody
 *   - /hash/<blockHash>     -> Swarm reference of block rawBody
 *   - /tx/<txHash>          -> Swarm reference of block rawBody
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
    // Upload rawBody bytes
    const bodyBytes = hexToBytes(block.rawBody)
    const uploadResult = await bee.uploadData(options.batchId, bodyBytes)
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
