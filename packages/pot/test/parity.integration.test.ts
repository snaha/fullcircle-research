// Wire-format parity check between the TS port and the WASM POT runtime.
//
// Gated on BEE_URL + BEE_STAMP; loads the vendored WASM from @fullcircle/era.
// Two round-trips:
//   (A) TS writer → WASM reader
//   (B) WASM writer → TS reader
//
// Both use the same Bee node for storage, so a pass proves the SwarmNode
// binary layout is byte-compatible with the Go implementation the WASM wraps.

import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeAll } from 'vitest'
import { SwarmKvs } from '../src/kvs.js'
import { BeeLoadSaver } from '../src/persister/index.js'

type PotKey = string | number | boolean | Uint8Array
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

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.toLowerCase().replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  return out
}

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len)
  for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

async function loadWasmRuntime(): Promise<PotGlobal> {
  const g = globalThis as { crypto?: unknown; potVerbosity?: number; pot?: PotGlobal }
  if (!g.crypto) g.crypto = webcrypto
  g.potVerbosity = 0
  if (!g.pot) {
    const here = dirname(fileURLToPath(import.meta.url))
    const potNodePath = resolve(here, '../../era/vendor/pot/pot-node.js')
    const req = createRequire(import.meta.url)
    req(potNodePath)
  }
  if (!g.pot) throw new Error('WASM runtime did not attach globalThis.pot')
  await g.pot.ready()
  return g.pot
}

describeIf('wire-format parity TS ↔ WASM (gated on BEE_URL/BEE_STAMP)', () => {
  let wasm: PotGlobal

  beforeAll(async () => {
    wasm = await loadWasmRuntime()
  })

  it('TS writer → WASM reader: values round-trip unchanged', async () => {
    const ls = new BeeLoadSaver({ beeUrl: BEE_URL!, postageBatchId: BEE_STAMP! })
    const entries = Array.from({ length: 5 }, () => ({
      key: randomBytes(32),
      value: randomBytes(48),
    }))

    const writer = SwarmKvs.create(ls)
    for (const { key, value } of entries) await writer.put(key, value)
    const ref = await writer.save()
    writer.close()

    const kvs = await wasm.load(toHex(ref), BEE_URL!, BEE_STAMP!)
    for (const { key, value } of entries) {
      const got = await kvs.getRaw(key)
      expect(new Uint8Array(got)).toEqual(value)
    }
  }, 60_000)

  it('WASM writer → TS reader: values round-trip unchanged', async () => {
    const kvs = await wasm.new(BEE_URL!, BEE_STAMP!)
    const entries = Array.from({ length: 5 }, () => ({
      key: randomBytes(32),
      value: randomBytes(48),
    }))
    for (const { key, value } of entries) await kvs.putRaw(key, value)
    const refHex = await kvs.save()

    const ls = new BeeLoadSaver({ beeUrl: BEE_URL!, postageBatchId: BEE_STAMP! })
    const reader = await SwarmKvs.fromReference(ls, fromHex(refHex))
    try {
      for (const { key, value } of entries) {
        const got = await reader.get(key)
        expect(got).toEqual(value)
      }
    } finally {
      reader.close()
    }
  }, 60_000)
})
