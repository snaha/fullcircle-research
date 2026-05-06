// StreamingMantaray — a wrapper around mantaray-js's MantarayNode that
// supports incremental inserts into an existing manifest without
// pre-hydrating the whole tree. Each mutation hydrates only the spine it
// touches (~5 chunks at mainnet scale), leaving the rest of the tree as
// stub forks identified by their content address.
//
// Wire format is mantaray-js v0.2 unchanged: a tree built or extended via
// StreamingMantaray produces byte-equal root refs to one built via vanilla
// mantaray-js, so existing published manifests remain readable by any
// mantaray-js client and vice versa.

import MantarayJs from 'mantaray-js'
import type { StorageHandler, StorageSaver } from './bee.js'
import { evictBelowDepth } from './evict.js'
import { saveTree } from './save.js'
import { hydrateSpine, loadAndStub, type StorageLoader } from './spine.js'

const { MantarayNode, MantarayFork, Utils } = MantarayJs

type MantarayNodeInstance = InstanceType<typeof MantarayJs.MantarayNode>
type MantarayForkInstance = InstanceType<typeof MantarayJs.MantarayFork>
type Reference = Uint8Array & { length: 32 | 64 }
// mantaray-js brands its 32-byte type as `Bytes<32>` (Uint8Array with
// length narrowed to 32). Plain Uint8Arrays are structurally identical and
// cast through `unknown` to satisfy the brand at the boundary.
type Bytes32 = Uint8Array & { readonly length: 32 }
type MetadataMapping = Record<string, string>

export interface StreamingMantarayOptions {
  /** Eviction depth applied after `save()`. Default 1: keep root + immediate children. */
  evictDepth?: number
  /** Concurrency for chunk uploads inside `save()`. Default 32. */
  saveConcurrency?: number
  /** Optional progress callback during save. */
  onSaveProgress?: (uploaded: number, dirty: number) => void
}

interface ResolvedOptions {
  evictDepth: number
  saveConcurrency: number
  onSaveProgress?: (uploaded: number, dirty: number) => void
}

export class StreamingMantaray {
  private writeChain: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly node: MantarayNodeInstance,
    private readonly loader: StorageLoader,
    private readonly saver: StorageSaver,
    private readonly opts: ResolvedOptions,
  ) {}

  /** Create an empty StreamingMantaray. The first `save()` produces the initial root ref. */
  static create(
    handler: StorageHandler,
    options?: StreamingMantarayOptions & { obfuscationKey?: Uint8Array },
  ): StreamingMantaray {
    const node = new MantarayNode()
    const key =
      options?.obfuscationKey !== undefined
        ? assertBytes32(options.obfuscationKey)
        : Utils.gen32Bytes()
    node.setObfuscationKey = key
    return new StreamingMantaray(node, handler.loader, handler.saver, normaliseOpts(options))
  }

  /**
   * Open an existing manifest for streaming inserts. Loads only the root
   * chunk; descendants stay unhydrated until a mutation walks past them.
   */
  static async open(
    handler: StorageHandler,
    rootRef: Uint8Array,
    options?: StreamingMantarayOptions,
  ): Promise<StreamingMantaray> {
    const node = new MantarayNode()
    await loadAndStub(node, rootRef as Reference, handler.loader)
    return new StreamingMantaray(node, handler.loader, handler.saver, normaliseOpts(options))
  }

  /**
   * Wrap an already-loaded MantarayNode (e.g. one produced by extracting a
   * sub-fork from a parent manifest). Does not load anything; assumes the
   * caller has either materialised the node or is happy to lazy-load on
   * first descent. The caller is responsible for stamping `contentAddress`
   * on the node if it came from a fork stub — otherwise `save()` would
   * re-emit it from scratch instead of short-circuiting.
   */
  static fromNode(
    node: MantarayNodeInstance,
    handler: StorageHandler,
    options?: StreamingMantarayOptions,
  ): StreamingMantaray {
    return new StreamingMantaray(node, handler.loader, handler.saver, normaliseOpts(options))
  }

  /** The underlying MantarayNode. Exposed for advanced operations like
   * mounting under a fresh root before save. */
  get rootNode(): MantarayNodeInstance {
    return this.node
  }

  /** The current saved root ref, or null if the tree is dirty / never saved. */
  get rootRef(): Reference | null {
    return (this.node.getContentAddress as Reference | undefined) ?? null
  }

  async addFork(
    path: Uint8Array,
    entry: Uint8Array,
    metadata: MetadataMapping = {},
  ): Promise<void> {
    return this.runExclusive(async () => {
      await hydrateSpine(this.node, path, this.loader)
      this.node.addFork(path, entry as Reference, metadata)
    })
  }

  async getForkAtPath(path: Uint8Array): Promise<MantarayForkInstance> {
    return this.runExclusive(async () => {
      await hydrateSpine(this.node, path, this.loader)
      return this.node.getForkAtPath(path)
    })
  }

  async removePath(path: Uint8Array): Promise<void> {
    return this.runExclusive(async () => {
      await hydrateSpine(this.node, path, this.loader)
      this.node.removePath(path)
    })
  }

  /**
   * Persist all dirty nodes via the iterative dirty-walk save and return the
   * new root ref. After save, evicts loaded children below
   * `options.evictDepth` so resident memory drops back to the root spine.
   */
  async save(): Promise<Reference> {
    return this.runExclusive(async () => {
      const ref = await saveTree(this.node, {
        saver: this.saver,
        concurrency: this.opts.saveConcurrency,
        onProgress: this.opts.onSaveProgress,
      })
      evictBelowDepth(this.node, this.opts.evictDepth)
      return ref
    })
  }

  // FIFO serialisation across awaits. Reads chain into the same queue as
  // writes so a getForkAtPath() observes the result of a preceding addFork().
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(fn, fn)
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function normaliseOpts(options: StreamingMantarayOptions | undefined): ResolvedOptions {
  return {
    evictDepth: options?.evictDepth ?? 1,
    saveConcurrency: options?.saveConcurrency ?? 32,
    onSaveProgress: options?.onSaveProgress,
  }
}

function assertBytes32(buf: Uint8Array): Bytes32 {
  if (buf.length !== 32) {
    throw new Error(`expected 32-byte buffer, got ${buf.length}`)
  }
  return buf as Bytes32
}

export type { MantarayNodeInstance, MantarayForkInstance, Reference, MetadataMapping }
export { MantarayNode, MantarayFork, Utils }
export { hydrateSpine, loadAndStub, type StorageLoader } from './spine.js'
export { evictBelowDepth } from './evict.js'
export { saveTree, type SaveOptions } from './save.js'
export { beeStorage, type StorageHandler, type StorageSaver } from './bee.js'
