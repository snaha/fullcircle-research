import type { Entry } from './elements/index.js'

// SwarmEntry is the default Entry shape used by SwarmKvs: a 32-byte key and an
// arbitrary-length byte value.
export class SwarmEntry implements Entry {
  constructor(
    private readonly k: Uint8Array,
    private v: Uint8Array,
  ) {}

  static create(key: Uint8Array, value: Uint8Array): SwarmEntry {
    return new SwarmEntry(key, value)
  }

  key(): Uint8Array {
    return this.k
  }

  value(): Uint8Array {
    return this.v
  }

  equal(other: Entry): boolean {
    if (!(other instanceof SwarmEntry)) return false
    if (this.v.length !== other.v.length) return false
    for (let i = 0; i < this.v.length; i++) if (this.v[i] !== other.v[i]) return false
    return true
  }

  marshalBinary(): Uint8Array {
    return this.v
  }

  unmarshalBinary(buf: Uint8Array): void {
    this.v = buf
  }

  toString(): string {
    return `key: ${toHex(this.k)}; val: ${toHex(this.v)}`
  }
}

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}
