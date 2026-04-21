// Browser client for fetching block bundles from a Bee gateway through a
// Mantaray manifest uploaded by @fullcircle/era.

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

export interface FetchedBlock {
  header: DecodedHeader
  body: DecodedBody
  receipts: DecodedReceipt[]
  reward: BlockReward
  totalDifficulty: bigint | null
  hash: string // keccak256(rawHeader) — canonical block hash
}

export interface FetchOptions {
  beeUrl: string
  manifestRef: string // 32-byte hex, no 0x prefix
}

// Index prefixes — must match packages/era/src/swarm.ts.
export type Index = 'number' | 'hash' | 'tx'

export interface ManifestMeta {
  firstBlock: string // decimal string; '0' if the manifest has no /meta yet
  lastBlock: string
}

/**
 * Fetch the `/meta` bundle written by `writeBlockRangeMeta` in @fullcircle/era.
 * Older manifests don't have it — treat as an empty range (0..0) rather than
 * erroring so the UI can still render.
 */
export async function fetchManifestMeta(opts: FetchOptions): Promise<ManifestMeta> {
  const empty: ManifestMeta = { firstBlock: '0', lastBlock: '0' }
  try {
    const res = await fetch(`${opts.beeUrl}/bzz/${opts.manifestRef}/meta`)
    if (!res.ok) return empty
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return empty
    const { firstBlock, lastBlock } = data as Record<string, unknown>
    return {
      firstBlock: typeof firstBlock === 'string' ? firstBlock : '0',
      lastBlock: typeof lastBlock === 'string' ? lastBlock : '0',
    }
  } catch {
    return empty
  }
}

export async function fetchBundleByPath(path: string, opts: FetchOptions): Promise<Uint8Array> {
  const url = `${opts.beeUrl}/bzz/${opts.manifestRef}/${path}`
  const res = await fetch(url)
  if (!res.ok) {
    if (res.status === 404) throw new Error(`not found: ${path}`)
    throw new Error(`bee ${res.status} ${res.statusText}: ${path}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

export async function fetchBlock(
  index: Index,
  key: string,
  opts: FetchOptions,
): Promise<FetchedBlock> {
  const normalizedKey =
    index === 'number'
      ? key
      : key.toLowerCase().startsWith('0x')
        ? key.toLowerCase()
        : `0x${key.toLowerCase()}`

  const bytes = await fetchBundleByPath(`${index}/${normalizedKey}`, opts)
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
