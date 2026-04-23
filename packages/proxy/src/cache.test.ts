import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UploadCache } from './cache.js'

describe('UploadCache', () => {
  let dir: string
  let cache: UploadCache

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-test-'))
    cache = new UploadCache(join(dir, 'cache.db'))
  })

  afterEach(() => {
    cache.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('hashBody is deterministic for identical bytes', () => {
    const body = Buffer.from('hello swarm')
    expect(UploadCache.hashBody(body).equals(UploadCache.hashBody(body))).toBe(true)
    expect(UploadCache.hashBody(Buffer.from('other')).equals(UploadCache.hashBody(body))).toBe(
      false,
    )
  })

  it('filterHeaders strips hop-by-hop + volatile headers', () => {
    const filtered = UploadCache.filterHeaders({
      'swarm-reference': 'abc',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      date: 'some-date',
      'content-length': '100',
      'content-type': 'application/octet-stream',
    })
    expect(filtered).toEqual({
      'swarm-reference': 'abc',
      'content-type': 'application/octet-stream',
    })
  })

  it('filterHeaders joins array values with comma', () => {
    const filtered = UploadCache.filterHeaders({ vary: ['a', 'b'] })
    expect(filtered.vary).toBe('a, b')
  })

  it('store + lookup roundtrip', () => {
    const body = Buffer.from('payload')
    const hash = UploadCache.hashBody(body)
    cache.store(hash, 'batch1', '/bytes', {
      status: 201,
      headers: { 'swarm-reference': 'deadbeef' },
      body: Buffer.from('response'),
    })
    const found = cache.lookup(hash, 'batch1', '/bytes')
    expect(found).not.toBeNull()
    expect(found!.status).toBe(201)
    expect(found!.headers).toEqual({ 'swarm-reference': 'deadbeef' })
    expect(found!.body.toString()).toBe('response')
  })

  it('lookup miss returns null', () => {
    expect(cache.lookup(UploadCache.hashBody(Buffer.from('x')), 'b', '/bytes')).toBeNull()
  })

  it('keys by (hash, batch, path) — different batch or path is a miss', () => {
    const hash = UploadCache.hashBody(Buffer.from('body'))
    cache.store(hash, 'batchA', '/bytes', {
      status: 200,
      headers: {},
      body: Buffer.from('r'),
    })
    expect(cache.lookup(hash, 'batchA', '/bytes')).not.toBeNull()
    expect(cache.lookup(hash, 'batchB', '/bytes')).toBeNull()
    expect(cache.lookup(hash, 'batchA', '/chunks')).toBeNull()
  })
})
