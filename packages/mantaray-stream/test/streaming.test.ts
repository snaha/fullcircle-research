// Verify that streaming inserts into an existing manifest don't load the
// whole tree. This is the entire reason the wrapper exists — if it fails,
// we've reintroduced the loadAllNodes wall.

import MantarayJs from 'mantaray-js'
import { describe, expect, it } from 'vitest'
import { StreamingMantaray } from '../src/index.js'
import { ZERO_KEY, bytesEq, key, seedRef, InmemStore } from './helpers.js'

const { MantarayNode } = MantarayJs

type Reference = Uint8Array & { length: 32 | 64 }

describe('streaming insert', () => {
  it('extending a large manifest loads only the spine', async () => {
    // Build a 500-entry tree the vanilla way.
    const initial: Array<[string, Uint8Array]> = []
    for (let i = 0; i < 500; i++) {
      initial.push([`tx/${i.toString().padStart(6, '0')}`, seedRef(`tx${i}`)])
    }

    const store = new InmemStore()
    const handler = store.handler()
    const seedRoot = new MantarayNode()
    seedRoot.setObfuscationKey = ZERO_KEY
    for (const [k, v] of initial) seedRoot.addFork(key(k), v as Reference)
    const seededRef = await seedRoot.save(handler.saver)
    const totalChunks = store.size()
    expect(totalChunks).toBeGreaterThan(50)

    // Now reopen via streaming and add 5 fresh entries. The number of
    // loads must be tiny relative to the tree size — proof we're not
    // hydrating it all.
    store.loads = 0
    store.saves = 0

    const stream = await StreamingMantaray.open(store.handler(), seededRef)
    const additional: Array<[string, Uint8Array]> = [
      ['tx/000600', seedRef('newA')],
      ['tx/000601', seedRef('newB')],
      ['tx/000602', seedRef('newC')],
      ['tx/000603', seedRef('newD')],
      ['tx/000604', seedRef('newE')],
    ]
    for (const [k, v] of additional) await stream.addFork(key(k), v)
    const newRoot = await stream.save()

    // Reads cap: at most "depth" loads per addFork, plus the initial root
    // load. For ~500 keys with byte fan-out, depth is small (3-5). So well
    // under the total chunk count.
    expect(store.loads).toBeLessThan(totalChunks / 4)

    // Reference: build the combined set the vanilla way and compare roots.
    const refStore = new InmemStore()
    const refRoot = new MantarayNode()
    refRoot.setObfuscationKey = ZERO_KEY
    for (const [k, v] of [...initial, ...additional]) {
      refRoot.addFork(key(k), v as Reference)
    }
    const refRef = await refRoot.save(refStore.handler().saver)
    expect(bytesEq(newRoot, refRef)).toBe(true)
  })

  it('eviction frees memory after save', async () => {
    // Build a tree with enough entries to produce depth >= 2, save, then
    // walk the in-memory tree to confirm nodes at depth >= 2 are stubs
    // (forks=undefined) while their refs are intact for lazy reload.
    const store = new InmemStore()
    const stream = StreamingMantaray.create(store.handler(), { obfuscationKey: ZERO_KEY })
    for (let i = 0; i < 500; i++) {
      await stream.addFork(key(`k${i.toString().padStart(6, '0')}`), seedRef(`v${i}`))
    }
    await stream.save()

    // Count nodes by depth that still have populated forks.
    const root = stream.rootNode
    let deepStillLoaded = 0
    let deepTotal = 0
    function walk(node: { forks?: Record<number, { node: typeof node }> }, depth: number): void {
      if (!node.forks) return
      for (const fork of Object.values(node.forks)) {
        if (depth >= 2) {
          deepTotal++
          if (fork.node.forks !== undefined) deepStillLoaded++
        }
        walk(fork.node, depth + 1)
      }
    }
    walk(root, 1)

    expect(deepTotal).toBeGreaterThan(0)
    // At depth 2 and below every node should be a stub. (Default
    // evictDepth=1 keeps root + immediate children's fork tables; nukes
    // everything past that.)
    expect(deepStillLoaded).toBe(0)

    // Stubs should still carry contentAddress so the next descent can
    // lazy-load them.
    let stubsWithRef = 0
    let stubsWithoutRef = 0
    if (root.forks) {
      for (const top of Object.values(root.forks)) {
        if (top.node.forks) {
          for (const stub of Object.values(top.node.forks)) {
            if (stub.node.getContentAddress) stubsWithRef++
            else stubsWithoutRef++
          }
        }
      }
    }
    expect(stubsWithRef).toBeGreaterThan(0)
    expect(stubsWithoutRef).toBe(0)
  })

  it('repeated save with no new entries returns same root and uploads nothing new', async () => {
    const store = new InmemStore()
    const stream = StreamingMantaray.create(store.handler(), { obfuscationKey: ZERO_KEY })
    for (let i = 0; i < 50; i++) {
      await stream.addFork(key(`x${i}`), seedRef(`v${i}`))
    }
    const r1 = await stream.save()
    const savesAfterFirst = store.saves

    const r2 = await stream.save()
    expect(bytesEq(r1, r2)).toBe(true)
    expect(store.saves).toBe(savesAfterFirst) // no new uploads
  })
})
