import type { CNode, Entry, Mode, Node } from './types.js'
import { MemNode } from './node.js'
import { newAt } from './node.js'
import { update as genericUpdate } from './ops.js'

// SingleOrder is the default in-memory mode — no persistence hooks, standard insertion policy.
export class SingleOrder implements Mode {
  constructor(private readonly depthBits: number) {}

  depth(): number {
    return this.depthBits
  }

  newNode(): Node {
    return new MemNode()
  }

  async pack(_n: Node | null): Promise<void> {}
  async unpack(_n: Node | null): Promise<void> {}

  down(_cn: CNode): boolean {
    return false
  }

  up(): ((cn: CNode) => boolean) | null {
    return null
  }

  async save(): Promise<Uint8Array | null> {
    return null
  }

  async load(_ref: Uint8Array): Promise<{ node: Node; loaded: boolean }> {
    return { node: this.newNode(), loaded: false }
  }

  async update(root: Node, k: Uint8Array, e: Entry | null): Promise<Node | null> {
    return genericUpdate(this.newNode(), newAt(0, root), k, e, this)
  }
}
