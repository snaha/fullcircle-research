import type { LoadSaver } from '../persister/persister.js'
import { load, save } from '../persister/persister.js'
import type { CNode, Entry, Mode, Node } from './types.js'
import { newAt } from './node.js'
import { update as genericUpdate } from './ops.js'
import { SwarmNode } from './swarm-node.js'

// SwarmPot wraps another Mode with on-disk persistence backed by a LoadSaver.
// Each node materialises lazily on read and is serialised on update via Pack.
export class SwarmPot implements Mode {
  private root: SwarmNode

  constructor(
    private readonly inner: Mode,
    private readonly ls: LoadSaver,
    private readonly newEntry: (key: Uint8Array) => Entry,
  ) {
    this.root = new SwarmNode(newEntry)
  }

  depth(): number {
    return this.inner.depth()
  }

  newNode(): Node {
    return new SwarmNode(this.newEntry)
  }

  down(cn: CNode): boolean {
    return this.inner.down(cn)
  }

  up(): ((cn: CNode) => boolean) | null {
    return this.inner.up()
  }

  async pack(n: Node | null): Promise<void> {
    if (n == null) return
    await save(this.ls, n as SwarmNode)
  }

  async unpack(n: Node | null): Promise<void> {
    if (n == null) return
    const sn = n as SwarmNode
    if (!sn.needsUnpack()) return
    await load(this.ls, sn)
  }

  async load(ref: Uint8Array): Promise<{ node: Node; loaded: boolean }> {
    const root = new SwarmNode(this.newEntry, ref)
    await load(this.ls, root)
    this.root = root
    return { node: root, loaded: true }
  }

  async save(): Promise<Uint8Array | null> {
    if (this.root.empty()) throw new Error('node is nil')
    await save(this.ls, this.root)
    return this.root.reference()
  }

  async update(root: Node, k: Uint8Array, e: Entry | null): Promise<Node | null> {
    const updated = await genericUpdate(this.newNode(), newAt(0, root), k, e, this)
    if (updated != null) this.root = updated as SwarmNode
    return updated
  }
}
