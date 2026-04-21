// Browser bridge to the POT JS runtime.
//
// Loads `/pot-web.js` + `/pot.wasm` (vendored into `static/`) on first use,
// caches loaded KVSs by reference, and exposes `getRefBytes(index, key)` —
// the 32-byte Swarm reference to the block bundle stored under the given
// key in the corresponding KVS.
//
// POT values from this project's uploader are raw 32-byte Swarm references;
// the bundle bytes themselves live at `${beeUrl}/bytes/${ref}`. Keys follow
// the same encoding as `packages/era/src/swarm-pot.ts`:
//   byNumber  key = block number as a JS number (POT serialises to 8-byte BE IEEE-754)
//   byHash    key = 32-byte raw block hash
//   byTx      key = 32-byte raw tx hash

import { browser } from '$app/environment'

interface PotKvs {
  getRaw(key: number | Uint8Array, timeoutMs?: number): Promise<Uint8Array>
}

interface PotGlobal {
  ready(): Promise<PotGlobal>
  load(ref: string, beeUrl?: string, batchId?: string, timeoutMs?: number): Promise<PotKvs>
}

declare global {
  // eslint-disable-next-line no-var
  var pot: PotGlobal | undefined
}

let runtimePromise: Promise<PotGlobal> | null = null

function loadRuntime(): Promise<PotGlobal> {
  if (!browser) return Promise.reject(new Error('POT runtime is browser-only'))
  if (runtimePromise) return runtimePromise
  runtimePromise = new Promise<PotGlobal>((resolve, reject) => {
    if (globalThis.pot?.ready) {
      globalThis.pot
        .ready()
        .then(() => resolve(globalThis.pot as PotGlobal))
        .catch(reject)
      return
    }
    const script = document.createElement('script')
    script.src = '/pot-web.js'
    script.setAttribute('wasm', '/pot.wasm')
    script.async = true
    script.onload = () => {
      if (!globalThis.pot) {
        reject(new Error('pot global was not set after /pot-web.js loaded'))
        return
      }
      globalThis.pot
        .ready()
        .then(() => resolve(globalThis.pot as PotGlobal))
        .catch(reject)
    }
    script.onerror = () => reject(new Error('failed to load /pot-web.js'))
    document.head.appendChild(script)
  })
  return runtimePromise
}

// One-KVS-per-ref cache. `pot.load` re-hydrates from Swarm, so repeating it
// per lookup would be wasteful; keys are the root refs themselves.
const kvsCache = new Map<string, Promise<PotKvs>>()

function cacheKey(ref: string, beeUrl: string): string {
  return `${beeUrl}\x00${ref}`
}

async function loadKvs(ref: string, beeUrl: string): Promise<PotKvs> {
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
  if (index === 'byNumber') {
    const n = Number(key)
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`invalid block number: ${key}`)
    }
    return n
  }
  const normalized = key.toLowerCase().startsWith('0x') ? key.slice(2) : key
  if (!/^[0-9a-f]{64}$/.test(normalized.toLowerCase())) {
    throw new Error(`invalid hash: ${key}`)
  }
  return hexToBytes(normalized)
}
