import { createHash } from 'node:crypto'
import type { Entry } from '../src/elements/index.js'

export class MockEntry implements Entry {
  constructor(
    private readonly k: Uint8Array,
    public val: number,
  ) {}

  key(): Uint8Array {
    return this.k
  }

  toString(): string {
    return String(this.val)
  }

  equal(other: Entry): boolean {
    return other instanceof MockEntry && this.val === other.val
  }

  marshalBinary(): Uint8Array {
    const buf = new Uint8Array(32)
    new DataView(buf.buffer).setUint32(28, this.val, false)
    return buf
  }

  unmarshalBinary(buf: Uint8Array): void {
    this.val = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(28, false)
  }
}

export function newDetMockEntry(n: number): MockEntry {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, n, false)
  const digest = createHash('sha256').update(buf).digest()
  return new MockEntry(new Uint8Array(digest), n)
}

export function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function entriesEqual(a: MockEntry, b: MockEntry): boolean {
  return keysEqual(a.key(), b.key()) && a.val === b.val
}
