// Verify the wrapper produces byte-equal output to vanilla mantaray-js.
//
// The streaming path (StreamingMantaray) and the non-streaming path
// (raw MantarayNode + loadAllNodes) must converge on the same root ref for
// the same set of insertions. If they diverge, downstream consumers
// (explorer, /bzz/<root>/<path>) cannot interoperate between code paths.

import MantarayJs from 'mantaray-js'
import { describe, expect, it } from 'vitest'
import { StreamingMantaray } from '../src/index.js'
import { ZERO_KEY, bytesEq, key, seedRef, InmemStore } from './helpers.js'

const { MantarayNode, loadAllNodes } = MantarayJs

type Reference = Uint8Array & { length: 32 | 64 }

// Build a vanilla mantaray-js tree, save it, return its root ref.
async function buildVanilla(
  entries: ReadonlyArray<[string, Uint8Array]>,
  store: InmemStore,
): Promise<Uint8Array> {
  const handler = store.handler()
  const root = new MantarayNode()
  root.setObfuscationKey = ZERO_KEY
  for (const [k, v] of entries) {
    root.addFork(key(k), v as Reference)
  }
  return root.save(handler.saver)
}

describe('roundtrip vs mantaray-js', () => {
  it('empty + create-from-scratch produces equal root ref', async () => {
    const store = new InmemStore()
    const entries: Array<[string, Uint8Array]> = [
      ['number/1', seedRef('block-1')],
      ['number/2', seedRef('block-2')],
      ['number/3', seedRef('block-3')],
    ]

    const vanillaRef = await buildVanilla(entries, new InmemStore())

    const stream = StreamingMantaray.create(store.handler(), { obfuscationKey: ZERO_KEY })
    for (const [k, v] of entries) await stream.addFork(key(k), v)
    const streamRef = await stream.save()

    expect(bytesEq(streamRef, vanillaRef)).toBe(true)
  })

  it('open-then-extend matches build-from-scratch', async () => {
    // First run: build with entries A, save, get root_A.
    // Second run: open root_A streaming, add entries B, save, get root_AB.
    // Reference: build with A + B from scratch, save, get root_ref.
    // root_AB must equal root_ref.

    const initial: Array<[string, Uint8Array]> = [
      ['number/100', seedRef('b100')],
      ['number/101', seedRef('b101')],
      ['number/102', seedRef('b102')],
      ['hash/abc', seedRef('habc')],
      ['hash/def', seedRef('hdef')],
    ]
    const additional: Array<[string, Uint8Array]> = [
      ['number/103', seedRef('b103')],
      ['number/104', seedRef('b104')],
      ['hash/123', seedRef('h123')],
      ['tx/0001', seedRef('t0001')],
    ]
    const all = [...initial, ...additional]

    // Reference root: everything at once.
    const refRoot = await buildVanilla(all, new InmemStore())

    // Streaming path: save initial, reopen, add extras, save.
    const store = new InmemStore()
    const phase1 = StreamingMantaray.create(store.handler(), { obfuscationKey: ZERO_KEY })
    for (const [k, v] of initial) await phase1.addFork(key(k), v)
    const root1 = await phase1.save()

    const phase2 = await StreamingMantaray.open(store.handler(), root1)
    for (const [k, v] of additional) await phase2.addFork(key(k), v)
    const root2 = await phase2.save()

    expect(bytesEq(root2, refRoot)).toBe(true)
  })

  it('reads via getForkAtPath find the right entry', async () => {
    const entries: Array<[string, Uint8Array]> = [
      ['number/1', seedRef('v1')],
      ['number/2', seedRef('v2')],
      ['hash/aa', seedRef('vaa')],
    ]
    const store = new InmemStore()
    const stream = StreamingMantaray.create(store.handler(), { obfuscationKey: ZERO_KEY })
    for (const [k, v] of entries) await stream.addFork(key(k), v)
    const root = await stream.save()

    // Reopen fresh so reads exercise the lazy spine.
    const reopened = await StreamingMantaray.open(store.handler(), root)
    for (const [k, v] of entries) {
      const fork = await reopened.getForkAtPath(key(k))
      const entry = fork.node.getEntry
      expect(entry).toBeDefined()
      expect(bytesEq(entry as Uint8Array, v)).toBe(true)
    }
  })

  it('round-trips against vanilla loadAllNodes after streaming save', async () => {
    // Strict structural equivalence: the chunks the streaming path produced
    // can be opened and fully traversed by vanilla mantaray-js.
    const entries: Array<[string, Uint8Array]> = []
    for (let i = 0; i < 64; i++) {
      entries.push([`tx/${i.toString().padStart(4, '0')}`, seedRef(`tx${i}`)])
    }
    const store = new InmemStore()
    const stream = StreamingMantaray.create(store.handler(), { obfuscationKey: ZERO_KEY })
    for (const [k, v] of entries) await stream.addFork(key(k), v)
    const root = await stream.save()

    const handler = store.handler()
    const vanilla = new MantarayNode()
    await vanilla.load(handler.loader, root as Reference)
    await loadAllNodes(handler.loader, vanilla)

    for (const [k, v] of entries) {
      const fork = vanilla.getForkAtPath(key(k))
      expect(bytesEq(fork.node.getEntry as Uint8Array, v)).toBe(true)
    }
  })
})
