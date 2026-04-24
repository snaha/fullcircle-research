import type { CNode, Entry, Mode, Node } from './types.js'
import { ErrNotFound, isEmpty } from './types.js'
import { newAt } from './node.js'

// PO returns the proximity order of two byte sequences starting the comparison at bit `pos`.
// The PO is the bit position of the first differing bit; equal sequences yield `other.length * 8`.
export function PO(one: Uint8Array, other: Uint8Array, pos: number): number {
  for (let i = Math.floor(pos / 8); i < one.length && i < other.length; i++) {
    if (one[i] === other[i]) continue
    const oxo = one[i] ^ other[i]
    const start = i === Math.floor(pos / 8) ? pos % 8 : 0
    for (let j = start; j < 8; j++) {
      if ((oxo >> (7 - j)) & 0x01) return i * 8 + j
    }
  }
  return other.length * 8
}

export function compare(n: Node, k: Uint8Array, at: number): number {
  const e = n.entry()
  if (!e) throw new Error('compare on empty node')
  return PO(e.key(), k, at)
}

// Copies forks of `src` with at in [from, to) onto `dst`, truncating `dst` at `from` first.
export function appendRange(dst: Node, src: Node, from: number, to: number): void {
  dst.truncate(from)
  src.iterate(from, (k) => {
    if (k.at < to) {
      dst.append(k)
      return false
    }
    return true
  })
}

export function slice(n: Node, from: number, to: number): CNode[] {
  const out: CNode[] = []
  n.iterate(from, (c) => {
    if (c.at >= to) return true
    out.push(c)
    return false
  })
  return out
}

export async function find(n: Node | null, k: Uint8Array, mode: Mode): Promise<Entry> {
  return findInner(newAt(0, n), k, mode)
}

async function findInner(n: CNode, k: Uint8Array, mode: Mode): Promise<Entry> {
  if (isEmpty(n.node)) throw new ErrNotFound()
  const { next, match } = await findNext(n, k, mode)
  if (match) {
    const e = n.node.entry()
    if (!e) throw new ErrNotFound()
    return e
  }
  return findInner(next, k, mode)
}

export interface FindNextResult {
  next: CNode
  match: boolean
}

export async function findNext(n: CNode, k: Uint8Array, mode: Mode): Promise<FindNextResult> {
  if (!n.node) return { next: newAt(mode.depth(), null), match: true }
  const po = compare(n.node, k, n.at)
  if (po < mode.depth() && po < 8 * k.length) {
    const cn = n.node.fork(po)
    await mode.unpack(cn.node)
    return { next: cn, match: false }
  }
  return { next: newAt(mode.depth(), null), match: true }
}

// Iterate walks entries in the subtree rooted at the node whose key matches prefix `p`,
// emitting them in ascending proximity-order distance from `k`.
export async function iterate(
  n: CNode,
  p: Uint8Array | null,
  k: Uint8Array,
  mode: Mode,
  f: (e: Entry) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  const m = await findNode(n, p ?? new Uint8Array(0), mode)
  if (isEmpty(m.node)) return
  await iterateInner(m, k, mode, f)
}

async function iterateInner(
  n: CNode,
  k: Uint8Array,
  mode: Mode,
  f: (e: Entry) => Promise<boolean | void> | boolean | void,
): Promise<boolean> {
  // When iterating a tree loaded from persistence, child CNodes surfaced via
  // Slice (siblings of the descent fork) come back in their packed form.
  // Eagerly unpack before any content access so empty()/size()/entry() are valid.
  await mode.unpack(n.node)
  if (isEmpty(n.node)) return false
  if (n.size === 1) {
    const e = n.node.entry()
    if (!e) return false
    return (await f(e)) === true
  }
  const po = compare(n.node, k, n.at + 1)
  const cn = n.node.fork(po)
  await mode.unpack(cn.node)

  const forks: CNode[] = [...slice(n.node, n.at + 1, cn.at), newAt(cn.at, n.node), cn]
  for (let i = forks.length - 1; i >= 0; i--) {
    if (await iterateInner(forks[i], k, mode, f)) return true
  }
  return false
}

async function findNode(n: CNode, k: Uint8Array, mode: Mode): Promise<CNode> {
  if (isEmpty(n.node)) throw new ErrNotFound()
  const { next, match } = await findNext(n, k, mode)
  if (match) return newAt(8 * k.length, n.node)
  return findNode(next, k, mode)
}

// FindFork iterates forks and returns the one for which `stop(m)` returns true,
// or the last fork if `stop` is null.
export function findFork(n: CNode, stop: ((cn: CNode) => boolean) | null): CNode {
  let m: CNode = { at: 0, node: null, size: 0 }
  if (!n.node) return m
  n.node.iterate(n.at, (c) => {
    if (!stop) {
      m = c
      return false
    }
    return stop(m)
  })
  return m
}
