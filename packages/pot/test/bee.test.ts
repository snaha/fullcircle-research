import { describe, expect, it, vi } from 'vitest'
import { BeeLoadSaver } from '../src/persister/bee.js'

const ZERO_BATCH_ID = '0'.repeat(64)
const SAMPLE_REF = 'a'.repeat(64)
const SAMPLE_REF_BYTES = new Uint8Array(32).fill(0xaa)

describe('BeeLoadSaver.save', () => {
  it('POSTs to /bytes with the postage batch header and octet body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reference: SAMPLE_REF }), { status: 201 }),
    )
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633',
      postageBatchId: ZERO_BATCH_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const data = new Uint8Array([1, 2, 3, 4])
    const ref = await ls.save(data)
    expect(ref).toEqual(SAMPLE_REF_BYTES)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://bee.local:1633/bytes')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['swarm-postage-batch-id']).toBe(ZERO_BATCH_ID)
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(init.body).toBe(data)
  })

  it('accepts a Uint8Array postage batch id', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reference: SAMPLE_REF }), { status: 201 }),
    )
    const batchId = new Uint8Array(32).fill(0x42)
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633',
      postageBatchId: batchId,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await ls.save(new Uint8Array([0]))
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['swarm-postage-batch-id']).toBe('42'.repeat(32))
  })

  it('throws when Bee returns a non-201 status', async () => {
    const fetchImpl = vi.fn(async () => new Response('stamp not usable', { status: 402 }))
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633',
      postageBatchId: ZERO_BATCH_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(ls.save(new Uint8Array([1]))).rejects.toThrow(/status 402/)
  })

  it('throws when the returned reference is the wrong length', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reference: 'deadbeef' }), { status: 201 }),
    )
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633',
      postageBatchId: ZERO_BATCH_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(ls.save(new Uint8Array([1]))).rejects.toThrow(/invalid reference/)
  })
})

describe('BeeLoadSaver.load', () => {
  it('GETs /bytes/{hex} and returns raw bytes', async () => {
    const body = new Uint8Array([7, 8, 9])
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }))
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633/',
      postageBatchId: ZERO_BATCH_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const got = await ls.load(SAMPLE_REF_BYTES)
    expect(got).toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith(`http://bee.local:1633/bytes/${SAMPLE_REF}`)
  })

  it('rejects references that are not exactly 32 bytes', async () => {
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633',
      postageBatchId: ZERO_BATCH_ID,
      fetch: vi.fn() as unknown as typeof fetch,
    })
    await expect(ls.load(new Uint8Array(16))).rejects.toThrow(/must be 32 bytes/)
  })

  it('throws when Bee returns a non-200 status', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const ls = new BeeLoadSaver({
      beeUrl: 'http://bee.local:1633',
      postageBatchId: ZERO_BATCH_ID,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(ls.load(SAMPLE_REF_BYTES)).rejects.toThrow(/status 404/)
  })
})

describe('BeeLoadSaver config validation', () => {
  it('rejects non-http URLs', () => {
    expect(
      () =>
        new BeeLoadSaver({
          beeUrl: 'ftp://bee.local',
          postageBatchId: ZERO_BATCH_ID,
        }),
    ).toThrow(/http or https/)
  })

  it('rejects malformed postage batch ids', () => {
    expect(
      () =>
        new BeeLoadSaver({
          beeUrl: 'http://bee.local:1633',
          postageBatchId: 'deadbeef',
        }),
    ).toThrow(/postage batch id/)
  })
})
