// Convenience adapter: wrap a `Bee` instance from `@ethersphere/bee-js` into
// the `StorageLoader` / `StorageSaver` pair that StreamingMantaray needs.
// Callers that already maintain their own loader/saver (e.g. an on-disk
// chunk cache that falls through to Bee on miss) should compose those
// directly instead of calling this.

import type { Bee } from '@ethersphere/bee-js'
import type { StorageLoader } from './spine.js'

type Reference = Uint8Array & { length: 32 | 64 }
export type StorageSaver = (data: Uint8Array) => Promise<Reference>

export interface StorageHandler {
  loader: StorageLoader
  saver: StorageSaver
}

export function beeStorage(bee: Bee, batchId: string): StorageHandler {
  const loader: StorageLoader = async (ref: Reference) => {
    const hex = toHex(ref)
    const res = await bee.downloadData(hex)
    return res.toUint8Array()
  }
  const saver: StorageSaver = async (data: Uint8Array) => {
    const res = await bee.uploadData(batchId, data)
    return res.reference.toUint8Array() as Reference
  }
  return { loader, saver }
}

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}
