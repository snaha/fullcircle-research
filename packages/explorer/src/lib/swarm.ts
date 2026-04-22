// Source-agnostic block / meta fetchers. Dispatches between:
//   - Mantaray manifest: `/bzz/{manifestRef}/{index}/{key}` for bundles,
//     `/bzz/{manifestRef}/meta` for the range summary.
//   - POT: three KVS lookups (byNumber / byHash / byTx) to resolve the
//     bundle's 32-byte Swarm reference, then `/bytes/{ref}`; meta is a
//     plain JSON chunk at `/bytes/{metaRef}`.
//
// Both paths share the same decode step (`@fullcircle/era/bundle`).

import {
  computeBlockReward,
  decodeBlockBody,
  decodeBlockBundle,
  decodeBlockHeader,
  decodeBlockReceipts,
  hashBlockHeader,
  type BlockReward,
  type DecodedBody,
  type DecodedHeader,
  type DecodedReceipt,
} from '@fullcircle/era/bundle'
import { getBundleRef, type PotIndex } from './pot'
import { settings } from './settings.svelte'

export interface FetchedBlock {
  header: DecodedHeader
  body: DecodedBody
  receipts: DecodedReceipt[]
  reward: BlockReward
  totalDifficulty: bigint | null
  hash: string // keccak256(rawHeader) — canonical block hash
}

export type Index = 'number' | 'hash' | 'tx'

export interface SourceMeta {
  firstBlock: string
  lastBlock: string
  blockCount: string
  txCount: string
  addressCount: string
  eventCount: string
}

export interface AccountEvent {
  block: string
  pre: string
  post: string
}

export interface AccountRecord {
  addr: string
  balance: string
  eventCount: number
  events: AccountEvent[]
}

const POT_INDEX_MAP: Record<Index, PotIndex> = {
  number: 'byNumber',
  hash: 'byHash',
  tx: 'byTx',
}

/**
 * Fetch the range summary for the currently-selected source. Returns an
 * all-zero `SourceMeta` if the summary is missing (older manifest, POT set
 * without meta) so the UI can still render.
 */
export async function fetchMeta(): Promise<SourceMeta> {
  const empty: SourceMeta = {
    firstBlock: '0',
    lastBlock: '0',
    blockCount: '0',
    txCount: '0',
    addressCount: '0',
    eventCount: '0',
  }
  try {
    if (settings.source === 'manifest') {
      const res = await fetch(`${settings.beeUrl}/bzz/${settings.manifestRef}/meta`)
      if (!res.ok) return empty
      return parseMeta(await res.json(), empty)
    }
    if (!/^[0-9a-f]{64}$/.test(settings.potMeta)) return empty
    const res = await fetch(`${settings.beeUrl}/bytes/${settings.potMeta}`)
    if (!res.ok) return empty
    return parseMeta(await res.json(), empty)
  } catch {
    return empty
  }
}

function parseMeta(data: unknown, empty: SourceMeta): SourceMeta {
  if (!data || typeof data !== 'object') return empty
  const { firstBlock, lastBlock, blockCount, txCount, addressCount, eventCount } = data as Record<
    string,
    unknown
  >
  return {
    firstBlock: typeof firstBlock === 'string' ? firstBlock : empty.firstBlock,
    lastBlock: typeof lastBlock === 'string' ? lastBlock : empty.lastBlock,
    blockCount: typeof blockCount === 'string' ? blockCount : empty.blockCount,
    txCount: typeof txCount === 'string' ? txCount : empty.txCount,
    addressCount: typeof addressCount === 'string' ? addressCount : empty.addressCount,
    eventCount: typeof eventCount === 'string' ? eventCount : empty.eventCount,
  }
}

/**
 * Returns true if the source declares a range but the indexed count doesn't
 * cover `[firstBlock, lastBlock]`. Null when the count isn't available.
 */
export function hasGaps(meta: SourceMeta): boolean | null {
  if (meta.blockCount === '0') return null
  try {
    const first = BigInt(meta.firstBlock)
    const last = BigInt(meta.lastBlock)
    const count = BigInt(meta.blockCount)
    return count !== last - first + 1n
  } catch {
    return null
  }
}

