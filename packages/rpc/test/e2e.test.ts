// End-to-end tests: spin up the JSON-RPC server against the cached era
// fixtures in `data/` and drive it with a real viem public client. Covers the
// handful of "interesting" pre-merge blocks — genesis, first-ever transaction,
// a block with multiple transactions, blocks with uncles.

import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createPublicClient,
  http,
  type Hash,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRpcServer } from '../src/server.js'
import { DataStore } from '../src/store.js'

const DATA_DIR = resolve(fileURLToPath(import.meta.url), '../../../../data')

// Known values from the fixture eras 0–7 (mainnet blocks 0 through 65535).
// Generated once from `data/*.blocks.ndjson` and asserted here so regressions
// in RLP decoding, hex padding, or index resolution surface immediately.
const GENESIS_HASH: Hash =
  '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
const FIRST_TX_BLOCK = 46147n
const FIRST_TX_BLOCK_HASH: Hash =
  '0x4e3a3754410177e6937ef1f84bba68ea139e8d1a2258c5f85db9f1cd715a1bdd'
const FIRST_TX_HASH: Hash =
  '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060'
const THREE_TX_BLOCK = 47923n
const THREE_TX_HASHES: Hash[] = [
  '0x354a8619d29a0ca3f61e2a3df9ac8bfb2dca991d757218b24d7a9e425f1518d5',
  '0x5714947af67ed95328135cc39d311bd2d73f2c47ade780a01e8098e43630bbe3',
  '0x973dc71f3cab85b741567a38bcd4cfce0b6d64873dca7942eb460b2d98b80c01',
]
const ONE_UNCLE_BLOCK = 3n
const TWO_UNCLE_BLOCK = 97n
const LATEST_BLOCK = 65_535n // eras 0..7 inclusive = 8 * 8192 - 1

let stopServer: () => Promise<void>
let client: PublicClient

beforeAll(async () => {
  const store = new DataStore(DATA_DIR)
  await store.load()
  const server = createRpcServer({ store })
  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => res())
  })
  const { port } = server.address() as AddressInfo
  stopServer = () => new Promise<void>((res) => server.close(() => res()))
  client = createPublicClient({
    chain: mainnet,
    transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }),
  })
})

afterAll(async () => {
  await stopServer()
})

describe('eth_blockNumber', () => {
  it('returns the highest loaded block across the fixture eras', async () => {
    expect(await client.getBlockNumber()).toBe(LATEST_BLOCK)
  })
})

describe('eth_getBlockByNumber', () => {
  it('returns the canonical mainnet genesis', async () => {
    const block = await client.getBlock({ blockNumber: 0n })
    expect(block.hash).toBe(GENESIS_HASH)
    expect(block.number).toBe(0n)
    expect(block.parentHash).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(block.transactions).toEqual([])
    expect(block.difficulty).toBe(0x400000000n)
    // Pre-London: viem's formatter reports null when baseFeePerGas is absent.
    expect(block.baseFeePerGas).toBeNull()
  })

  it('returns block 46147 with Ethereum’s first transaction', async () => {
    const block = await client.getBlock({ blockNumber: FIRST_TX_BLOCK })
    expect(block.hash).toBe(FIRST_TX_BLOCK_HASH)
    expect(block.number).toBe(FIRST_TX_BLOCK)
    expect(block.transactions).toEqual([FIRST_TX_HASH])
  })

  it('returns block 47923 with three transactions in canonical order', async () => {
    const block = await client.getBlock({ blockNumber: THREE_TX_BLOCK })
    expect(block.number).toBe(THREE_TX_BLOCK)
    expect(block.transactions).toEqual(THREE_TX_HASHES)
  })

  it('resolves the `latest` tag to the highest loaded block', async () => {
    const block = await client.getBlock({ blockTag: 'latest' })
    expect(block.number).toBe(LATEST_BLOCK)
  })

  it('resolves the `earliest` tag to the genesis block', async () => {
    const block = await client.getBlock({ blockTag: 'earliest' })
    expect(block.hash).toBe(GENESIS_HASH)
  })
})

describe('eth_getBlockByHash', () => {
  it('round-trips the block 46147 hash to the same block', async () => {
    const block = await client.getBlock({ blockHash: FIRST_TX_BLOCK_HASH })
    expect(block.number).toBe(FIRST_TX_BLOCK)
    expect(block.transactions).toEqual([FIRST_TX_HASH])
  })

  it('returns null for an unknown hash', async () => {
    const unknownHash =
      '0x0000000000000000000000000000000000000000000000000000000000000001' as const
    await expect(
      client.getBlock({ blockHash: unknownHash }),
    ).rejects.toThrowError(/could not be found/i)
  })
})

describe('eth_getBlockTransactionCountByNumber', () => {
  it('reports zero transactions for the genesis block', async () => {
    expect(await client.getBlockTransactionCount({ blockNumber: 0n })).toBe(0)
  })

  it('reports one transaction for block 46147', async () => {
    expect(
      await client.getBlockTransactionCount({ blockNumber: FIRST_TX_BLOCK }),
    ).toBe(1)
  })

  it('reports three transactions for block 47923', async () => {
    expect(
      await client.getBlockTransactionCount({ blockNumber: THREE_TX_BLOCK }),
    ).toBe(3)
  })
})

describe('eth_getBlockTransactionCountByHash', () => {
  it('reports three transactions for block 47923 by hash', async () => {
    const block = await client.getBlock({ blockNumber: THREE_TX_BLOCK })
    expect(
      await client.getBlockTransactionCount({ blockHash: block.hash! }),
    ).toBe(3)
  })
})

describe('eth_getUncleCountByBlockNumber', () => {
  it('reports one uncle for block 3 (first mainnet uncle)', async () => {
    const count = await client.request({
      method: 'eth_getUncleCountByBlockNumber',
      params: [`0x${ONE_UNCLE_BLOCK.toString(16)}`],
    })
    expect(count).toBe('0x1')
  })

  it('reports two uncles for block 97', async () => {
    const count = await client.request({
      method: 'eth_getUncleCountByBlockNumber',
      params: [`0x${TWO_UNCLE_BLOCK.toString(16)}`],
    })
    expect(count).toBe('0x2')
  })

  it('reports zero uncles for the genesis block', async () => {
    const count = await client.request({
      method: 'eth_getUncleCountByBlockNumber',
      params: ['0x0'],
    })
    expect(count).toBe('0x0')
  })
})

describe('eth_chainId / net_version / web3_clientVersion', () => {
  it('returns mainnet chain id 1', async () => {
    expect(await client.getChainId()).toBe(1)
  })

  it('reports net_version as the decimal chain id', async () => {
    const v = await client.request({ method: 'net_version' as 'net_version' })
    expect(v).toBe('1')
  })

  it('reports a web3_clientVersion string', async () => {
    const v = await client.request({
      method: 'web3_clientVersion' as 'web3_clientVersion',
    })
    expect(v).toMatch(/^fullcircle-rpc\//)
  })
})
