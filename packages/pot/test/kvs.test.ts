import { describe, expect, it } from 'vitest'
import { SwarmKvs } from '../src/kvs.js'
import { InmemLoadSaver } from '../src/persister/index.js'
import { ErrNotFound } from '../src/elements/index.js'

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len)
  for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

function keyValuePair(): { key: Uint8Array; val: Uint8Array } {
  const valLen = Math.floor(Math.random() * 79) + 22
  return { key: randomBytes(32), val: randomBytes(valLen) }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('SwarmKvs.save', () => {
  it('saving an empty KVS returns an error', async () => {
    const ls = new InmemLoadSaver()
    const s = SwarmKvs.create(ls)
    try {
      await expect(s.save()).rejects.toThrow()
    } finally {
      s.close()
    }
  })

  it('saving a non-empty KVS returns a valid swarm reference', async () => {
    const ls = new InmemLoadSaver()
    const s = SwarmKvs.create(ls)
    try {
      const { key, val } = keyValuePair()
      await s.put(key, val)
      const ref = await s.save()
      expect(ref.length).toBe(32)
    } finally {
      s.close()
    }
  })

  it('roundtrips a single entry via a fresh reference-backed KVS', async () => {
    const ls = new InmemLoadSaver()
    const s1 = SwarmKvs.create(ls)
    const { key, val } = keyValuePair()
    await s1.put(key, val)
    const ref = await s1.save()
    s1.close()

    const s2 = await SwarmKvs.fromReference(ls, ref)
    try {
      const got = await s2.get(key)
      expect(bytesEqual(got, val)).toBe(true)
    } finally {
      s2.close()
    }
  })

  it('supports adding entries post-save and reading them via the new tree', async () => {
    const ls = new InmemLoadSaver()
    const { key: k1, val: v1 } = keyValuePair()
    const { key: k2, val: v2 } = keyValuePair()

    const kvs1 = SwarmKvs.create(ls)
    await kvs1.put(k1, v1)
    const ref = await kvs1.save()
    kvs1.close()

    const kvs2 = await SwarmKvs.fromReference(ls, ref)
    try {
      await kvs2.put(k2, v2)
      const got = await kvs2.get(k2)
      expect(bytesEqual(got, v2)).toBe(true)
    } finally {
      kvs2.close()
    }
  })

  it('delete then reload-from-saved-ref brings back the pre-delete state', async () => {
    const ls = new InmemLoadSaver()
    const { key, val } = keyValuePair()
    const kvs1 = SwarmKvs.create(ls)

    await kvs1.put(key, val)
    expect(bytesEqual(await kvs1.get(key), val)).toBe(true)
    const ref = await kvs1.save()
    await kvs1.delete(key)
    await expect(kvs1.get(key)).rejects.toBeInstanceOf(ErrNotFound)
    kvs1.close()

    const kvs2 = await SwarmKvs.fromReference(ls, ref)
    try {
      expect(bytesEqual(await kvs2.get(key), val)).toBe(true)
    } finally {
      kvs2.close()
    }
  })

  it('round-trips two items via reference', async () => {
    const ls = new InmemLoadSaver()
    const { key: k1, val: v1 } = keyValuePair()
    const { key: k2, val: v2 } = keyValuePair()

    const kvs1 = SwarmKvs.create(ls)
    await kvs1.put(k1, v1)
    await kvs1.put(k2, v2)
    const ref = await kvs1.save()
    kvs1.close()

    const kvs2 = await SwarmKvs.fromReference(ls, ref)
    try {
      expect(bytesEqual(await kvs2.get(k1), v1)).toBe(true)
      expect(bytesEqual(await kvs2.get(k2), v2)).toBe(true)
    } finally {
      kvs2.close()
    }
  })

  it('close after create+put+save is a no-op', async () => {
    const ls = new InmemLoadSaver()
    const { key, val } = keyValuePair()
    const kvs1 = SwarmKvs.create(ls)
    await kvs1.put(key, val)
    await kvs1.save()
    expect(() => kvs1.close()).not.toThrow()
  })
})
