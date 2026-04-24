import type { CNode, Entry, Node } from './types.js'
import { isEmpty } from './types.js'

export function newAt(at: number, n: Node | null): CNode {
  if (isEmpty(n)) return { at, node: null, size: 0 }
  let size = 1
  n.iterate(at + 1, (c) => {
    size += c.size
  })
  return { at, node: n, size }
}

export function cnodeNext(c: CNode): CNode {
  if (c.node == null) return { at: c.at + 1, node: null, size: 0 }
  const forkAtCur = c.node.fork(c.at)
  return { at: c.at + 1, node: c.node, size: c.size - forkAtCur.size }
}

export class MemNode implements Node {
  protected forks: CNode[] = []
  protected pinned: Entry | null = null

  pin(e: Entry): void {
    this.pinned = e
  }

  entry(): Entry | null {
    return this.pinned
  }

  empty(): boolean {
    return this.pinned == null
  }

  size(): number {
    if (this.empty()) return 0
    return newAt(-1, this).size
  }

  fork(po: number): CNode {
    for (const cn of this.forks) {
      if (cn.at === po) return cn
      if (cn.at > po) break
    }
    return { at: po, node: null, size: 0 }
  }

  append(cn: CNode): void {
    this.forks.push(cn)
  }

  truncate(po: number): void {
    let j = 0
    for (const cn of this.forks) {
      if (cn.at >= po) break
      j++
    }
    if (j < this.forks.length) this.forks = this.forks.slice(0, j)
  }

  iterate(from: number, f: (cn: CNode) => boolean | void): void {
    for (const cn of this.forks) {
      if (cn.at >= from) {
        if (f(cn) === true) return
      }
    }
  }

  toString(): string {
    return cnodeString(newAt(-1, this), 0)
  }
}

export function keyOf(n: Node | null): Uint8Array | null {
  if (isEmpty(n)) return null
  const e = n.entry()
  return e ? e.key() : null
}

export function label(k: Uint8Array | null): string {
  if (!k || k.length === 0) return 'none'
  const view = new DataView(k.buffer, k.byteOffset, Math.min(4, k.byteLength))
  const val = view.getUint32(0, false)
  return val.toString(2).padStart(32, '0')
}

function cnodeString(c: CNode, depth: number): string {
  if (depth > 20) return '...'
  if (c.node == null) return 'nil'
  let s = `K: ${label(keyOf(c.node))}, V: ${c.node.entry()?.toString() ?? 'nil'}\n`
  const indent = '  '.repeat(depth)
  c.node.iterate(c.at + 1, (child) => {
    s += `${indent}> ${child.at} (${child.size}) - ${cnodeString(child, depth + 1)}`
  })
  return s
}
