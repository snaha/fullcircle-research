// Per-block bundle: a single blob stored on Swarm so one fetch retrieves
// everything an explorer/RPC needs to render a block.
//
//   bundle = RLP.encode([rawHeader, rawBody, rawReceipts, tdBytes])
//
// Each inner field is already RLP-encoded, so the outer RLP wraps them as
// byte strings. `tdBytes` is big-endian totalDifficulty; empty for post-merge.
//
// Browser-safe: only depends on @ethereumjs/rlp, @noble/hashes, @noble/curves.

import { RLP } from '@ethereumjs/rlp'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'

// ---------- Bundle envelope ----------

export interface BlockBundle {
  rawHeader: Uint8Array
  rawBody: Uint8Array
  rawReceipts: Uint8Array
  totalDifficulty: bigint | null
}

export function encodeBlockBundle(b: BlockBundle): Uint8Array {
  return RLP.encode([
    b.rawHeader,
    b.rawBody,
    b.rawReceipts,
    b.totalDifficulty === null ? new Uint8Array(0) : bigIntToBytes(b.totalDifficulty),
  ])
}

export function decodeBlockBundle(bytes: Uint8Array): BlockBundle {
  const parts = RLP.decode(bytes) as Uint8Array[]
  if (!Array.isArray(parts) || parts.length < 4) {
    throw new Error(`decodeBlockBundle: expected 4 items, got ${parts.length}`)
  }
  const [rawHeader, rawBody, rawReceipts, tdBytes] = parts
  return {
    rawHeader,
    rawBody,
    rawReceipts,
    totalDifficulty: tdBytes.length === 0 ? null : bytesToBigInt(tdBytes),
  }
}

// ---------- Header ----------

// London/Shanghai/Cancun-aware header decoding. Pre-merge blocks stop at
// field 14 (nonce); post-fork fields are emitted only when present.
export interface DecodedHeader {
  parentHash: string
  sha3Uncles: string
  miner: string
  stateRoot: string
  transactionsRoot: string
  receiptsRoot: string
  logsBloom: string
  difficulty: bigint
  number: bigint
  gasLimit: bigint
  gasUsed: bigint
  timestamp: bigint
  extraData: string
  mixHash: string
  nonce: string
  baseFeePerGas?: bigint
  withdrawalsRoot?: string
  blobGasUsed?: bigint
  excessBlobGas?: bigint
  parentBeaconBlockRoot?: string
}

export function decodeBlockHeader(rawHeader: Uint8Array): DecodedHeader {
  const f = RLP.decode(rawHeader) as Uint8Array[]
  if (!Array.isArray(f) || f.length < 15) {
    throw new Error(`decodeBlockHeader: header has ${f.length} fields, expected >= 15`)
  }

  const out: DecodedHeader = {
    parentHash: toFixedHex(f[0], 32),
    sha3Uncles: toFixedHex(f[1], 32),
    miner: toFixedHex(f[2], 20),
    stateRoot: toFixedHex(f[3], 32),
    transactionsRoot: toFixedHex(f[4], 32),
    receiptsRoot: toFixedHex(f[5], 32),
    logsBloom: toFixedHex(f[6], 256),
    difficulty: bytesToBigInt(f[7]),
    number: bytesToBigInt(f[8]),
    gasLimit: bytesToBigInt(f[9]),
    gasUsed: bytesToBigInt(f[10]),
    timestamp: bytesToBigInt(f[11]),
    extraData: toHex(f[12]),
    mixHash: toFixedHex(f[13], 32),
    nonce: toFixedHex(f[14], 8),
  }
  if (f[15] !== undefined) out.baseFeePerGas = bytesToBigInt(f[15])
  if (f[16] !== undefined) out.withdrawalsRoot = toFixedHex(f[16], 32)
  if (f[17] !== undefined) out.blobGasUsed = bytesToBigInt(f[17])
  if (f[18] !== undefined) out.excessBlobGas = bytesToBigInt(f[18])
  if (f[19] !== undefined) out.parentBeaconBlockRoot = toFixedHex(f[19], 32)
  return out
}

export function hashBlockHeader(rawHeader: Uint8Array): string {
  return '0x' + toHexRaw(keccak_256(rawHeader))
}

