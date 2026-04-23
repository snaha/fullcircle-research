// Integration tests for the HTTP side of the proxy. Every test boots a
// mock upstream + proxy on ephemeral ports with a throwaway SQLite cache,
// so they never touch a real Bee or the developer's running :1733 proxy.

import { afterEach, describe, expect, it } from 'vitest'

import {
  proxyRequest,
  randomBatchId,
  randomBody,
  startProxy,
  startUpstream,
  type ProxyHandle,
  type UpstreamHandle,
  type UpstreamHandler,
} from './test-helpers.js'

describe('HTTP proxy', () => {
  let upstream: UpstreamHandle | undefined
  let proxy: ProxyHandle | undefined

  async function setup(
    handler: UpstreamHandler,
    opts: { withCache?: boolean } = {},
  ): Promise<{ upstream: UpstreamHandle; proxy: ProxyHandle }> {
    upstream = await startUpstream(handler)
    proxy = await startProxy({ upstream, withCache: opts.withCache })
    return { upstream, proxy }
  }

  afterEach(async () => {
    await proxy?.close()
    await upstream?.close()
    upstream = undefined
    proxy = undefined
  })

  describe('non-cacheable paths stream through', () => {
    it('GET /stamps streams upstream response', async () => {
      const { upstream, proxy } = await setup((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: req.url }))
      })
      const resp = await proxyRequest(proxy, { method: 'GET', path: '/stamps' })
      expect(resp.status).toBe(200)
      expect(JSON.parse(resp.body.toString())).toEqual({ path: '/stamps' })
      expect(upstream.requests).toHaveLength(1)
    })

    it('POST /stamps is never cached (mutable)', async () => {
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(201)
        res.end(JSON.stringify({ batchID: 'new' }))
      })
      const body = randomBody()
      const batch = randomBatchId()
      const headers = { 'swarm-postage-batch-id': batch, 'content-type': 'application/json' }
      await proxyRequest(proxy, { method: 'POST', path: '/stamps/100/17', headers, body })
      await proxyRequest(proxy, { method: 'POST', path: '/stamps/100/17', headers, body })
      expect(upstream.requests).toHaveLength(2)
    })

    it('POST /feeds is never cached (mutable)', async () => {
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(201)
        res.end(JSON.stringify({ reference: 'feed-ref' }))
      })
      const body = randomBody()
      const batch = randomBatchId()
      const headers = { 'swarm-postage-batch-id': batch }
      await proxyRequest(proxy, { method: 'POST', path: '/feeds/owner/topic', headers, body })
      await proxyRequest(proxy, { method: 'POST', path: '/feeds/owner/topic', headers, body })
      expect(upstream.requests).toHaveLength(2)
    })

    it('POST /bytes without batch id is not cached', async () => {
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(201)
        res.end(JSON.stringify({ reference: 'no-batch' }))
      })
      const body = randomBody()
      await proxyRequest(proxy, { method: 'POST', path: '/bytes', body })
      await proxyRequest(proxy, { method: 'POST', path: '/bytes', body })
      expect(upstream.requests).toHaveLength(2)
    })

    it('POST /tags is forwarded uncached (bee-js createTag path)', async () => {
      // bee-js's Bee.createTag() sends POST /tags with no body and no
      // swarm-postage-batch-id header. /tags is not in CACHEABLE_PATH_PREFIXES,
      // so it must fall through handleStream and hit upstream every time.
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ uid: 494344, address: '' }))
      })
      const first = await proxyRequest(proxy, { method: 'POST', path: '/tags' })
      expect(first.status).toBe(201)
      expect(JSON.parse(first.body.toString())).toEqual({ uid: 494344, address: '' })
      const second = await proxyRequest(proxy, { method: 'POST', path: '/tags' })
      expect(second.status).toBe(201)
      expect(upstream.requests).toHaveLength(2)
      expect(upstream.requests[0]!.method).toBe('POST')
      expect(upstream.requests[0]!.url).toBe('/tags')
    })
  })

  describe('cacheable routes: first miss, then hit', () => {
    const cases: Array<{ path: string; label: string }> = [
      { path: '/bytes', label: 'POST /bytes' },
      { path: '/chunks', label: 'POST /chunks' },
      { path: '/bzz', label: 'POST /bzz' },
      {
        path: '/soc/0000000000000000000000000000000000000000/0000000000000000000000000000000000000000000000000000000000000000',
        label: 'POST /soc/{owner}/{id}',
      },
    ]

    for (const { path, label } of cases) {
      it(`${label}: miss forwards + stores; repeat short-circuits`, async () => {
        const { upstream, proxy } = await setup((_req, res) => {
          res.writeHead(201, {
            'swarm-reference': 'cafebabe',
            'content-type': 'application/json',
          })
          res.end(JSON.stringify({ reference: 'cafebabe' }))
        })
        const body = randomBody()
        const batch = randomBatchId()
        const headers = { 'swarm-postage-batch-id': batch }

        const first = await proxyRequest(proxy, { method: 'POST', path, headers, body })
        expect(first.status).toBe(201)
        expect(first.headers['swarm-reference']).toBe('cafebabe')
        expect(upstream.requests).toHaveLength(1)
        expect(upstream.requests[0]!.body.equals(body)).toBe(true)

        const second = await proxyRequest(proxy, { method: 'POST', path, headers, body })
        expect(second.status).toBe(201)
        expect(second.headers['swarm-reference']).toBe('cafebabe')
        expect(second.body.toString()).toBe(first.body.toString())
        // Cache hit — upstream must not be touched again.
        expect(upstream.requests).toHaveLength(1)
      })
    }
  })

  describe('cache invariants', () => {
    it('different batch ids with same body do not share cache', async () => {
      const { upstream, proxy } = await setup((req, res) => {
        const batch = (req.headers['swarm-postage-batch-id'] as string) ?? ''
        res.writeHead(201, { 'swarm-reference': batch.slice(0, 8) })
        res.end(batch)
      })
      const body = randomBody()
      const batchA = randomBatchId()
      const batchB = randomBatchId()
      await proxyRequest(proxy, {
        method: 'POST',
        path: '/bytes',
        headers: { 'swarm-postage-batch-id': batchA },
        body,
      })
      await proxyRequest(proxy, {
        method: 'POST',
        path: '/bytes',
        headers: { 'swarm-postage-batch-id': batchB },
        body,
      })
      expect(upstream.requests).toHaveLength(2)
    })

    it('different bodies with same batch do not share cache', async () => {
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(201, { 'swarm-reference': 'ref' })
        res.end('{}')
      })
      const batch = randomBatchId()
      const headers = { 'swarm-postage-batch-id': batch }
      await proxyRequest(proxy, { method: 'POST', path: '/bytes', headers, body: randomBody() })
      await proxyRequest(proxy, { method: 'POST', path: '/bytes', headers, body: randomBody() })
      expect(upstream.requests).toHaveLength(2)
    })

    it('non-2xx responses are not cached', async () => {
      let calls = 0
      const { upstream, proxy } = await setup((_req, res) => {
        calls++
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
      })
      const body = randomBody()
      const headers = { 'swarm-postage-batch-id': randomBatchId() }
      const first = await proxyRequest(proxy, { method: 'POST', path: '/bytes', headers, body })
      expect(first.status).toBe(500)
      expect(first.body.toString()).toBe('boom')
      const second = await proxyRequest(proxy, { method: 'POST', path: '/bytes', headers, body })
      expect(second.status).toBe(500)
      expect(calls).toBe(2)
      expect(upstream.requests).toHaveLength(2)
    })

    it('with cache disabled, every request hits upstream', async () => {
      const { upstream, proxy } = await setup(
        (_req, res) => {
          res.writeHead(201, { 'swarm-reference': 'r' })
          res.end('{}')
        },
        { withCache: false },
      )
      const body = randomBody()
      const headers = { 'swarm-postage-batch-id': randomBatchId() }
      await proxyRequest(proxy, { method: 'POST', path: '/bytes', headers, body })
      await proxyRequest(proxy, { method: 'POST', path: '/bytes', headers, body })
      expect(upstream.requests).toHaveLength(2)
    })
  })

  describe('retry behaviour', () => {
    it('retries once and succeeds when upstream closes first socket', async () => {
      let hits = 0
      const { proxy } = await setup((_req, res) => {
        hits++
        if (hits === 1) {
          // Simulate transient upstream drop: kill the socket mid-flight.
          res.socket?.destroy()
          return
        }
        res.writeHead(201, { 'swarm-reference': 'retried' })
        res.end('{}')
      })
      const resp = await proxyRequest(proxy, {
        method: 'POST',
        path: '/bytes',
        headers: { 'swarm-postage-batch-id': randomBatchId() },
        body: randomBody(),
      })
      expect(resp.status).toBe(201)
      expect(resp.headers['swarm-reference']).toBe('retried')
      expect(hits).toBe(2)
    })
  })

  describe('header plumbing', () => {
    it('rewrites host header to upstream', async () => {
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
      await proxyRequest(proxy, { method: 'GET', path: '/stamps' })
      expect(upstream.requests[0]!.headers.host).toBe(`${upstream.host}:${upstream.port}`)
    })

    it('forwards custom headers upstream', async () => {
      const { upstream, proxy } = await setup((_req, res) => {
        res.writeHead(200)
        res.end()
      })
      await proxyRequest(proxy, {
        method: 'GET',
        path: '/stamps',
        headers: { 'x-custom': 'hello' },
      })
      expect(upstream.requests[0]!.headers['x-custom']).toBe('hello')
    })
  })
})
