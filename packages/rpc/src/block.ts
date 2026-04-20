// Decode an RLP-encoded Ethereum block header into the JSON shape that
// `eth_getBlockByNumber` / `eth_getBlockByHash` return. Fields beyond the
// London/Shanghai/Cancun forks (baseFeePerGas, withdrawalsRoot, blobGasUsed,
// excessBlobGas, parentBeaconBlockRoot) are emitted only when present in the
// RLP list — pre-merge blocks stop at field 14 (nonce).

import { RLP } from '@ethereumjs/rlp'
import type { Address, BlockTag, Hash, Hex, RpcBlock as ViemRpcBlock } from 'viem'

import type { BlockRecord } from './store.js'

// viem's `RpcBlock` for a mined block with transaction hashes only (no full tx
// objects). We relax the post-fork fields to optional because pre-London /
// pre-Shanghai / pre-Cancun blocks legitimately omit them on the wire, and our
// archive spans pre-merge history. The hand-rolled shape this replaces tracked
// viem field-for-field; now we just reference it directly.
type MinedRpcBlock = ViemRpcBlock<Exclude<BlockTag, 'pending'>, false>
type ForkGatedKeys =
  | 'baseFeePerGas'
  | 'blobGasUsed'
  | 'excessBlobGas'
  | 'sealFields'
  | 'parentBeaconBlockRoot'
  | 'withdrawalsRoot'
  | 'withdrawals'
export type RpcBlock = Omit<MinedRpcBlock, ForkGatedKeys> &
  Partial<Pick<MinedRpcBlock, ForkGatedKeys>>

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
    hash: block.hash as Hash,
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
    transactions: block.txHashes as Hash[],
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

function toHex(b: Uint8Array): Hex {
  let s = '0x'
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s as Hex
}

function toQuantity(input: Uint8Array | bigint): Hex {
  const n = typeof input === 'bigint' ? input : bytesToBigInt(input)
  return `0x${n.toString(16)}` as Hex
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (const byte of b) n = (n << 8n) | BigInt(byte)
  return n
}

function to32(b: Uint8Array): Hash {
  return toFixedHex(b, 32) as Hash
}

function toAddress(b: Uint8Array): Address {
  return toFixedHex(b, 20) as Address
}

// RLP strips leading zeros; JSON-RPC hashes/addresses/bloom must be left-padded
// to their canonical width.
function toFixedHex(b: Uint8Array, width: number): Hex {
  if (b.length > width) {
    throw new Error(`toFixedHex: ${b.length} bytes exceeds width ${width}`)
  }
  let s = '0x'
  for (let i = 0; i < width - b.length; i++) s += '00'
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s as Hex
}