// ---------- Body ----------

// A transaction is either:
//   - legacy: an RLP list [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
//     hash = keccak256(RLP.encode(tx))
//   - EIP-2718: a byte-string starting with type byte (0x01/0x02/0x03/0x04)
//     hash = keccak256(bytes)
export interface DecodedTransaction {
  hash: string
  type: number // 0 = legacy
  nonce: bigint
  gasPrice?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasLimit: bigint
  from: string | null // recovered via secp256k1; null if recovery fails
  to: string | null
  value: bigint
  input: string
  v?: bigint
  r?: string
  s?: string
  chainId?: bigint
  accessList?: unknown[]
  raw: string // full tx bytes as 0x-hex
}

export interface DecodedBody {
  transactions: DecodedTransaction[]
  uncles: Uint8Array[] // RLP-encoded uncle headers; rarely shown
  withdrawals?: Uint8Array[] // Shanghai+
}

export function decodeBlockBody(rawBody: Uint8Array): DecodedBody {
  const body = RLP.decode(rawBody) as unknown
  if (!Array.isArray(body) || body.length < 2) {
    throw new Error('decodeBlockBody: body is not an RLP list')
  }
  const txs = body[0] as unknown[]
  const uncles = body[1] as Uint8Array[]
  const withdrawalsField = body[2] as Uint8Array[] | undefined

  if (!Array.isArray(txs)) {
    throw new Error('decodeBlockBody: transactions field is not a list')
  }

  const transactions = txs.map((tx) => {
    const bytes = tx instanceof Uint8Array ? tx : RLP.encode(tx as never)
    return decodeTransaction(bytes)
  })

  return {
    transactions,
    uncles,
    withdrawals: withdrawalsField,
  }
}

// ---------- Receipts (slim form: [status, cumulativeGasUsed, logs]) ----------

export interface DecodedReceipt {
  type: number
  status?: bigint // 1 = success, 0 = failure; undefined for pre-Byzantium (postState root)
  cumulativeGasUsed: bigint
}

// erae slim receipt format: [txType, postStateOrStatus, cumulativeGasUsed, logs]
// - txType: empty bytes for legacy, single byte for EIP-2718 typed
// - postStateOrStatus: 32-byte state root pre-Byzantium, 1-byte status (0/1) post-Byzantium
// - logsBloom is omitted (recoverable from logs)
export function decodeBlockReceipts(rawReceipts: Uint8Array): DecodedReceipt[] {
  if (rawReceipts.length === 0) return []
  const items = RLP.decode(rawReceipts) as unknown
  if (!Array.isArray(items)) {
    throw new Error('decodeBlockReceipts: not a list')
  }
  return items.map((r) => {
    const fields = r as Uint8Array[]
    const typeBytes = fields[0]
    const type = typeBytes.length === 0 ? 0 : typeBytes[0]
    const postStateOrStatus = fields[1]
    // status only applies post-Byzantium (1 byte); pre-Byzantium stores a 32-byte postState.
    const status = postStateOrStatus.length <= 1 ? bytesToBigInt(postStateOrStatus) : undefined
    return {
      type,
      status,
      cumulativeGasUsed: bytesToBigInt(fields[2]),
    }
  })
}

// ---------- Block reward ----------

const WEI_PER_ETH = 10n ** 18n

// Ethereum mainnet fork blocks that change the static block reward.
const BYZANTIUM_BLOCK = 4370000n // 5 -> 3 ETH
const CONSTANTINOPLE_BLOCK = 7280000n // 3 -> 2 ETH
const PARIS_BLOCK = 15537394n // 2 -> 0 ETH (merge, no more PoW issuance)

export interface BlockReward {
  staticReward: bigint // era-based block subsidy
  uncleBonus: bigint // staticReward/32 per included uncle
  fees: bigint // sum of priority fees paid to the miner
  total: bigint
}

function staticRewardForBlock(number: bigint): bigint {
  if (number >= PARIS_BLOCK) return 0n
  if (number >= CONSTANTINOPLE_BLOCK) return 2n * WEI_PER_ETH
  if (number >= BYZANTIUM_BLOCK) return 3n * WEI_PER_ETH
  return 5n * WEI_PER_ETH
}

