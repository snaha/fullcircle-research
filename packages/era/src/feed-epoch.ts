// Epoch-based feed math — binary time-tree where each epoch is (start, level)
// and covers 2^level seconds starting at `start`.
//
// Ported from @snaha/swarm-id's proxy/feeds/epochs/epoch.ts to avoid depending
// on the published bundle, which inlines a browser-only axios/form-data path
// that breaks in Node (references `window.FormData`).
//
// Original: Copyright 2026 The Swarm Authors (Apache-2.0).

import { keccak_256 } from '@noble/hashes/sha3'

export const MAX_EPOCH_LEVEL = 32

export interface Epoch {
  start: bigint
  level: number
}

export class EpochIndex implements Epoch {
  constructor(
    public readonly start: bigint,
    public readonly level: number,
  ) {
    if (level < 0 || level > MAX_EPOCH_LEVEL) {
      throw new Error(`epoch level must be 0..${MAX_EPOCH_LEVEL}; got ${level}`)
    }
  }

  /** keccak256(start:uint64-BE || level:u8) — used to derive feed identifier. */
  marshalBinary(): Uint8Array {
    const buffer = new Uint8Array(9)
    new DataView(buffer.buffer).setBigUint64(0, this.start, false)
    buffer[8] = this.level
    return keccak_256(buffer)
  }

  /** Epoch length in seconds (2^level). */
  length(): bigint {
    return 1n << BigInt(this.level)
  }

  /** UNSAFE: do not call on top-level epoch (level 32). */
  parent(): EpochIndex {
    const length = this.length() << 1n
    const start = (this.start / length) * length
    return new EpochIndex(start, this.level + 1)
  }

  /** UNSAFE: do not call when `at` is outside this epoch's range. */
  childAt(at: bigint): EpochIndex {
    const newLevel = this.level - 1
    const length = 1n << BigInt(newLevel)
    let start = this.start
    if ((at & length) > 0n) start |= length
    return new EpochIndex(start, newLevel)
  }

  /** Epoch to use for a new update given the previous update's timestamp. */
  next(last: bigint, at: bigint): EpochIndex {
    if (this.start + this.length() > at) return this.childAt(at)
    return lca(at, last).childAt(at)
  }
}

/** Lowest common ancestor epoch containing both `at` and `after`. */
export function lca(at: bigint, after: bigint): EpochIndex {
  if (after === 0n) return new EpochIndex(0n, MAX_EPOCH_LEVEL)

  const diff = at - after
  let length = 1n
  let level = 0

  while (level < MAX_EPOCH_LEVEL && (length < diff || at / length !== after / length)) {
    length <<= 1n
    level++
  }

  const start = (after / length) * length
  return new EpochIndex(start, level)
}

/** First-update root epoch when no previous hints exist. */
export function nextEpoch(prevEpoch: EpochIndex | undefined, last: bigint, at: bigint): EpochIndex {
  if (!prevEpoch) return new EpochIndex(0n, MAX_EPOCH_LEVEL)
  return prevEpoch.next(last, at)
}

/** Feed identifier for this epoch: keccak256(topic || keccak256(start||level)). */
export function epochIdentifier(topic: Uint8Array, epoch: EpochIndex): Uint8Array {
  const epochHash = epoch.marshalBinary()
  const buf = new Uint8Array(topic.length + epochHash.length)
  buf.set(topic, 0)
  buf.set(epochHash, topic.length)
  return keccak_256(buf)
}

/** v1 epoch-feed payload: timestamp(8 BE) || reference(32 or 64). */
export function epochPayload(at: bigint, reference: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + reference.length)
  new DataView(out.buffer).setBigUint64(0, at, false)
  out.set(reference, 8)
  return out
}
