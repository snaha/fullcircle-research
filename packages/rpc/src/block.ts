// Decode an RLP-encoded Ethereum block header into the JSON shape that
// `eth_getBlockByNumber` / `eth_getBlockByHash` return. Fields beyond the
// London/Shanghai/Cancun forks (baseFeePerGas, withdrawalsRoot, blobGasUsed,
// excessBlobGas, parentBeaconBlockRoot) are emitted only when present in the
// RLP list — pre-merge blocks stop at field 14 (nonce).

import { RLP } from '@ethereumjs/rlp'

import type { BlockRecord } from './store.js'

export interface RpcBlock {
  number: string
  hash: string
  parentHash: string
  sha3Uncles: string
  miner: string
  stateRoot: string
  transactionsRoot: string
  receiptsRoot: string
  logsBloom: string
  difficulty: string
  gasLimit: string
  gasUsed: string
  timestamp: string
  extraData: string
  mixHash: string
  nonce: string
  size: string
  totalDifficulty: string | null
  transactions: string[]
  uncles: string[]
  baseFeePerGas?: string
  withdrawalsRoot?: string
  withdrawals?: unknown[]
  blobGasUsed?: string
  excessBlobGas?: string
  parentBeaconBlockRoot?: string
}

export function blockToRpc(block: BlockRecord): RpcBlock {
  const fields = RLP.decode(block.rawHeader) as Uint8Array[]
  if (!Array.isArray(fields) || fields.length < 15) {
    throw new Error(`blockToRpc: header has ${fields.length} fields, expected >= 15`)
  }

  const [
    parentHash,
    sha3Uncles,
    miner,
    stateRoot,
    transactionsRoot,
    receiptsRoot,
    logsBloom,
    difficulty,
    number,
    gasLimit,
    gasUsed,
    timestamp,
    extraData,
    mixHash,
    nonce,
    baseFeePerGas,
    withdrawalsRoot,
    blobGasUsed,
    excessBlobGas,
    parentBeaconBlockRoot,
  ] = fields

  const out: RpcBlock = {
    number: toQuantity(number),
    hash: block.hash,
    parentHash: to32(parentHash),
    sha3Uncles: to32(sha3Uncles),
    miner: toAddress(miner),
    stateRoot: to32(stateRoot),
    transactionsRoot: to32(transactionsRoot),
    receiptsRoot: to32(receiptsRoot),
    logsBloom: toFixedHex(logsBloom, 256),
    difficulty: toQuantity(difficulty),
    gasLimit: toQuantity(gasLimit),
    gasUsed: toQuantity(gasUsed),
    timestamp: toQuantity(timestamp),
    extraData: toHex(extraData),
    mixHash: to32(mixHash),
    nonce: toFixedHex(nonce, 8),
    size: toQuantity(BigInt(block.rawHeader.length)),
    totalDifficulty:
      block.totalDifficulty !== null ? toQuantity(block.totalDifficulty) : null,
    transactions: block.txHashes,
    uncles: [],
  }

  if (baseFeePerGas !== undefined) out.baseFeePerGas = toQuantity(baseFeePerGas)
  if (withdrawalsRoot !== undefined) {
    out.withdrawalsRoot = to32(withdrawalsRoot)
    out.withdrawals = []
  }
  if (blobGasUsed !== undefined) out.blobGasUsed = toQuantity(blobGasUsed)
  if (excessBlobGas !== undefined) out.excessBlobGas = toQuantity(excessBlobGas)
  if (parentBeaconBlockRoot !== undefined) {
    out.parentBeaconBlockRoot = to32(parentBeaconBlockRoot)
  }

  return out
}

function toHex(b: Uint8Array): string {
  let s = '0x'
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

function toQuantity(input: Uint8Array | bigint): string {
  const n = typeof input === 'bigint' ? input : bytesToBigInt(input)
  return '0x' + n.toString(16)
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (const byte of b) n = (n << 8n) | BigInt(byte)
  return n
}

function to32(b: Uint8Array): string {
  return toFixedHex(b, 32)
}

function toAddress(b: Uint8Array): string {
  return toFixedHex(b, 20)
}

// RLP strips leading zeros; JSON-RPC hashes/addresses/bloom must be left-padded
// to their canonical width.
function toFixedHex(b: Uint8Array, width: number): string {
  if (b.length > width) {
    throw new Error(`toFixedHex: ${b.length} bytes exceeds width ${width}`)
  }
  let s = '0x'
  for (let i = 0; i < width - b.length; i++) s += '00'
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}
