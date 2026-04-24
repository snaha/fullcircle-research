// Compat ↔ WASM parity, exercising the same API shape era / explorer use.
//
// Gated on BEE_URL + BEE_STAMP. Verifies that a POT written via `createPotCompat`
// can be read via the WASM runtime (and vice versa) using the era-style
// putRaw(numberKey, refBytes) + explorer-style getRaw(numberKey) pattern.

import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeAll } from 'vitest'
import { createPotCompat } from '../src/compat.js'

type PotKey = number | string | Uint8Array
interface PotKvs {
  putRaw(key: PotKey, value: Uint8Array): Promise<null>
  getRaw(key: PotKey): Promise<Uint8Array>
  save(): Promise<string>
}
interface PotGlobal {
  ready(): Promise<PotGlobal>
  new: (beeUrl: string, batchId: string) => Promise<PotKvs>
  load: (ref: string, beeUrl: string, batchId: string) => Promise<PotKvs>
}

const BEE_URL = process.env.BEE_URL
const BEE_STAMP = process.env.BEE_STAMP
const enabled = Boolean(BEE_URL && BEE_STAMP)
const describeIf = enabled ? describe : describe.skip

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len)
  for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

async function loadWasm(): Promise<PotGlobal> {
  const g = globalThis as { crypto?: unknown; potVerbosity?: number; pot?: PotGlobal }
  if (!g.crypto) g.crypto = webcrypto
  g.potVerbosity = 0
  if (!g.pot) {
    const here = dirname(fileURLToPath(import.meta.url))
    const potNodePath = resolve(here, '../../era/vendor/pot/pot-node.js')
    const req = createRequire(import.meta.url)
    req(potNodePath)
  }
  if (!g.pot) throw new Error('WASM pot did not attach globalThis.pot')
  await g.pot.ready()
  return g.pot
}

describeIf('compat ↔ WASM parity (gated on BEE_URL/BEE_STAMP)', () => {
  let wasm: PotGlobal

  beforeAll(async () => {
    wasm = await loadWasm()
  })

  it('compat writer → WASM reader: era-style number/bytes keys round-trip', async () => {
    const pot = createPotCompat()
    const kvs = await pot.new(BEE_URL!, BEE_STAMP!)
    const numberEntries = Array.from({ length: 5 }, (_, i) => ({
      key: 1000 + i,
      value: randomBytes(32),
    }))
    const bytesEntries = Array.from({ length: 5 }, () => ({
      key: randomBytes(32),
      value: randomBytes(32),
    }))
    for (const { key, value } of numberEntries) await kvs.putRaw(key, value)
    for (const { key, value } of bytesEntries) await kvs.putRaw(key, value)
    const refHex = await kvs.save()
    kvs.close()

    const reader = await wasm.load(refHex, BEE_URL!, BEE_STAMP!)
    for (const { key, value } of numberEntries) {
      const got = await reader.getRaw(key)
      expect(new Uint8Array(got)).toEqual(value)
    }
    for (const { key, value } of bytesEntries) {
      const got = await reader.getRaw(key)
      expect(new Uint8Array(got)).toEqual(value)
    }
  }, 60_000)

  it('WASM writer → compat reader: same keys retrieve the same bytes', async () => {
    const writer = await wasm.new(BEE_URL!, BEE_STAMP!)
    const numberEntries = Array.from({ length: 5 }, (_, i) => ({
      key: 2000 + i,
      value: randomBytes(32),
    }))
    const bytesEntries = Array.from({ length: 5 }, () => ({
      key: randomBytes(32),
      value: randomBytes(32),
    }))
    for (const { key, value } of numberEntries) await writer.putRaw(key, value)
    for (const { key, value } of bytesEntries) await writer.putRaw(key, value)
    const refHex = await writer.save()

    const pot = createPotCompat()
    const reader = await pot.load(refHex, BEE_URL!, BEE_STAMP!)
    try {
      for (const { key, value } of numberEntries) {
        expect(await reader.getRaw(key)).toEqual(value)
      }
      for (const { key, value } of bytesEntries) {
        expect(await reader.getRaw(key)).toEqual(value)
      }
    } finally {
      reader.close()
    }
  }, 60_000)

  it('compat writer → compat reader, typed put/get round-trip for all value shapes', async () => {
    const pot = createPotCompat()
    const kvs = await pot.new(BEE_URL!, BEE_STAMP!)
    await kvs.put(1, null)
    await kvs.put(2, true)
    await kvs.put(3, false)
    await kvs.put(4, 3.14)
    await kvs.put(5, 'hello')
    await kvs.put(6, new Uint8Array([1, 2, 3]))
    const refHex = await kvs.save()
    kvs.close()

    const reader = await pot.load(refHex, BEE_URL!, BEE_STAMP!)
    try {
      expect(await reader.get(1)).toBe(null)
      expect(await reader.get(2)).toBe(true)
      expect(await reader.get(3)).toBe(false)
      expect(await reader.get(4)).toBe(3.14)
      expect(await reader.get(5)).toBe('hello')
      expect(await reader.get(6)).toEqual(new Uint8Array([1, 2, 3]))
    } finally {
      reader.close()
    }
  }, 60_000)
})
