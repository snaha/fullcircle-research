// WASM-compat surface: a drop-in replacement for the `globalThis.pot` object
// exposed by the vendored potjs WASM runtime.
//
// Exact behaviour copied from ethersphere/potjs/potjs.go jsToKey / jsToBytes /
// typeEncodedBytes / typeDecodedValue so refs produced by either implementation
// are readable by the other. See `pot-ref/potjs/potjs.go:2268-2559`.

import { SingleOrder, SwarmPot } from './elements/index.js'
import type { FetchImpl } from './persister/bee.js'
import { BeeLoadSaver } from './persister/bee.js'
import { Index } from './index.js'
import { SwarmEntry } from './swarm-entry.js'

export type CompatKey = number | string | Uint8Array
export type CompatValue = number | string | boolean | Uint8Array | null

export interface PotKvsCompat {
  put(key: CompatKey, value: CompatValue): Promise<null>
  get(key: CompatKey): Promise<CompatValue>
  putRaw(key: CompatKey, value: Uint8Array): Promise<null>
  getRaw(key: CompatKey): Promise<Uint8Array>
  delete(key: CompatKey): Promise<null>
  save(): Promise<string>
  close(): void
}

export interface PotGlobalCompat {
  ready(): Promise<PotGlobalCompat>
  new: (beeUrl: string, batchId: string) => Promise<PotKvsCompat>
  load: (ref: string, beeUrl: string, batchId: string) => Promise<PotKvsCompat>
  setVerbosity(level: number): void
  gc(): void
  prune(): void
  purge(): void
}

export interface PotCompatOptions {
  fetch?: FetchImpl
}

// Type-tag bytes — must match potjs.go constants exactly so stored values can
// be decoded by the WASM runtime and vice versa.
const TAG_NULL = 0
const TAG_BOOLEAN = 1
const TAG_NUMBER = 2
const TAG_STRING = 3
const TAG_BYTES = 4

// The WASM runtime uses a 32-byte zero reference to represent "no content" —
// `kvs.save()` on an empty pot returns it, and `pot.load(ref)` with it creates
// a fresh empty KVS instead of fetching. See potjs.go _save / _load.
const ZERO_REF_HEX = '0'.repeat(64)

export function coerceKey(k: CompatKey): Uint8Array {
  let raw: Uint8Array
  if (typeof k === 'number') {
    raw = new Uint8Array(8)
    new DataView(raw.buffer).setFloat64(0, k, false)
  } else if (typeof k === 'string') {
    raw = new TextEncoder().encode(k)
    if (raw.length === 0) throw new Error('empty key string')
    if (raw.length > 32) throw new Error('key string too long')
  } else if (k instanceof Uint8Array) {
    if (k.length === 0) throw new Error('empty key bytes')
    if (k.length > 32) throw new Error('key byte-array too long')
    raw = k
  } else {
    throw new Error(`wrong type for a key: ${typeof k}`)
  }
  if (raw.length === 32) return raw
  const padded = new Uint8Array(32)
  padded.set(raw, 0)
  return padded
}

export function encodeTypedValue(v: CompatValue): Uint8Array {
  if (v === null) return new Uint8Array([TAG_NULL])
  if (typeof v === 'boolean') return new Uint8Array([TAG_BOOLEAN, v ? 1 : 0])
  if (typeof v === 'number') {
    const out = new Uint8Array(9)
    out[0] = TAG_NUMBER
    new DataView(out.buffer).setFloat64(1, v, false)
    return out
  }
  if (typeof v === 'string') {
    const bytes = new TextEncoder().encode(v)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = TAG_STRING
    out.set(bytes, 1)
    return out
  }
  if (v instanceof Uint8Array) {
    const out = new Uint8Array(v.length + 1)
    out[0] = TAG_BYTES
    out.set(v, 1)
    return out
  }
  throw new Error(`unsupported value type: ${typeof v}`)
}

