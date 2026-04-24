// Browser bridge to the POT runtime.
//
// Uses the pure-TS `@fullcircle/pot` compat layer — same API as the old WASM
// runtime, no `<script src="/pot-web.js">` load, no `pot.wasm` fetch. Keys
// follow the same encoding as `packages/era/src/swarm-pot.ts`:
//   byNumber        key = block number as a JS number (POT serialises to 8-byte BE IEEE-754)
//   byHash          key = 32-byte raw block hash
//   byTx            key = 32-byte raw tx hash
//   byAddress       key = 20-byte raw address
//   byBalanceBlock  key = block number as a JS number

import { browser } from '$app/environment'
import { createPotCompat, type PotGlobalCompat, type PotKvsCompat } from '@fullcircle/pot'

let runtimePromise: Promise<PotGlobalCompat> | null = null

function loadRuntime(): Promise<PotGlobalCompat> {
  if (!browser) return Promise.reject(new Error('POT runtime is browser-only'))
  if (runtimePromise) return runtimePromise
  const pot = createPotCompat()
  runtimePromise = pot.ready()
  return runtimePromise
}

// One-KVS-per-ref cache. `pot.load` re-hydrates from Swarm, so repeating it
// per lookup would be wasteful; keys are the root refs themselves.
const kvsCache = new Map<string, Promise<PotKvsCompat>>()

function cacheKey(ref: string, beeUrl: string): string {
  return `${beeUrl}\x00${ref}`
}

async function loadKvs(ref: string, beeUrl: string): Promise<PotKvsCompat> {
  const key = cacheKey(ref, beeUrl)
  const existing = kvsCache.get(key)
  if (existing) return existing
  const runtime = await loadRuntime()
  // batchId is only needed for writes, but the POT runtime validates its
  // shape at load time — pass an all-zeros 64-hex placeholder for reads.
  const promise = runtime.load(ref, beeUrl, '0'.repeat(64))
  kvsCache.set(key, promise)
  try {
    return await promise
  } catch (err) {
    kvsCache.delete(key)
    throw err
  }
}

export interface PotRefs {
  byNumber: string
  byHash: string
  byTx: string
  byAddress: string
  byBalanceBlock: string
}

export type PotIndex = keyof PotRefs

export interface PotLookupOptions {
  beeUrl: string
  refs: PotRefs
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Look up the 32-byte Swarm reference (hex, no 0x) of the bundle indexed
 * under `key` in the POT KVS identified by `index`.
 *
 * Returns null when the runtime reports a miss. POT's `getRaw` signals
 * misses by throwing or by returning an empty buffer, depending on build —
 * we normalise both to null.
 */
export async function getBundleRef(
  index: PotIndex,
  key: string,
  options: PotLookupOptions,
): Promise<string | null> {
  const ref = options.refs[index]
  if (!/^[0-9a-f]{64}$/.test(ref) || ref === '0'.repeat(64)) return null
  const kvs = await loadKvs(ref, options.beeUrl)
  const potKey = encodeKey(index, key)
  let value: Uint8Array
  try {
    value = await kvs.getRaw(potKey)
  } catch {
    return null
  }
  if (!value || value.length === 0) return null
  if (value.length !== 32) {
    throw new Error(`POT ${index} returned ${value.length} bytes, expected 32`)
  }
  return bytesToHex(value)
}

function encodeKey(index: PotIndex, key: string): number | Uint8Array {
  if (index === 'byNumber' || index === 'byBalanceBlock') {
    const n = Number(key)
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`invalid block number: ${key}`)
    }
    return n
  }
  const normalized = (key.toLowerCase().startsWith('0x') ? key.slice(2) : key).toLowerCase()
  if (index === 'byAddress') {
    if (!/^[0-9a-f]{40}$/.test(normalized)) {
      throw new Error(`invalid address: ${key}`)
    }
    return hexToBytes(normalized)
  }
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid hash: ${key}`)
  }
  return hexToBytes(normalized)
}