export function computeBlockReward(
  header: DecodedHeader,
  body: DecodedBody,
  receipts: DecodedReceipt[],
): BlockReward {
  const staticReward = staticRewardForBlock(header.number)
  const uncleBonus = (staticReward * BigInt(body.uncles.length)) / 32n
  const baseFee = header.baseFeePerGas ?? 0n

  let fees = 0n
  let prevCumGas = 0n
  for (let i = 0; i < body.transactions.length; i++) {
    const tx = body.transactions[i]
    const cumGas = receipts[i]?.cumulativeGasUsed ?? 0n
    const gasUsed = cumGas - prevCumGas
    prevCumGas = cumGas

    let effectiveGasPrice: bigint
    if (tx.gasPrice !== undefined) {
      effectiveGasPrice = tx.gasPrice
    } else if (tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined) {
      const room = tx.maxFeePerGas > baseFee ? tx.maxFeePerGas - baseFee : 0n
      const priorityFee = tx.maxPriorityFeePerGas < room ? tx.maxPriorityFeePerGas : room
      effectiveGasPrice = baseFee + priorityFee
    } else {
      continue
    }

    fees += gasUsed * (effectiveGasPrice - baseFee)
  }

  return {
    staticReward,
    uncleBonus,
    fees,
    total: staticReward + uncleBonus + fees,
  }
}

export function decodeTransaction(bytes: Uint8Array): DecodedTransaction {
  const hash = '0x' + toHexRaw(keccak_256(bytes))
  const raw = '0x' + toHexRaw(bytes)

  // EIP-2718 typed tx: first byte < 0x80 signals a type byte
  if (bytes.length > 0 && bytes[0] < 0x80) {
    const type = bytes[0]
    const payload = bytes.subarray(1)
    // RLP.decode for a typed-tx payload returns a mixed list: most entries
    // are byte strings, but accessList is a nested list. Keep the array
    // loosely-typed and assert at each access site.
    const fields = RLP.decode(payload) as unknown as readonly unknown[]
    const b = (i: number) => fields[i] as Uint8Array
    const list = (i: number) => fields[i] as unknown[]

    if (type === 0x01) {
      // EIP-2930: [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, v, r, s]
      const v = bytesToBigInt(b(8))
      return {
        hash,
        type,
        nonce: bytesToBigInt(b(1)),
        gasPrice: bytesToBigInt(b(2)),
        gasLimit: bytesToBigInt(b(3)),
        from: recoverTypedSender(type, fields.slice(0, 8), v, b(9), b(10)),
        to: b(4).length === 0 ? null : toFixedHex(b(4), 20),
        value: bytesToBigInt(b(5)),
        input: toHex(b(6)),
        chainId: bytesToBigInt(b(0)),
        accessList: list(7),
        v,
        r: toFixedHex(b(9), 32),
        s: toFixedHex(b(10), 32),
        raw,
      }
    }
    if (type === 0x02) {
      // EIP-1559: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, v, r, s]
      const v = bytesToBigInt(b(9))
      return {
        hash,
        type,
        nonce: bytesToBigInt(b(1)),
        maxPriorityFeePerGas: bytesToBigInt(b(2)),
        maxFeePerGas: bytesToBigInt(b(3)),
        gasLimit: bytesToBigInt(b(4)),
        from: recoverTypedSender(type, fields.slice(0, 9), v, b(10), b(11)),
        to: b(5).length === 0 ? null : toFixedHex(b(5), 20),
        value: bytesToBigInt(b(6)),
        input: toHex(b(7)),
        chainId: bytesToBigInt(b(0)),
        accessList: list(8),
        v,
        r: toFixedHex(b(10), 32),
        s: toFixedHex(b(11), 32),
        raw,
      }
    }
    if (type === 0x03) {
      // EIP-4844 blob tx: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, maxFeePerBlobGas, blobVersionedHashes, v, r, s]
      const v = bytesToBigInt(b(11))
      return {
        hash,
        type,
        nonce: bytesToBigInt(b(1)),
        maxPriorityFeePerGas: bytesToBigInt(b(2)),
        maxFeePerGas: bytesToBigInt(b(3)),
        gasLimit: bytesToBigInt(b(4)),
        from: recoverTypedSender(type, fields.slice(0, 11), v, b(12), b(13)),
        to: b(5).length === 0 ? null : toFixedHex(b(5), 20),
        value: bytesToBigInt(b(6)),
        input: toHex(b(7)),
        chainId: bytesToBigInt(b(0)),
        raw,
      }
    }
    // Unknown typed tx — return a minimal shape
    return {
      hash,
      type,
      nonce: 0n,
      gasLimit: 0n,
      from: null,
      to: null,
      value: 0n,
      input: '0x',
      raw,
    }
  }

  // Legacy: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
  const fields = RLP.decode(bytes) as Uint8Array[]
  const v = bytesToBigInt(fields[6])
  return {
    hash,
    type: 0,
    nonce: bytesToBigInt(fields[0]),
    gasPrice: bytesToBigInt(fields[1]),
    gasLimit: bytesToBigInt(fields[2]),
    from: recoverLegacySender(fields.slice(0, 6), v, fields[7], fields[8]),
    to: fields[3].length === 0 ? null : toFixedHex(fields[3], 20),
    value: bytesToBigInt(fields[4]),
    input: toHex(fields[5]),
    v,
    r: toFixedHex(fields[7], 32),
    s: toFixedHex(fields[8], 32),
    raw,
  }
}

