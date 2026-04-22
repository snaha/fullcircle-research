// erae (Ethereum execution-layer era) file tooling.
//
// Format refs:
//   e2store record: type(u16 LE) | length(u32 LE) | reserved(u16=0) | data[length]
//   erae spec:      https://hackmd.io/pIZlxnitSciV5wUgW6W20w
//   era1 spec:      https://github.com/eth-clients/e2store-format-specs/blob/main/formats/era1.md
//
// An erae file holds up to 8192 consecutive blocks. Per-block records are
// snappy-framed over RLP. Payload records (header/body/receipts/...) appear
// once per block in block-number order. The BlockIndex record at the end
// gives random-access offsets back to each block's records.

import { RLP } from '@ethereumjs/rlp'
import { keccak_256 } from '@noble/hashes/sha3'
import snappy from 'snappyjs'

// ---------- Record type IDs (uint16, stored little-endian) ----------

export const ERAE_TYPE = {
  Version: 0x3265,
  CompressedHeader: 0x03,
  CompressedBody: 0x04,
  CompressedSlimReceipts: 0x0a,
  TotalDifficulty: 0x06,
  Proof: 0x0b,
  AccumulatorRoot: 0x07,
  BlockIndex: 0x3267,
} as const

// ---------- Public types ----------

export interface EraeBlock {
  number: bigint
  hash: Uint8Array // keccak256(rlp(header))
  rawHeader: Uint8Array // decompressed RLP header bytes
  rawBody: Uint8Array // decompressed RLP body bytes
  rawReceipts: Uint8Array // decompressed RLP receipts bytes (slim form for erae)
  totalDifficulty?: bigint // only present pre-merge
  proof?: Uint8Array // optional Portal Network proof
  txHashes: Uint8Array[] // keccak256 of each tx, in block order
}

export interface EraeFile {
  version: number // uint16, should be ERAE_TYPE.Version
  startingBlock: bigint
  blockCount: number
  blocks: EraeBlock[]
  accumulatorRoot?: Uint8Array // pre-merge only
}

export interface EraeIndex {
  byNumber: Map<bigint, EraeBlock>
  byBlockHash: Map<string, EraeBlock> // hex (no 0x) -> block
  byTxHash: Map<string, { block: EraeBlock; txIndex: number }>
}

export interface EraeReader {
  version: number
  startingBlock: bigint
  blockCount: number
  accumulatorRoot?: Uint8Array
  blocks(): Generator<EraeBlock>
}

// ---------- 1. Fetch an erae file ----------

/**
 * Download an erae file as bytes. Pure in the sense that the output depends
 * only on the URL + network state; no local side effects.
 */
