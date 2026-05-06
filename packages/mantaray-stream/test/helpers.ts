// Test helpers: in-memory chunk storage and reference fixtures.

import { createHash } from 'node:crypto'
import type { StorageHandler } from '../src/index.js'

type Reference = Uint8Array & { length: 32 | 64 }

export class InmemStore {
  // Counts let tests assert that streaming inserts didn't fetch the whole
  // tree (loads << total chunks).
  loads = 0
  saves = 0

  private readonly map = new Map<string, Uint8Array>()

  handler(): StorageHandler {
    return {
      loader: async (ref: Reference) => {
        this.loads++
        const hex = toHex(ref)
        const bytes = this.map.get(hex)
        if (!bytes) throw new Error(`load: ref ${hex} not found`)
        // Mantaray-js's deserialize XOR-decrypts the buffer in place. Hand
        // out a fresh copy so re-loads of the same chunk don't get
        // double-decrypted.
        return new Uint8Array(bytes)
      },
      saver: async (data: Uint8Array) => {
        this.saves++
        const ref = sha256(data) as Reference
        this.map.set(toHex(ref), new Uint8Array(data))
        return ref
      },
    }
  }

  size(): number {
    return this.map.size
  }
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

export function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const enc = new TextEncoder()
export function key(s: string): Uint8Array {
  return enc.encode(s)
}

// Deterministic 32-byte ref from a seed string — used as fork values in
// tests so we can spot-check that getForkAtPath returns the right thing.
export function seedRef(s: string): Uint8Array & { length: 32 } {
  return sha256(enc.encode(s)) as Uint8Array & { length: 32 }
}

// Zero obfuscation key — matches what mantaray-js does when none is set
// explicitly. Using a fixed key keeps test root refs reproducible across
// runs and across the streaming/non-streaming paths.
export const ZERO_KEY = new Uint8Array(32) as Uint8Array & { readonly length: 32 }
