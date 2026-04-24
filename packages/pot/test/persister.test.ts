import { describe, expect, it } from 'vitest'
import type { TreeNode } from '../src/persister/index.js'
import { InmemLoadSaver, load, save } from '../src/persister/index.js'

const branchbits = 2
const branches = 4
const depth = 3

class MockTreeNode implements TreeNode {
  public ref: Uint8Array | null = null
  public children_: MockTreeNode[] = []
  public val = 0

  constructor(val: number, depthRemaining: number) {
    this.val = val
    if (depthRemaining > 0) {
      const nextVal = val << branchbits
      for (let i = 0; i < branches; i++) {
        this.children_.push(new MockTreeNode(nextVal + i, depthRemaining - 1))
      }
    }
  }

  reference(): Uint8Array | null {
    return this.ref
  }

  setReference(ref: Uint8Array): void {
    this.ref = ref
  }

  async children(f: (tn: TreeNode) => Promise<void>): Promise<void> {
    for (const ch of this.children_) await f(ch)
  }

  marshalBinary(): Uint8Array {
    const buf = new Uint8Array(4 + this.children_.length * 32)
    new DataView(buf.buffer).setUint32(0, this.val >>> 0, false)
    let off = 4
    for (const ch of this.children_) {
      if (!ch.ref) throw new Error('child without ref during marshal')
      buf.set(ch.ref, off)
      off += 32
    }
    return buf
  }

  unmarshalBinary(buf: Uint8Array): void {
    this.val = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false)
    this.children_ = []
    for (let i = 4; i < buf.length; i += 32) {
      const child = new MockTreeNode(0, 0)
      child.ref = buf.slice(i, i + 32)
      this.children_.push(child)
    }
  }
}

async function loadAndCheck(
  ls: InmemLoadSaver,
  n: MockTreeNode,
  expectedVal: number,
): Promise<number> {
  await load(ls, n)
  expect(n.val).toBe(expectedVal)
  const nextVal = expectedVal << branchbits
  let count = 1
  for (let i = 0; i < n.children_.length; i++) {
    count += await loadAndCheck(ls, n.children_[i], nextVal + i)
  }
  return count
}

describe('persister', () => {
  it('round-trips a balanced mock tree via recursive Save+Load', async () => {
    const ls = new InmemLoadSaver()
    const tree = new MockTreeNode(1, depth)
    await save(ls, tree)
    const root = new MockTreeNode(0, 0)
    root.ref = tree.ref
    let sum = 1
    let base = 1
    for (let i = 0; i < depth; i++) {
      base *= branches
      sum += base
    }
    const count = await loadAndCheck(ls, root, 1)
    expect(count).toBe(sum)
  })
})
