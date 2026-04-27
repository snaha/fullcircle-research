// Swarm content-addressed chunk (CAC) primitives.
//
// Reimplements `makeSpan` and `bmtHash` locally so we can compute a chunk's
// BMT address without reaching into bee-js internals. Needed to stream
// chunks over the `/chunks/stream` WebSocket, where the client sends
// `span || payload` and must already know the address.

import { keccak_256 } from '@noble/hashes/sha3'

export const SPAN_SIZE = 8
export const MAX_PAYLOAD_SIZE = 4096
// Number of 32-byte references that fit in one intermediate chunk payload
// (4096 / 32 = 128). Equivalently: branching factor of the Swarm chunk tree.
export const REFS_PER_CHUNK = MAX_PAYLOAD_SIZE / 32
const SEGMENT_SIZE = 32
const SEGMENT_PAIR_SIZE = 2 * SEGMENT_SIZE
const HASH_SIZE = 32

/**
 * Encode a length as an 8-byte little-endian span. Accepts a bigint to cover
 * intermediate chunks whose cumulative span can exceed uint32 on large
 * payloads; leaves pass a plain number and it's widened transparently.
 */
export function makeSpan(length: number | bigint): Uint8Array {
  const big = typeof length === 'bigint' ? length : BigInt(length)
  if (big <= 0n || big > 0xffffffffffffffffn) {
    throw new Error(`invalid span length ${length}`)
  }
  const span = new Uint8Array(SPAN_SIZE)
  new DataView(span.buffer).setBigUint64(0, big, true)
  return span
}

/**
 * Binary Merkle Tree hash of a full chunk (span + payload). The payload is
 * zero-padded to 4096 bytes, split into 128 × 32-byte segments, then keccak256
 * is applied pair-wise up the tree. Final address = keccak256(span || root).
 */
export function bmtHash(chunkContent: Uint8Array): Uint8Array {
  if (chunkContent.length < SPAN_SIZE) {
    throw new Error('chunk too small — missing span')
  }
  const span = chunkContent.subarray(0, SPAN_SIZE)
  const payload = chunkContent.subarray(SPAN_SIZE)
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`chunk payload too large: ${payload.length} > ${MAX_PAYLOAD_SIZE}`)
  }

  let input = new Uint8Array(MAX_PAYLOAD_SIZE)
  input.set(payload, 0)

  while (input.length !== HASH_SIZE) {
    const output = new Uint8Array(input.length / 2)
    for (let off = 0; off < input.length; off += SEGMENT_PAIR_SIZE) {
      const h = keccak_256(input.subarray(off, off + SEGMENT_PAIR_SIZE))
      output.set(h, off / 2)
    }
    input = output
  }

  const head = new Uint8Array(SPAN_SIZE + HASH_SIZE)
  head.set(span, 0)
  head.set(input, SPAN_SIZE)
  return keccak_256(head)
}

export interface Chunk {
  readonly data: Uint8Array // span || payload
  readonly address: Uint8Array // 32-byte BMT hash
}

/**
 * Build a content-addressed chunk for a ≤4096-byte payload. Throws for larger
 * payloads — callers that may exceed the limit must use `uploadBundleAsTree`
 * (which chunks locally) or fall back to the HTTP `/bytes` endpoint.
 *
 * The span defaults to payload.length (what you want for leaf chunks). For
 * intermediate chunks that fan out to children, pass the cumulative span of
 * the subtree — otherwise Bee will reject the chunk on retrieve or yield
 * wrong byte offsets for range requests.
 */
export function makeChunk(payload: Uint8Array, span?: number | bigint): Chunk {
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`payload size ${payload.length} outside [1, ${MAX_PAYLOAD_SIZE}]`)
  }
  const data = new Uint8Array(SPAN_SIZE + payload.length)
  data.set(makeSpan(span ?? payload.length), 0)
  data.set(payload, SPAN_SIZE)
  return { data, address: bmtHash(data) }
}

/**
 * Signature for an uploader that knows how to push one content-addressed chunk
 * to Swarm. Implementations: (a) `bee.uploadChunk` over HTTP `/chunks`, (b)
 * `BeeChunkStream.sendChunkData` over WebSocket `/chunks/stream`. The caller
 * supplies both `chunkData` (span||payload) and the precomputed `address`;
 * the uploader is responsible only for pushing bytes and awaiting ack.
 */
export type ChunkUploader = (chunkData: Uint8Array, address: Uint8Array) => Promise<void>

/**
 * Split a payload into a Swarm content-addressed chunk tree, upload every
 * chunk via `uploadChunk`, and return the root's 32-byte address.
 *
 * Layout mirrors what Bee's `/bytes` endpoint produces internally:
 *   - leaves: up to ⌈len/4096⌉ chunks of raw payload, span = chunk length
 *   - intermediates: fan-out of 128 × 32-byte refs per chunk, span = sum of
 *     descendants' spans
 *   - root: last intermediate (or the sole leaf for payloads ≤4096 bytes)
 *
 * Returns the root address so callers can use it anywhere they'd previously
 * use `bee.uploadData()`'s returned reference.
 */
export async function uploadBundleAsTree(
  payload: Uint8Array,
  uploadChunk: ChunkUploader,
): Promise<Uint8Array> {
  if (payload.length === 0) {
    throw new Error('uploadBundleAsTree: payload is empty')
  }

  // Leaves: carve the payload into ≤4KB pages, span = page length.
  const leaves: Chunk[] = []
  for (let off = 0; off < payload.length; off += MAX_PAYLOAD_SIZE) {
    const page = payload.subarray(off, Math.min(off + MAX_PAYLOAD_SIZE, payload.length))
    leaves.push(makeChunk(page))
  }
  for (const c of leaves) await uploadChunk(c.data, c.address)

  // Fan-in: each intermediate packs up to 128 child refs and carries the sum
  // of children's spans. Repeat until one node remains — that's the root.
  let level: Chunk[] = leaves
  while (level.length > 1) {
    const next: Chunk[] = []
    for (let i = 0; i < level.length; i += REFS_PER_CHUNK) {
      const batch = level.slice(i, Math.min(i + REFS_PER_CHUNK, level.length))
      const refPayload = new Uint8Array(batch.length * 32)
      let totalSpan = 0n
      for (let j = 0; j < batch.length; j++) {
        refPayload.set(batch[j].address, j * 32)
        totalSpan += readSpan(batch[j].data)
      }
      const parent = makeChunk(refPayload, totalSpan)
      next.push(parent)
    }
    for (const c of next) await uploadChunk(c.data, c.address)
    level = next
  }

  return level[0].address
}

function readSpan(chunkData: Uint8Array): bigint {
  return new DataView(chunkData.buffer, chunkData.byteOffset, SPAN_SIZE).getBigUint64(0, true)
}
