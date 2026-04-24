import { SingleOrder, SwarmPot } from './elements/index.js'
import type { LoadSaver } from './persister/index.js'
import { Index } from './index.js'
import { SwarmEntry } from './swarm-entry.js'

// SwarmKvs is the high-level key-value API layered on top of an Index+SwarmPot.
// Keys are 32-byte swarm addresses; values are arbitrary byte strings.
export class SwarmKvs {
  private constructor(
    private readonly idx: Index,
    private readonly mode: SwarmPot,
  ) {}

  static create(ls: LoadSaver): SwarmKvs {
    const mode = new SwarmPot(
      new SingleOrder(256),
      ls,
      (key) => new SwarmEntry(key, new Uint8Array(0)),
    )
    const idx = Index.create(mode)
    return new SwarmKvs(idx, mode)
  }

  static async fromReference(ls: LoadSaver, ref: Uint8Array): Promise<SwarmKvs> {
    const mode = new SwarmPot(
      new SingleOrder(256),
      ls,
      (key) => new SwarmEntry(key, new Uint8Array(0)),
    )
    const idx = await Index.fromReference(mode, ref)
    return new SwarmKvs(idx, mode)
  }

  async get(key: Uint8Array): Promise<Uint8Array> {
    const entry = await this.idx.find(key)
    if (!(entry instanceof SwarmEntry)) {
      throw new Error('unexpected entry type in SwarmKvs')
    }
    return entry.value()
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    await this.idx.add(new SwarmEntry(key, value))
  }

  async delete(key: Uint8Array): Promise<void> {
    await this.idx.delete(key)
  }

  async save(): Promise<Uint8Array> {
    return this.idx.save()
  }

  close(): void {
    this.idx.close()
  }
}
