// Swarm content-addressed chunk (CAC) primitives.
//
// Reimplements `makeSpan` and `bmtHash` locally so we can compute a chunk's
// BMT address without reaching into bee-js internals. Needed to stream
// chunks over the `/chunks/stream` WebSocket, where the client sends
// `span || payload` and must already know the address.

import { keccak_256 } from '@noble/hashes/sha3'

export const SPAN_SIZE = 8
export const MAX_PAYLOAD_SIZE = 4096
const SEGMENT_SIZE = 32
const SEGMENT_PAIR_SIZE = 2 * SEGMENT_SIZE
const HASH_SIZE = 32

/**
 * Encode a length as an 8-byte little-endian span. Swarm caps spans at 2^32-1
 * to sidestep BigInt interop issues at the JS boundary.
 */
export function makeSpan(length: number): Uint8Array {
  if (length <= 0 || length > 0xffffffff) {
    throw new Error(`invalid span length ${length}`)
  }
  const span = new Uint8Array(SPAN_SIZE)
  const view = new DataView(span.buffer)
  view.setUint32(0, length, true)
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
 * payloads — callers that may exceed the limit must chunk locally or fall back
 * to the HTTP `/bytes` endpoint.
 */
export function makeChunk(payload: Uint8Array): Chunk {
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`payload size ${payload.length} outside [1, ${MAX_PAYLOAD_SIZE}]`)
  }
  const data = new Uint8Array(SPAN_SIZE + payload.length)
  data.set(makeSpan(payload.length), 0)
  data.set(payload, SPAN_SIZE)
  return { data, address: bmtHash(data) }
}
