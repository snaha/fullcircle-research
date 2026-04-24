import type { TreeNode } from '../persister/persister.js'
import type { CNode, Entry } from './types.js'
import { MemNode } from './node.js'

// SwarmNode extends MemNode with a persistable reference and binary encoding. A
// node carrying only a reference (no pin, no forks) is considered "packed" — it
// must be unpacked via mode.unpack before its content can be inspected.
export class SwarmNode extends MemNode implements TreeNode {
  private ref: Uint8Array | null

  constructor(
    readonly newEntry: (key: Uint8Array) => Entry,
    ref: Uint8Array | null = null,
  ) {
    super()
    this.ref = ref
  }

  reference(): Uint8Array | null {
    return this.ref
  }

  setReference(ref: Uint8Array): void {
    this.ref = ref
  }

  // A node is "packed" if it carries a reference but no in-memory content yet.
  needsUnpack(): boolean {
    return this.ref != null && this.pinned == null && this.forks.length === 0
  }

  async children(f: (tn: TreeNode) => Promise<void>): Promise<void> {
    for (const cn of this.forks) {
      const child = cn.node as SwarmNode
      await f(child)
    }
  }

  marshalBinary(): Uint8Array | null {
    const entry = this.entry()
    if (entry == null) return null
    const valueBytes = entry.marshalBinary()
    const keyBytes = entry.key()
    if (keyBytes.length !== 32) {
      throw new Error(`invalid key size for Swarm Pot Node: ${keyBytes.length}`)
    }
    const bitMap = new Uint8Array(32)
    const setBitMap = (n: number): void => {
      // Note: the Go spec reads `1 << ((7 - n) % 8)` with n as uint8, so the
      // subtraction wraps into [0, 255] before the modulo. In JS `-5 % 8 === -5`,
      // which would shift by a negative count — use `7 - (n % 8)` instead; it's
      // the same position within the byte for any n >= 0.
      bitMap[Math.floor(n / 8)] |= 1 << (7 - (n % 8))
    }
    const forkRefs: Uint8Array[] = []
    const forkSizes: Uint8Array[] = []
    const sbuf = new Uint8Array(4)
    const sview = new DataView(sbuf.buffer)
    for (const cn of this.forks) {
      setBitMap(cn.at)
      const childRef = (cn.node as SwarmNode).reference()
      if (!childRef) throw new Error(`unreferenced child at po=${cn.at}`)
      forkRefs.push(childRef)
      sview.setUint32(0, cn.size, false)
      forkSizes.push(new Uint8Array(sbuf))
    }
    const c = this.forks.length
    const forkRefsBytes = concatMany(forkRefs)
    let forkSizesBytes = concatMany(forkSizes)
    const taken = forkSizesBytes.length % 32
    if (taken > 0) {
      const padded = new Uint8Array(forkSizesBytes.length + (32 - taken))
      padded.set(forkSizesBytes, 0)
      forkSizesBytes = padded
    }
    const out = new Uint8Array(32 + 32 + c * 32 + forkSizesBytes.length + valueBytes.length)
    let off = 0
    out.set(keyBytes, off)
    off += 32
    out.set(bitMap, off)
    off += 32
    out.set(forkRefsBytes, off)
    off += forkRefsBytes.length
    out.set(forkSizesBytes, off)
    off += forkSizesBytes.length
    out.set(valueBytes, off)
    return out
  }

  unmarshalBinary(buf: Uint8Array): void {
    this.forks = []
    const keyBytes = buf.subarray(0, 32)
    const bitMap = buf.subarray(32, 64)
    const frLength = 32
    let c = 0
    const poMap: number[] = []
    for (let i = 0; i < 256; i++) {
      if (bitMap[Math.floor(i / 8)] & (1 << (7 - (i % 8)))) {
        poMap.push(i)
        c++
      }
    }
    const sview = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    for (let i = 0; i < c; i++) {
      const forkRef = buf.slice(64 + i * frLength, 64 + (i + 1) * frLength)
      const size = sview.getUint32(64 + c * frLength + i * 4, false)
      const cn: CNode = {
        at: poMap[i],
        node: new SwarmNode(this.newEntry, forkRef),
        size,
      }
      this.forks.push(cn)
    }
    const taken = (c * 4) % 32
    const padding = taken > 0 ? 32 - taken : 0
    const offset = 64 + c * frLength + c * 4 + padding
    const elementBytes = buf.subarray(offset)
    const e = this.newEntry(new Uint8Array(keyBytes))
    e.unmarshalBinary(elementBytes)
    this.pin(e)
  }
}

function concatMany(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
