import { describe, expect, it } from 'vitest'
import { Index } from '../src/index.js'
import { ErrNotFound, SingleOrder, SwarmPot } from '../src/elements/index.js'
import type { Entry, Mode } from '../src/elements/index.js'
import { InmemLoadSaver } from '../src/persister/index.js'
import { MockEntry, entriesEqual, newDetMockEntry } from './helpers.js'

const makeSwarmMode = (depth: number): Mode =>
  new SwarmPot(new SingleOrder(depth), new InmemLoadSaver(), (key) => new MockEntry(key, 0))

const basePotMode = new SingleOrder(256)

async function checkFound(idx: Index, want: MockEntry): Promise<void> {
  const e = await idx.find(want.key())
  expect(e).toBeInstanceOf(MockEntry)
  expect(entriesEqual(e as MockEntry, want)).toBe(true)
}

async function checkNotFound(idx: Index, want: MockEntry): Promise<void> {
  await expect(idx.find(want.key())).rejects.toBeInstanceOf(ErrNotFound)
}

describe('Index.Update correctness', () => {
  it('exercises the full Add/Delete/Modify matrix on two entries', async () => {
    const idx = Index.create(basePotMode)
    try {
      const want = newDetMockEntry(0)
      const want2 = newDetMockEntry(1)

      // not found on empty index
      await checkNotFound(idx, want)

      // add item to empty index and find it
      await idx.add(want)
      await checkFound(idx, want)

      // add same item and find no change
      await idx.add(want)
      await checkFound(idx, want)

      // delete item and not find it
      await idx.delete(want.key())
      await checkNotFound(idx, want)

      // add 2 items to empty index and find them
      await idx.add(want)
      await checkFound(idx, want)
      await idx.add(want2)
      await checkFound(idx, want)
      await checkFound(idx, want2)

      // delete first item and not find it
      await idx.delete(want.key())
      await checkNotFound(idx, want)
      await checkFound(idx, want2)

      // once again add first item and find both
      await idx.add(want)
      await checkFound(idx, want2)
      await checkFound(idx, want)

      // delete latest added item and find only item 2
      await idx.delete(want.key())
      await checkFound(idx, want2)
      await checkNotFound(idx, want)

      // modify item
      const wantMod = new MockEntry(want.key(), want.val + 1)
      const want2Mod = new MockEntry(want2.key(), want2.val + 1)
      await idx.add(want)
      await checkFound(idx, want)
      await checkFound(idx, want2)
      await idx.add(wantMod)
      await checkFound(idx, wantMod)
      await checkFound(idx, want2)
      await idx.add(want2Mod)
      await checkFound(idx, wantMod)
      await checkFound(idx, want2Mod)
    } finally {
      idx.close()
    }
  })
})

describe('Index edge-case correctness', () => {
  it('deleting a middle-inserted entry still finds the last one (ints 0,1,2)', async () => {
    const idx = Index.create(basePotMode)
    try {
      const ints = [0, 1, 2]
      const entries = ints.map((n) => newDetMockEntry(n))
      for (const e of entries) await idx.add(e)
      await idx.delete(entries[1].key())
      await checkNotFound(idx, entries[1])
      await checkFound(idx, entries[2])
    } finally {
      idx.close()
    }
  })

  it('deleting a middle-inserted entry preserves the others (ints 5,4,7,8)', async () => {
    const idx = Index.create(basePotMode)
    try {
      const ints = [5, 4, 7, 8]
      const entries = ints.map((n) => newDetMockEntry(n))
      for (const e of entries) await idx.add(e)
      await idx.delete(entries[1].key())
      await checkFound(idx, entries[2])
      await checkFound(idx, entries[0])
      await checkFound(idx, entries[3])
    } finally {
      idx.close()
    }
  })

  it('no duplication on add/delete mix (ints 3,0,2,1)', async () => {
    const idx = Index.create(basePotMode)
    try {
      const ints = [3, 0, 2, 1]
      const entries = ints.map((n) => newDetMockEntry(n))
      for (const e of entries) await idx.add(e)
      await idx.delete(entries[2].key())
      await checkFound(idx, entries[0])
      await checkFound(idx, entries[1])
      await checkFound(idx, entries[3])
      await checkNotFound(idx, entries[2])
    } finally {
      idx.close()
    }
  })

  it('delete root entry (ints 6,7)', async () => {
    const idx = Index.create(basePotMode)
    try {
      const ints = [6, 7]
      const entries = ints.map((n) => newDetMockEntry(n))
      for (const e of entries) await idx.add(e)
      await idx.delete(entries[0].key())
      await checkFound(idx, entries[1])
      await checkNotFound(idx, entries[0])
    } finally {
      idx.close()
    }
  })
})

