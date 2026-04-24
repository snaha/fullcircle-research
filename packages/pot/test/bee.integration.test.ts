// End-to-end round-trip against a real Bee node. Gated on env so the default
// `pnpm test` still passes with no Bee running.
//
// Run locally with `pnpm bee:start` and `pnpm bee:stamp`, then:
//   BEE_URL=http://127.0.0.1:1633 BEE_STAMP=<batch-id> pnpm test
//
// The test exercises the full pipeline — POT put/save to Bee, fresh KVS from
// the returned reference, get round-trip — so it proves wire-format parity
// between the TS port and the Bee chunk store end-to-end.

import { describe, expect, it } from 'vitest'
import { SwarmKvs } from '../src/kvs.js'
import { BeeLoadSaver } from '../src/persister/index.js'

const BEE_URL = process.env.BEE_URL
const BEE_STAMP = process.env.BEE_STAMP
const enabled = Boolean(BEE_URL && BEE_STAMP)

const describeIf = enabled ? describe : describe.skip

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len)
  for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

describeIf('BeeLoadSaver end-to-end (gated on BEE_URL/BEE_STAMP)', () => {
  it('round-trips a single KVS entry via a real Bee node', async () => {
    const ls = new BeeLoadSaver({ beeUrl: BEE_URL!, postageBatchId: BEE_STAMP! })
    const key = randomBytes(32)
    const value = randomBytes(64)

    const writer = SwarmKvs.create(ls)
    await writer.put(key, value)
    const ref = await writer.save()
    expect(ref.length).toBe(32)
    writer.close()

    const reader = await SwarmKvs.fromReference(ls, ref)
    try {
      const got = await reader.get(key)
      expect(got).toEqual(value)
    } finally {
      reader.close()
    }
  }, 30_000)

  it('round-trips many entries and preserves them across a fresh KVS', async () => {
    const ls = new BeeLoadSaver({ beeUrl: BEE_URL!, postageBatchId: BEE_STAMP! })
    const n = 20
    const entries = Array.from({ length: n }, () => ({
      key: randomBytes(32),
      value: randomBytes(40),
    }))

    const writer = SwarmKvs.create(ls)
    for (const { key, value } of entries) await writer.put(key, value)
    const ref = await writer.save()
    writer.close()

    const reader = await SwarmKvs.fromReference(ls, ref)
    try {
      for (const { key, value } of entries) {
        expect(await reader.get(key)).toEqual(value)
      }
    } finally {
      reader.close()
    }
  }, 60_000)
})
