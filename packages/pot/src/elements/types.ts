export class ErrNotFound extends Error {
  constructor(message = 'not found') {
    super(message)
    this.name = 'ErrNotFound'
  }
}

export function isErrNotFound(err: unknown): err is ErrNotFound {
  return err instanceof ErrNotFound
}

export interface Entry {
  key(): Uint8Array
  equal(other: Entry): boolean
  marshalBinary(): Uint8Array
  unmarshalBinary(buf: Uint8Array): void
  toString(): string
}

export interface Node {
  pin(e: Entry): void
  entry(): Entry | null
  empty(): boolean
  size(): number
  fork(po: number): CNode
  append(cn: CNode): void
  truncate(po: number): void
  iterate(from: number, f: (cn: CNode) => boolean | void): void
  toString(): string
}

export interface CNode {
  readonly at: number
  readonly node: Node | null
  readonly size: number
}

export interface Mode {
  depth(): number
  newNode(): Node
  pack(n: Node | null): Promise<void>
  unpack(n: Node | null): Promise<void>
  down(cn: CNode): boolean
  up(): ((cn: CNode) => boolean) | null
  load(ref: Uint8Array): Promise<{ node: Node; loaded: boolean }>
  save(): Promise<Uint8Array | null>
  update(root: Node, k: Uint8Array, e: Entry | null): Promise<Node | null>
}

export function isEmpty(n: Node | null | undefined): n is null {
  return n == null || n.empty()
}
