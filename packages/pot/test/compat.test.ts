import { describe, expect, it } from 'vitest'
import { coerceKey, createPotCompat, decodeTypedValue, encodeTypedValue } from '../src/compat.js'

describe('compat key coercion', () => {
  it('encodes a number as 8-byte BE IEEE-754 padded to 32 bytes', () => {
    const out = coerceKey(42)
    expect(out.length).toBe(32)
    const view = new DataView(out.buffer, out.byteOffset, 8)
    expect(view.getFloat64(0, false)).toBe(42)
    // remaining bytes are zero
    for (let i = 8; i < 32; i++) expect(out[i]).toBe(0)
  })

  it('encodes fractional numbers identically to Go math.Float64bits', () => {
    // 3.14 in IEEE-754 big-endian
    const out = coerceKey(3.14)
    expect(Array.from(out.slice(0, 8))).toEqual([0x40, 0x09, 0x1e, 0xb8, 0x51, 0xeb, 0x85, 0x1f])
  })

  it('treats 0 and -0 as distinct per IEEE-754 sign bit', () => {
    const zero = coerceKey(0)
    const negZero = coerceKey(-0)
    expect(zero[0]).toBe(0)
    expect(negZero[0]).toBe(0x80)
  })

  it('UTF-8 encodes strings and pads to 32 bytes', () => {
    const out = coerceKey('hi')
    expect(out.length).toBe(32)
    expect(out[0]).toBe(0x68)
    expect(out[1]).toBe(0x69)
    for (let i = 2; i < 32; i++) expect(out[i]).toBe(0)
  })

  it('passes 32-byte Uint8Array through unchanged', () => {
    const k = new Uint8Array(32)
    for (let i = 0; i < 32; i++) k[i] = i
    const out = coerceKey(k)
    expect(out).toEqual(k)
  })

  it('pads short Uint8Array with zeros', () => {
    const k = new Uint8Array([1, 2, 3])
    const out = coerceKey(k)
    expect(out.length).toBe(32)
    expect(Array.from(out.slice(0, 3))).toEqual([1, 2, 3])
    for (let i = 3; i < 32; i++) expect(out[i]).toBe(0)
  })

  it('rejects empty strings / bytes / oversized inputs', () => {
    expect(() => coerceKey('')).toThrow(/empty key/)
    expect(() => coerceKey(new Uint8Array(0))).toThrow(/empty key/)
    expect(() => coerceKey(new Uint8Array(33))).toThrow(/too long/)
    expect(() => coerceKey('a'.repeat(33))).toThrow(/too long/)
  })
})

describe('compat typed-value encode/decode', () => {
  it('null round-trips via single tag byte', () => {
    const enc = encodeTypedValue(null)
    expect(enc).toEqual(new Uint8Array([0]))
    expect(decodeTypedValue(enc)).toBe(null)
  })

  it('booleans round-trip', () => {
    expect(decodeTypedValue(encodeTypedValue(true))).toBe(true)
    expect(decodeTypedValue(encodeTypedValue(false))).toBe(false)
    expect(encodeTypedValue(true)).toEqual(new Uint8Array([1, 1]))
    expect(encodeTypedValue(false)).toEqual(new Uint8Array([1, 0]))
  })

  it('numbers round-trip as 9 bytes with BE float64 payload', () => {
    const enc = encodeTypedValue(1234.5)
    expect(enc.length).toBe(9)
    expect(enc[0]).toBe(2)
    expect(decodeTypedValue(enc)).toBe(1234.5)
  })

  it('strings round-trip via UTF-8', () => {
    const enc = encodeTypedValue('héllo ✨')
    expect(enc[0]).toBe(3)
    expect(decodeTypedValue(enc)).toBe('héllo ✨')
  })

  it('Uint8Array round-trips', () => {
    const v = new Uint8Array([9, 8, 7, 6, 5])
    const enc = encodeTypedValue(v)
    expect(enc[0]).toBe(4)
    expect(decodeTypedValue(enc)).toEqual(v)
  })

  it('decoder rejects unknown tag bytes', () => {
    expect(() => decodeTypedValue(new Uint8Array([99]))).toThrow(/invalid type tag/)
  })

  it('decoder rejects truncated number payloads', () => {
    expect(() => decodeTypedValue(new Uint8Array([2, 0, 0]))).toThrow(/number payload/)
  })
})

describe('compat pot global object shape', () => {
  it('ready() resolves to itself', async () => {
    const pot = createPotCompat()
    await expect(pot.ready()).resolves.toBe(pot)
  })

  it('setVerbosity/gc/prune/purge are no-ops', () => {
    const pot = createPotCompat()
    expect(() => pot.setVerbosity(0)).not.toThrow()
    expect(() => pot.gc()).not.toThrow()
    expect(() => pot.prune()).not.toThrow()
    expect(() => pot.purge()).not.toThrow()
  })
})
