declare module 'snappyjs' {
  export function uncompress(input: Uint8Array): Uint8Array
  export function compress(input: Uint8Array): Uint8Array
  const _default: { uncompress: typeof uncompress; compress: typeof compress }
  export default _default
}
