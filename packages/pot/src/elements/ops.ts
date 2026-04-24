import type { CNode, Entry, Mode, Node } from './types.js'
import { isEmpty } from './types.js'
import { newAt, cnodeNext } from './node.js'
import { appendRange, findFork, findNext } from './pot.js'

export const MaxDepth = 256

// Wedge: splice `m` into `n`'s structure at `m.at`, pinning `n`'s entry to `acc`.
export function wedge(acc: Node, n: CNode, m: CNode): void {
  if (!n.node) throw new Error('wedge: n.node is nil')
  appendRange(acc, n.node, n.at, m.at)
  if (!isEmpty(m.node)) acc.append(m)
  appendRange(acc, n.node, m.at + 1, MaxDepth)
  const e = n.node.entry()
  if (e) acc.pin(e)
}

// Whirl: splice `n` under `m`, pinning `m`'s entry to `acc`.
export function whirl(acc: Node, n: CNode, m: CNode): void {
  if (!n.node) throw new Error('whirl: n.node is nil')
  if (!m.node) throw new Error('whirl: m.node is nil')
  appendRange(acc, n.node, n.at, m.at)
  acc.append(newAt(m.at, n.node))
  const e = m.node.entry()
  if (e) acc.pin(e)
}

// Whack: replace n at m.at with m's subtree children, pinning m's entry to acc.
export function whack(acc: Node, n: CNode, m: CNode): void {
  if (!n.node) throw new Error('whack: n.node is nil')
  if (!m.node) throw new Error('whack: m.node is nil')
  appendRange(acc, n.node, n.at, m.at)
  if (m.at < MaxDepth) acc.append(newAt(m.at, n.node))
  appendRange(acc, m.node, m.at + 1, MaxDepth)
  const e = m.node.entry()
  if (e) acc.pin(e)
}

export async function update(
  acc: Node,
  cn: CNode,
  k: Uint8Array,
  entry: Entry | null,
  mode: Mode,
): Promise<Node | null> {
  const u = await updateInner(acc, cn, k, entry, mode)
  if (u != null) await mode.pack(u)
  return u
}

async function updateInner(
  acc: Node,
  cn: CNode,
  k: Uint8Array,
  entry: Entry | null,
  mode: Mode,
): Promise<Node | null> {
  if (isEmpty(cn.node)) {
    if (entry == null) return null
    acc.pin(entry)
    return acc
  }
  const { next: cm, match } = await findNext(cn, k, mode)
  if (match) {
    if (entry == null) {
      return pull(acc, cn, mode)
    }
    const orig = cn.node.entry()
    if (orig && entry.equal(orig)) return null
    const n = mode.newNode()
    n.pin(entry)
    whack(acc, cn, newAt(mode.depth(), n))
    return acc
  }
  if (isEmpty(cm.node)) {
    if (entry == null) return null
    const n = mode.newNode()
    n.pin(entry)
    whirl(acc, cn, newAt(cm.at, n))
    return acc
  }
  if (cm.at === 0) {
    const res = await updateInner(acc, cm, k, entry, mode)
    const cmRes = newAt(-1, res)
    if (cmRes.node == null) {
      wedge(acc, cn, newAt(0, null))
      return acc
    }
    if (mode.down(cmRes)) {
      const fresh = mode.newNode()
      wedge(fresh, cn, cmRes)
      return fresh
    }
    const n = mode.newNode()
    whack(n, cmRes, cn)
    return n
  }
  if (mode.down(cm)) {
    const res = await updateInner(mode.newNode(), cm, k, entry, mode)
    wedge(acc, cn, newAt(cm.at, res))
    return acc
  }
  whirl(acc, cn, cm)
  return updateInner(acc, cnodeNext(cm), k, entry, mode)
}

// Pull: node removal and restructuring.
export function pull(acc: Node, cn: CNode, mode: Mode): Node {
  if (mode.up() != null) {
    // custom up policy not yet implemented
    throw new Error('mode.up() custom policy not implemented')
  }
  const cm = findFork(cn, null)
  if (!isEmpty(cm.node)) {
    wedge(acc, cn, newAt(cm.at, null))
    return pullTail(acc, cnodeNext(cm), mode)
  }
  const j = cn.at - 1
  const parentFork = acc.fork(j)
  acc.truncate(j)
  if (parentFork.node == null) {
    // singleton case: empty pot
    return mode.newNode()
  }
  wedge(acc, parentFork, newAt(j, null))
  return acc
}

function pullTail(acc: Node, cn: CNode, mode: Mode): Node {
  const cm = findFork(cn, null)
  if (isEmpty(cm.node)) {
    wedge(acc, cn, newAt(mode.depth(), null))
    return acc
  }
  whirl(acc, cn, cm)
  return pullTail(acc, cnodeNext(cm), mode)
}