export function decodeTypedValue(b: Uint8Array): CompatValue {
  if (b.length === 0) return null
  switch (b[0]) {
    case TAG_NULL:
      return null
    case TAG_BOOLEAN:
      return b.length >= 2 && b[1] !== 0
    case TAG_NUMBER:
      if (b.length !== 9) throw new Error(`number payload expected 9 bytes, got ${b.length}`)
      return new DataView(b.buffer, b.byteOffset + 1, 8).getFloat64(0, false)
    case TAG_STRING:
      return new TextDecoder().decode(b.subarray(1))
    case TAG_BYTES:
      return b.slice(1)
    default:
      throw new Error(`invalid type tag byte ${b[0]}`)
  }
}

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.toLowerCase().replace(/^0x/, '')
  if (clean.length % 2 !== 0) throw new Error('odd-length hex string')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}

class PotKvsCompatImpl implements PotKvsCompat {
  constructor(private readonly idx: Index) {}

  async putRaw(key: CompatKey, value: Uint8Array): Promise<null> {
    await this.idx.add(new SwarmEntry(coerceKey(key), value))
    return null
  }

  async put(key: CompatKey, value: CompatValue): Promise<null> {
    return this.putRaw(key, encodeTypedValue(value))
  }

  async getRaw(key: CompatKey): Promise<Uint8Array> {
    const entry = await this.idx.find(coerceKey(key))
    if (!(entry instanceof SwarmEntry)) throw new Error('unexpected entry type')
    return entry.value()
  }

  async get(key: CompatKey): Promise<CompatValue> {
    const raw = await this.getRaw(key)
    return decodeTypedValue(raw)
  }

  async delete(key: CompatKey): Promise<null> {
    await this.idx.delete(coerceKey(key))
    return null
  }

  async save(): Promise<string> {
    // Matches the WASM surface: an empty KVS returns a 32-byte zero reference
    // rather than erroring. The underlying Index.save() throws on empty
    // (spec-faithful to Go) — the translation lives here, on the compat seam.
    if (this.idx.size() === 0) return ZERO_REF_HEX
    const ref = await this.idx.save()
    return toHex(ref)
  }

  close(): void {
    this.idx.close()
  }
}

function makeMode(ls: BeeLoadSaver): SwarmPot {
  return new SwarmPot(new SingleOrder(256), ls, (key) => new SwarmEntry(key, new Uint8Array(0)))
}

export function createPotCompat(options: PotCompatOptions = {}): PotGlobalCompat {
  const self: PotGlobalCompat = {
    async ready(): Promise<PotGlobalCompat> {
      return self
    },
    async new(beeUrl: string, batchId: string): Promise<PotKvsCompat> {
      const ls = new BeeLoadSaver({ beeUrl, postageBatchId: batchId, fetch: options.fetch })
      const mode = makeMode(ls)
      return new PotKvsCompatImpl(Index.create(mode))
    },
    async load(ref: string, beeUrl: string, batchId: string): Promise<PotKvsCompat> {
      // WASM parity: a 32-byte zero reference means "no persisted content" —
      // return a fresh empty KVS instead of trying to fetch from Bee.
      if (ref.toLowerCase().replace(/^0x/, '') === ZERO_REF_HEX) {
        return self.new(beeUrl, batchId)
      }
      const ls = new BeeLoadSaver({ beeUrl, postageBatchId: batchId, fetch: options.fetch })
      const mode = makeMode(ls)
      const idx = await Index.fromReference(mode, fromHex(ref))
      return new PotKvsCompatImpl(idx)
    },
    setVerbosity(_level: number): void {},
    gc(): void {},
    prune(): void {},
    purge(): void {},
  }
  return self
}

export function installPotCompat(options: PotCompatOptions = {}): PotGlobalCompat {
  const pot = createPotCompat(options)
  // Cast via `unknown` because downstream packages (e.g. era) already
  // declare an ambient `globalThis.pot` matching the WASM surface, which is
  // structurally close but not identical (e.g. optional beeUrl / batchId).
  ;(globalThis as unknown as { pot: PotGlobalCompat }).pot = pot
  return pot
}