// ---------- Internal: sender recovery (secp256k1) ----------

function recoverLegacySender(
  signedFields: Uint8Array[],
  v: bigint,
  r: Uint8Array,
  s: Uint8Array,
): string | null {
  let recoveryId: number
  let list: unknown[]
  if (v === 27n || v === 28n) {
    recoveryId = Number(v - 27n)
    list = signedFields
  } else if (v >= 35n) {
    // EIP-155: v = chainId * 2 + 35 + recoveryId
    const chainId = (v - 35n) >> 1n
    recoveryId = Number((v - 35n) & 1n)
    list = [...signedFields, bigIntToBytes(chainId), new Uint8Array(0), new Uint8Array(0)]
  } else {
    return null
  }
  const sigHash = keccak_256(RLP.encode(list as never))
  return recoverAddress(sigHash, r, s, recoveryId)
}

function recoverTypedSender(
  type: number,
  signedFields: readonly unknown[],
  v: bigint,
  r: Uint8Array,
  s: Uint8Array,
): string | null {
  if (v !== 0n && v !== 1n) return null
  const payload = RLP.encode(signedFields as never)
  const prefixed = new Uint8Array(1 + payload.length)
  prefixed[0] = type
  prefixed.set(payload, 1)
  const sigHash = keccak_256(prefixed)
  return recoverAddress(sigHash, r, s, Number(v))
}

function recoverAddress(
  sigHash: Uint8Array,
  r: Uint8Array,
  s: Uint8Array,
  recoveryId: number,
): string | null {
  if (r.length > 32 || s.length > 32) return null
  const compact = new Uint8Array(64)
  compact.set(r, 32 - r.length)
  compact.set(s, 64 - s.length)
  try {
    const pub = secp256k1.Signature.fromCompact(compact)
      .addRecoveryBit(recoveryId)
      .recoverPublicKey(sigHash)
      .toRawBytes(false) // 65 bytes: 0x04 || X || Y
    const addr = keccak_256(pub.subarray(1)).subarray(12)
    return '0x' + toHexRaw(addr)
  } catch {
    return null
  }
}

// ---------- Internal: hex + bigint helpers ----------

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (const byte of b) n = (n << 8n) | BigInt(byte)
  return n
}

function bigIntToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('bigIntToBytes: negative')
  if (n === 0n) return new Uint8Array(0)
  const bytes: number[] = []
  let v = n
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn))
    v >>= 8n
  }
  return new Uint8Array(bytes)
}

function toHexRaw(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

function toHex(b: Uint8Array): string {
  return '0x' + toHexRaw(b)
}

// RLP strips leading zeros — hashes/addresses/bloom need left-padding to a
// fixed width for canonical display.
function toFixedHex(b: Uint8Array, width: number): string {
  if (b.length > width) {
    throw new Error(`toFixedHex: ${b.length} bytes exceeds width ${width}`)
  }
  let s = '0x'
  for (let i = 0; i < width - b.length; i++) s += '00'
  s += toHexRaw(b)
  return s
}
