// JSON-RPC method handlers. Each handler validates params, resolves a block
// through the DataStore, and returns a viem-compatible response.

import { blockToRpc, type RpcBlock } from './block.js'
import type { BlockRecord, DataStore } from './store.js'

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message)
  }
}

const INVALID_PARAMS = -32602

export type RpcParams = unknown[]

export async function ethBlockNumber(
  store: DataStore,
  _params: RpcParams,
): Promise<string> {
  return '0x' + store.latestBlockNumber.toString(16)
}

export async function ethGetBlockByNumber(
  store: DataStore,
  params: RpcParams,
): Promise<RpcBlock | null> {
  const [tag, fullTx] = validateBlockByNumberParams(params)
  const number = resolveBlockTag(store, tag)
  if (number === null) return null
  const block = await store.readBlockByNumber(number)
  if (!block) return null
  return shapeBlock(block, fullTx)
}

export async function ethGetBlockByHash(
  store: DataStore,
  params: RpcParams,
): Promise<RpcBlock | null> {
  const [hash, fullTx] = validateBlockByHashParams(params)
  const block = await store.readBlockByHash(hash)
  if (!block) return null
  return shapeBlock(block, fullTx)
}

export async function ethGetBlockTransactionCountByNumber(
  store: DataStore,
  params: RpcParams,
): Promise<string | null> {
  const [tag] = validateBlockByNumberParams(params)
  const number = resolveBlockTag(store, tag)
  if (number === null) return null
  const block = await store.readBlockByNumber(number)
  if (!block) return null
  return '0x' + block.txHashes.length.toString(16)
}

export async function ethGetBlockTransactionCountByHash(
  store: DataStore,
  params: RpcParams,
): Promise<string | null> {
  const [hash] = validateBlockByHashParams(params)
  const block = await store.readBlockByHash(hash)
  if (!block) return null
  return '0x' + block.txHashes.length.toString(16)
}

// ---------- param validation ----------

function validateBlockByNumberParams(params: RpcParams): [string, boolean] {
  if (!Array.isArray(params) || params.length < 1) {
    throw new RpcError(INVALID_PARAMS, 'expected [blockNumber, fullTx?]')
  }
  const tag = params[0]
  if (typeof tag !== 'string') {
    throw new RpcError(INVALID_PARAMS, 'blockNumber must be a hex string or tag')
  }
  const fullTx = typeof params[1] === 'boolean' ? params[1] : false
  return [tag, fullTx]
}

function validateBlockByHashParams(params: RpcParams): [string, boolean] {
  if (!Array.isArray(params) || params.length < 1) {
    throw new RpcError(INVALID_PARAMS, 'expected [blockHash, fullTx?]')
  }
  const hash = params[0]
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new RpcError(INVALID_PARAMS, 'blockHash must be a 0x-prefixed 32-byte hex string')
  }
  const fullTx = typeof params[1] === 'boolean' ? params[1] : false
  return [hash, fullTx]
}

// Resolves a JSON-RPC block tag. `pending` / `safe` / `finalized` collapse to
// the latest loaded block; `earliest` to 0.
function resolveBlockTag(store: DataStore, tag: string): bigint | null {
  switch (tag) {
    case 'latest':
    case 'pending':
    case 'safe':
    case 'finalized':
      return store.latestBlockNumber
    case 'earliest':
      return 0n
  }
  if (!/^0x[0-9a-fA-F]+$/.test(tag)) {
    throw new RpcError(INVALID_PARAMS, `invalid block tag: ${tag}`)
  }
  return BigInt(tag)
}

function shapeBlock(block: BlockRecord, fullTx: boolean): RpcBlock {
  const shaped = blockToRpc(block)
  if (fullTx && shaped.transactions.length > 0) {
    // Full-tx decoding isn't implemented yet — returning hashes keeps viem
    // happy for the endpoints we claim to support.
    throw new RpcError(
      -32004,
      'full transaction objects are not supported yet; request with fullTx=false',
    )
  }
  return shaped
}
