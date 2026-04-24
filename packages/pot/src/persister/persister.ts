export interface LoadSaver {
  load(reference: Uint8Array): Promise<Uint8Array>
  save(data: Uint8Array): Promise<Uint8Array>
}

export interface TreeNode {
  reference(): Uint8Array | null
  setReference(ref: Uint8Array): void
  children(f: (tn: TreeNode) => Promise<void>): Promise<void>
  marshalBinary(): Uint8Array | null
  unmarshalBinary(buf: Uint8Array): void
}

// Load reads a node's binary form from the LoadSaver at its stored reference and
// deserialises it in place.
export async function load(ls: LoadSaver, n: TreeNode): Promise<void> {
  const ref = n.reference()
  if (!ref) throw new Error('load: node has no reference')
  const buf = await ls.load(ref)
  n.unmarshalBinary(buf)
}

// Save recursively persists a tree: children first, then the node itself. A node
// that already has a reference is skipped.
export async function save(ls: LoadSaver, n: TreeNode): Promise<void> {
  const existing = n.reference()
  if (existing && existing.length > 0) return
  await n.children(async (child) => {
    await save(ls, child)
  })
  const bytes = n.marshalBinary()
  if (!bytes) return
  const ref = await ls.save(bytes)
  n.setReference(ref)
}

// InmemLoadSaver is a content-addressed in-memory store used for tests. References
// are SHA-256 digests of the data; the Go reference uses BMT hashing on Swarm
// chunks, but any collision-resistant hash is sufficient for algorithmic tests.
export class InmemLoadSaver implements LoadSaver {
  private store = new Map<string, Uint8Array>()

  async load(reference: Uint8Array): Promise<Uint8Array> {
    if (reference.length !== 32) {
      throw new Error(`reference must be 32 bytes, got ${reference.length}`)
    }
    const key = toHex(reference)
    const data = this.store.get(key)
    if (!data) throw new Error('reference not found')
    return data
  }

  async save(data: Uint8Array): Promise<Uint8Array> {
    // Cast via unknown: `lib.dom.d.ts` BufferSource before TS 5.7 doesn't
    // recognise `Uint8Array<ArrayBufferLike>`, but node/browser subtle accepts it.
    const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
    const ref = new Uint8Array(digest)
    this.store.set(toHex(ref), data)
    return ref
  }
}

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}