export async function fetchBlock(index: Index, key: string): Promise<FetchedBlock> {
  const bytes =
    settings.source === 'manifest'
      ? await fetchBundleViaManifest(index, key)
      : await fetchBundleViaPot(index, key)
  const bundle = decodeBlockBundle(bytes)
  const header = decodeBlockHeader(bundle.rawHeader)
  const body = decodeBlockBody(bundle.rawBody)
  const receipts = decodeBlockReceipts(bundle.rawReceipts)
  return {
    header,
    body,
    receipts,
    reward: computeBlockReward(header, body, receipts),
    totalDifficulty: bundle.totalDifficulty,
    hash: hashBlockHeader(bundle.rawHeader),
  }
}

async function fetchBundleViaManifest(index: Index, key: string): Promise<Uint8Array> {
  const normalized =
    index === 'number'
      ? key
      : key.toLowerCase().startsWith('0x')
        ? key.toLowerCase()
        : `0x${key.toLowerCase()}`
  const url = `${settings.beeUrl}/bzz/${settings.manifestRef}/${index}/${normalized}`
  const res = await fetch(url)
  if (!res.ok) {
    if (res.status === 404) throw new Error(`not found: ${index}/${normalized}`)
    throw new Error(`bee ${res.status} ${res.statusText}: ${index}/${normalized}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchBundleViaPot(index: Index, key: string): Promise<Uint8Array> {
  const ref = await getBundleRef(POT_INDEX_MAP[index], key, {
    beeUrl: settings.beeUrl,
    refs: {
      byNumber: settings.potByNumber,
      byHash: settings.potByHash,
      byTx: settings.potByTx,
    },
  })
  if (!ref) throw new Error(`not found in POT ${index}: ${key}`)
  const res = await fetch(`${settings.beeUrl}/bytes/${ref}`)
  if (!res.ok) {
    throw new Error(`bee ${res.status} ${res.statusText}: /bytes/${ref}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Cheap existence probe for the lookup page. For manifest we range-GET the
 * bundle (any non-404 is good enough); for POT we do a `getRaw` on the
 * appropriate KVS and check for a non-null reference.
 */
export async function probeIndex(index: Index, key: string): Promise<boolean> {
  try {
    if (settings.source === 'manifest') {
      const normalized =
        index === 'number'
          ? key
          : key.toLowerCase().startsWith('0x')
            ? key.toLowerCase()
            : `0x${key.toLowerCase()}`
      const res = await fetch(
        `${settings.beeUrl}/bzz/${settings.manifestRef}/${index}/${normalized}`,
        {
          headers: { Range: 'bytes=0-0' },
        },
      )
      return res.status !== 404
    }
    const ref = await getBundleRef(POT_INDEX_MAP[index], key, {
      beeUrl: settings.beeUrl,
      refs: {
        byNumber: settings.potByNumber,
        byHash: settings.potByHash,
        byTx: settings.potByTx,
      },
    })
    return ref !== null
  } catch {
    return false
  }
}

/**
 * Fetch the per-address account record (final balance + full event log).
 * Address-balance data is only indexed in the Mantaray manifest source today —
 * POT has no address KVS, so this throws when called on a POT source.
 */
export async function fetchAccount(addr: string): Promise<AccountRecord> {
  if (settings.source !== 'manifest') {
    throw new Error('Address lookup is not available on POT sources — select a manifest source.')
  }
  const normalized = addr.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`invalid address: ${addr}`)
  }
  const url = `${settings.beeUrl}/bzz/${settings.manifestRef}/address/${normalized}`
  const res = await fetch(url)
  if (!res.ok) {
    if (res.status === 404) throw new Error(`address not indexed: 0x${normalized}`)
    throw new Error(`bee ${res.status} ${res.statusText}: address/${normalized}`)
  }
  const record = (await res.json()) as AccountRecord
  return record
}
