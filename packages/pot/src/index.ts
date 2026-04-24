import type { Entry, Mode, Node } from './elements/index.js'
import { find as elementsFind, iterate as elementsIterate, newAt } from './elements/index.js'
import { Mutex } from './mutex.js'

// Index is a mutable POT.
//
// Unlike the Go reference, which uses channels to arbitrate read/write access across
// goroutines, this TS port relies on the single-threaded event loop plus a FIFO mutex
// that serialises write operations across `await` boundaries. Reads observe the current
// root atomically and traverse structurally-shared nodes with no locking.
export class Index {
  private root: Node
  private readonly writeMutex = new Mutex()
  private closed = false

  private constructor(
    private readonly mode: Mode,
    root: Node,
  ) {
    this.root = root
  }

  static create(mode: Mode): Index {
    return new Index(mode, mode.newNode())
  }

  static async fromReference(mode: Mode, ref: Uint8Array): Promise<Index> {
    const { node, loaded } = await mode.load(ref)
    if (!loaded) throw new Error('root not loaded from persistent storage')
    return new Index(mode, node)
  }

  async add(entry: Entry): Promise<void> {
    await this.update(entry.key(), entry)
  }

  async delete(key: Uint8Array): Promise<void> {
    await this.update(key, null)
  }

  async update(key: Uint8Array, entry: Entry | null): Promise<void> {
    if (this.closed) throw new Error('index closed')
    await this.writeMutex.run(async () => {
      const updated = await this.mode.update(this.root, key, entry)
      if (updated != null) this.root = updated
    })
  }

  async find(key: Uint8Array): Promise<Entry> {
    if (this.closed) throw new Error('index closed')
    return elementsFind(this.root, key, this.mode)
  }

  async iterate(
    prefix: Uint8Array | null,
    pivot: Uint8Array,
    f: (e: Entry) => Promise<boolean | void> | boolean | void,
  ): Promise<void> {
    if (this.closed) throw new Error('index closed')
    return elementsIterate(newAt(0, this.root), prefix, pivot, this.mode, f)
  }

  size(): number {
    if (this.closed) return 0
    return this.root.size()
  }

  async save(): Promise<Uint8Array> {
    if (this.closed) throw new Error('index closed')
    if (this.root.empty()) throw new Error('root node is nil')
    const ref = await this.mode.save()
    if (!ref) throw new Error('mode.save returned null')
    return ref
  }

  close(): void {
    this.closed = true
  }

  toString(): string {
    return newAt(0, this.root).node?.toString() ?? 'nil'
  }
}

export * from './elements/index.js'
export { SwarmEntry } from './swarm-entry.js'
export { SwarmKvs } from './kvs.js'
export type { BeeLoadSaverOptions, FetchImpl, LoadSaver, TreeNode } from './persister/index.js'
export { BeeLoadSaver, InmemLoadSaver } from './persister/index.js'
export type {
  CompatKey,
  CompatValue,
  PotCompatOptions,
  PotGlobalCompat,
  PotKvsCompat,
} from './compat.js'
export {
  coerceKey,
  createPotCompat,
  decodeTypedValue,
  encodeTypedValue,
  installPotCompat,
} from './compat.js'
