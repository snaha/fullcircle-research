// Ambient global augmentation for the POT JS runtime
// (vendor/pot/pot-node.js attaches `pot` to globalThis on require).
//
// Only the subset of the API actually used here is modelled; see the potjs
// README for the full surface. Types intentionally live next to the module
// that uses them (see swarm-pot.ts) — this file exists purely to declare the
// global without creating an import cycle.

type PotKey = string | number | boolean | Uint8Array
type PotValue = string | number | boolean | Uint8Array | null

interface PotKvs {
  put(key: PotKey, value: PotValue, timeoutMs?: number): Promise<null>
  get(key: PotKey, timeoutMs?: number): Promise<PotValue>
  putRaw(key: PotKey, value: Uint8Array, timeoutMs?: number): Promise<null>
  getRaw(key: PotKey, timeoutMs?: number): Promise<Uint8Array>
  delete(key: PotKey, timeoutMs?: number): Promise<null>
  save(timeoutMs?: number): Promise<string>
}

interface PotGlobal {
  ready(): Promise<PotGlobal>
  new: (beeUrl?: string, batchId?: string) => Promise<PotKvs>
  load: (ref: string, beeUrl?: string, batchId?: string, timeoutMs?: number) => Promise<PotKvs>
  setVerbosity(level: number): void
  gc(): void
  prune(): void
  purge(): void
}

declare global {
  var pot: PotGlobal
}

export {}