describe('Index.Size', () => {
  const count = 16

  const runSizeTest = async (idx: Index): Promise<void> => {
    // add
    for (let i = 0; i < count; i++) {
      expect(idx.size()).toBe(i)
      await idx.add(newDetMockEntry(i))
    }
    // update
    for (let i = 0; i < count; i++) {
      await idx.add(new MockEntry(newDetMockEntry(i).key(), 10000))
      expect(idx.size()).toBe(count)
    }
    // delete
    for (let i = 0; i < count; i++) {
      await idx.delete(newDetMockEntry(i).key())
      expect(idx.size()).toBe(count - i - 1)
    }
  }

  it('in memory', async () => {
    const idx = Index.create(basePotMode)
    try {
      await runSizeTest(idx)
    } finally {
      idx.close()
    }
  })

  it('persisted', async () => {
    const idx = Index.create(makeSwarmMode(256))
    try {
      await runSizeTest(idx)
    } finally {
      idx.close()
    }
  })
})

describe('Index.Iterate', () => {
  const count = 64

  const runIterateTest = async (idx: Index): Promise<void> => {
    const pivot = new Uint8Array(4)
    for (let e = 0; e < 3; e++) {
      const b = e * 256
      const full = new Uint8Array(4)
      new DataView(full.buffer).setUint32(0, b, false)
      const prefix = full.slice(0, 3)

      const r: number[] = []
      for (let i = 0; i < count; i++) r.push(i)
      for (let i = r.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[r[i], r[j]] = [r[j], r[i]]
      }

      for (let i = 0; i < count; i++) {
        const k = new Uint8Array(32)
        new DataView(k.buffer).setUint32(0, b + r[i], false)
        await idx.add(new MockEntry(k, b + r[i]))

        let n = 0
        let max = 0
        await idx.iterate(prefix, pivot, (entry: Entry) => {
          const item = (entry as MockEntry).val
          if (max > item) {
            throw new Error(`not ordered correctly: ${max} > ${item}`)
          }
          max = item
          n++
          return false
        })
        expect(n).toBe(i + 1)
      }

      let n = 0
      await idx.iterate(null, pivot, () => {
        n++
        return false
      })
      expect(n).toBe((e + 1) * count)
    }
  }

  it('in memory', async () => {
    const idx = Index.create(new SingleOrder(32))
    try {
      await runIterateTest(idx)
    } finally {
      idx.close()
    }
  })

  it('persisted', async () => {
    const idx = Index.create(makeSwarmMode(32))
    try {
      await runIterateTest(idx)
    } finally {
      idx.close()
    }
  })
})

describe('Index concurrency', () => {
  const runConcurrencyTest = async (idx: Index): Promise<void> => {
    const workers = 4
    const count = 250
    const queue: number[] = []
    const writers: Promise<void>[] = []
    for (let k = 0; k < workers; k++) {
      writers.push(
        (async () => {
          for (let i = 0; i < count; i++) {
            const j = i * workers + k
            const e = newDetMockEntry(j)
            await idx.add(e)
            await idx.find(e.key())
            queue.push(j)
          }
        })(),
      )
    }
    const deleters: Promise<void>[] = []
    for (let k = 0; k < workers - 1; k++) {
      deleters.push(
        (async () => {
          for (let i = 0; i < count; i++) {
            while (queue.length === 0) await new Promise((r) => setImmediate(r))
            const j = queue.shift() as number
            const e = newDetMockEntry(j)
            await idx.delete(e.key())
            await expect(idx.find(e.key())).rejects.toBeInstanceOf(ErrNotFound)
          }
        })(),
      )
    }
    await Promise.all([...writers, ...deleters])

    const entered = new Set<number>()
    while (queue.length > 0) {
      const j = queue.shift() as number
      await checkFound(idx, newDetMockEntry(j))
      entered.add(j)
    }
    for (let i = 0; i < workers * count; i++) {
      if (entered.has(i)) continue
      await expect(idx.find(newDetMockEntry(i).key())).rejects.toBeInstanceOf(ErrNotFound)
    }
  }

  it('in memory', async () => {
    const idx = Index.create(basePotMode)
    try {
      await runConcurrencyTest(idx)
    } finally {
      idx.close()
    }
  })

  it('persisted', async () => {
    const idx = Index.create(makeSwarmMode(256))
    try {
      await runConcurrencyTest(idx)
    } finally {
      idx.close()
    }
  })
})

describe('persistence — re-adding into a second empty ls yields the same lookup results', () => {
  it('reproduces index_test.go TestPersistence', async () => {
    const count = 200
    const mkMode = (): Mode =>
      new SwarmPot(new SingleOrder(256), new InmemLoadSaver(), (key) => new MockEntry(key, 0))

    let idx = Index.create(mkMode())
    for (let i = 0; i < count; i++) await idx.add(newDetMockEntry(i))
    idx.close()

    idx = Index.create(mkMode())
    try {
      for (let i = 0; i < count + 10; i++) await idx.add(newDetMockEntry(i))
      for (let i = 0; i < count + 10; i++) await checkFound(idx, newDetMockEntry(i))
    } finally {
      idx.close()
    }
  })
})