export async function fetchEraeFile(url: string, init?: RequestInit): Promise<Uint8Array> {
  const res = await fetch(url, init)
  if (!res.ok) {
    throw new Error(`fetchEraeFile: ${res.status} ${res.statusText} for ${url}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

// ---------- 2. Parse erae bytes into blocks ----------

export function openEraeFile(data: Uint8Array): EraeReader {
  const records = readAllRecords(data)
  if (records.length === 0) throw new Error('openEraeFile: empty file')

  const first = records[0]
  if (first.type !== ERAE_TYPE.Version) {
    throw new Error(`openEraeFile: missing Version record (got 0x${first.type.toString(16)})`)
  }

  // Records in an erae file are grouped by TYPE, not interleaved per block:
  // [Version] [Header * N] [Body * N] [Receipts * N] [TotalDifficulty * N]?
  //   [Proof * N]? [AccumulatorRoot]? [BlockIndex]
  // We bucket them by type, then zip the N-sized buckets together in order.
  const headers: Uint8Array[] = []
  const bodies: Uint8Array[] = []
  const receipts: Uint8Array[] = []
  const tds: Uint8Array[] = []
  const proofs: Uint8Array[] = []
  let accumulatorRoot: Uint8Array | undefined
  let blockIndexRecord: Uint8Array | undefined

  for (let i = 1; i < records.length; i++) {
    const r = records[i]
    switch (r.type) {
      case ERAE_TYPE.CompressedHeader:
        headers.push(r.data)
        break
      case ERAE_TYPE.CompressedBody:
        bodies.push(r.data)
        break
      case ERAE_TYPE.CompressedSlimReceipts:
        receipts.push(r.data)
        break
      case ERAE_TYPE.TotalDifficulty:
        tds.push(r.data)
        break
      case ERAE_TYPE.Proof:
        proofs.push(r.data)
        break
      case ERAE_TYPE.AccumulatorRoot:
        accumulatorRoot = r.data
        break
      case ERAE_TYPE.BlockIndex:
        blockIndexRecord = r.data
        break
      default:
        // Unknown / future record types are ignored per e2store extensibility.
        break
    }
  }

  const { startingBlock, count } = parseBlockIndex(blockIndexRecord)
  if (headers.length !== count) {
    throw new Error(`openEraeFile: ${headers.length} headers vs BlockIndex count ${count}`)
  }
  if (bodies.length !== count || receipts.length !== count) {
    throw new Error(
      `openEraeFile: mismatched counts header=${headers.length} body=${bodies.length} receipts=${receipts.length}`,
    )
  }
  if (tds.length !== 0 && tds.length !== count) {
    throw new Error(`openEraeFile: partial TotalDifficulty: ${tds.length}/${count}`)
  }
  if (proofs.length !== 0 && proofs.length !== count) {
    throw new Error(`openEraeFile: partial Proof: ${proofs.length}/${count}`)
  }

  function* blocks(): Generator<EraeBlock> {
    for (let i = 0; i < count; i++) {
      const rawHeader = snappyFramedDecode(headers[i])
      const rawBody = snappyFramedDecode(bodies[i])
      const rawReceipts = snappyFramedDecode(receipts[i])
      const block: EraeBlock = {
        number: readHeaderNumber(rawHeader),
        hash: keccak_256(rawHeader),
        rawHeader,
        rawBody,
        rawReceipts,
        totalDifficulty: tds[i] ? readUint256LE(tds[i]) : undefined,
        proof: proofs[i],
        txHashes: extractTxHashes(rawBody),
      }
      if (i === 0 && block.number !== startingBlock) {
        throw new Error(
          `openEraeFile: header number ${block.number} != BlockIndex starting ${startingBlock}`,
        )
      }
      yield block
    }
  }

  return {
    version: first.type,
    startingBlock,
    blockCount: count,
    accumulatorRoot,
    blocks,
  }
}

export function parseEraeFile(data: Uint8Array): EraeFile {
  const reader = openEraeFile(data)
  const blocks: EraeBlock[] = []
  for (const b of reader.blocks()) blocks.push(b)
  return {
    version: reader.version,
    startingBlock: reader.startingBlock,
    blockCount: reader.blockCount,
    blocks,
    accumulatorRoot: reader.accumulatorRoot,
  }
}

// ---------- 3. Build lookup indexes ----------

export function buildEraeIndex(file: EraeFile): EraeIndex {
  const byNumber = new Map<bigint, EraeBlock>()
  const byBlockHash = new Map<string, EraeBlock>()
  const byTxHash = new Map<string, { block: EraeBlock; txIndex: number }>()

  for (const block of file.blocks) {
    byNumber.set(block.number, block)
    byBlockHash.set(toHex(block.hash), block)
    for (let i = 0; i < block.txHashes.length; i++) {
      byTxHash.set(toHex(block.txHashes[i]), { block, txIndex: i })
    }
  }
  return { byNumber, byBlockHash, byTxHash }
}

// ---------- Internal: e2store record reader ----------

interface E2Record {
  type: number
  data: Uint8Array
  offset: number
}

function readAllRecords(data: Uint8Array): E2Record[] {
  const out: E2Record[] = []
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let off = 0
  while (off < data.length) {
    if (off + 8 > data.length) {
      throw new Error(`readAllRecords: truncated header at offset ${off}`)
    }
    const type = dv.getUint16(off, true)
    const length = dv.getUint32(off + 2, true)
    const reserved = dv.getUint16(off + 6, true)
    if (reserved !== 0) {
      throw new Error(`readAllRecords: nonzero reserved at offset ${off}`)
    }
    const start = off + 8
    const end = start + length
    if (end > data.length) {
      throw new Error(`readAllRecords: record of len ${length} overruns file at offset ${off}`)
    }
    out.push({ type, data: data.subarray(start, end), offset: off })
    off = end
  }
  return out
}

// ---------- Internal: BlockIndex record ----------

function parseBlockIndex(record: Uint8Array | undefined): { startingBlock: bigint; count: number } {
  if (!record) throw new Error('parseBlockIndex: BlockIndex record missing')
  if (record.length < 16 || record.length % 8 !== 0) {
    throw new Error(`parseBlockIndex: bad length ${record.length}`)
  }
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength)
  const startingBlock = dv.getBigUint64(0, true)
  const count = Number(dv.getBigUint64(record.length - 8, true))
  return { startingBlock, count }
}

// ---------- Internal: RLP header helpers ----------

function readHeaderNumber(rawHeader: Uint8Array): bigint {
  const decoded = RLP.decode(rawHeader) as Uint8Array[]
  if (!Array.isArray(decoded) || decoded.length < 9) {
    throw new Error('readHeaderNumber: header is not an RLP list of >=9 items')
  }
  return bytesToBigInt(decoded[8]) // field 8 is block number
}

function extractTxHashes(rawBody: Uint8Array): Uint8Array[] {
  // Body RLP is [transactions, uncles, (withdrawals?)]. A tx is either an RLP
  // list (legacy) or a byte-string starting with the EIP-2718 type byte.
  const body = RLP.decode(rawBody) as unknown
  if (!Array.isArray(body) || body.length < 1) {
    throw new Error('extractTxHashes: body is not an RLP list')
  }
  const txs = body[0] as unknown
  if (!Array.isArray(txs)) {
    throw new Error('extractTxHashes: transactions field is not a list')
  }
  return txs.map((tx) => {
    const bytes = tx instanceof Uint8Array ? tx : RLP.encode(tx as never)
    return keccak_256(bytes)
  })
}

// ---------- Internal: primitives ----------

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (const byte of b) n = (n << 8n) | BigInt(byte)
  return n
}

function readUint256LE(b: Uint8Array): bigint {
  if (b.length > 32) throw new Error(`readUint256LE: len ${b.length}`)
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

function toHex(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

// ---------- Internal: snappy framed stream decoder ----------
//
// https://github.com/google/snappy/blob/main/framing_format.txt
// The 0xff stream identifier must come first. Then:
//   0x00 compressed (crc32c | snappy-raw)
//   0x01 uncompressed (crc32c | data)
//   0xfe padding
//   0x02..0x7f reserved unskippable (error)
//   0x80..0xfd reserved skippable (ignore)
// Each chunk: type(u8) | len(u24 LE) | payload[len]
// We skip CRC verification — chunk framing + content hashes downstream are
// enough for this tooling.

const STREAM_IDENTIFIER = new Uint8Array([
  0xff, 0x06, 0x00, 0x00, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59,
])

function snappyFramedDecode(input: Uint8Array): Uint8Array {
  if (input.length < STREAM_IDENTIFIER.length) {
    throw new Error('snappyFramedDecode: input too short for stream identifier')
  }
  for (let i = 0; i < STREAM_IDENTIFIER.length; i++) {
    if (input[i] !== STREAM_IDENTIFIER[i]) {
      throw new Error('snappyFramedDecode: missing stream identifier')
    }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  let off = STREAM_IDENTIFIER.length
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength)

  while (off < input.length) {
    if (off + 4 > input.length) {
      throw new Error('snappyFramedDecode: truncated chunk header')
    }
    const kind = input[off]
    const len = dv.getUint32(off, true) >>> 8 // low 24 bits of the 32-bit word
    const payloadStart = off + 4
    const payloadEnd = payloadStart + len
    if (payloadEnd > input.length) {
      throw new Error('snappyFramedDecode: truncated chunk payload')
    }
    const payload = input.subarray(payloadStart, payloadEnd)

    if (kind === 0x00) {
      // compressed: skip 4-byte crc32c, raw-decode the rest
      const raw = snappy.uncompress(payload.subarray(4)) as Uint8Array
      chunks.push(raw)
      total += raw.length
    } else if (kind === 0x01) {
      const raw = payload.subarray(4)
      chunks.push(raw)
      total += raw.length
    } else if (kind === 0xff) {
      // second stream identifier in concatenated streams — ignore
    } else if (kind === 0xfe || (kind >= 0x80 && kind <= 0xfd)) {
      // padding or skippable — ignore
    } else {
      throw new Error(`snappyFramedDecode: unskippable reserved chunk type 0x${kind.toString(16)}`)
    }
    off = payloadEnd
  }

  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}
