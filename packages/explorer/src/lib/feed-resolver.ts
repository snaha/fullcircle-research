// Resolve the latest uploaded index ref for a publisher via their epoch feed.
//
// Each indexer type has its own feed topic (shared with the uploader in
// `@fullcircle/era/src/feed-topics`). The feed payload is a 32-byte Swarm
// reference:
//
//   manifest → the manifest root ref (used directly via /bzz/{ref}/...)
//   sqlite   → the dbRef (used directly via /bytes/{ref} with Range)
//   pot      → ref of a tiny JSON envelope { byNumber, byHash, byTx, meta }
//              that this module fetches and parses, giving the explorer all
//              four POT refs in one shot

import { Bee, EthAddress } from '@ethersphere/bee-js'
import { createSyncEpochFinder } from '@snaha/swarm-id'
import { FEED_TOPICS, type FeedKind } from '@fullcircle/era/feed-topics'

export interface ResolvedManifest {
  kind: 'manifest'
  manifestRef: string
}

export interface ResolvedSqlite {
  kind: 'sqlite'
  dbRef: string
}

export interface ResolvedPot {
  kind: 'pot'
  byNumber: string
  byHash: string
  byTx: string
  meta: string | null
}

export type ResolvedSource = ResolvedManifest | ResolvedSqlite | ResolvedPot

/**
 * Look up the most recent feed update for `publisher` and return the refs
 * the explorer needs for the given source kind. Throws if no update is found
 * (the publisher hasn't uploaded for this kind yet).
 */
export async function resolveLatest(
  beeUrl: string,
  publisher: string,
  kind: FeedKind,
): Promise<ResolvedSource> {
  const bee = new Bee(beeUrl)
  const owner = new EthAddress(normalizeAddress(publisher))
  const finder = createSyncEpochFinder({
    bee,
    topic: FEED_TOPICS[kind],
    owner,
  })

  const now = BigInt(Math.floor(Date.now() / 1000))
  const payload = await finder.findAt(now)
  if (!payload) {
    throw new Error(`no ${kind} feed update found for publisher 0x${normalizeAddress(publisher)}`)
  }

  const refHex = toHex(payload.slice(0, 32))

  if (kind === 'manifest') {
    return { kind, manifestRef: refHex }
  }
  if (kind === 'sqlite') {
    return { kind, dbRef: refHex }
  }

  // pot → fetch the envelope JSON from Swarm and parse it
  const res = await fetch(`${beeUrl}/bytes/${refHex}`)
  if (!res.ok) {
    throw new Error(`pot envelope fetch failed: ${res.status} ${res.statusText} (ref ${refHex})`)
  }
  const envelope = (await res.json()) as {
    byNumber?: string
    byHash?: string
    byTx?: string
    meta?: string | null
  }
  if (!envelope.byNumber || !envelope.byHash || !envelope.byTx) {
    throw new Error(`pot envelope at ${refHex} is missing required fields (byNumber/byHash/byTx)`)
  }
  return {
    kind: 'pot',
    byNumber: envelope.byNumber,
    byHash: envelope.byHash,
    byTx: envelope.byTx,
    meta: envelope.meta ?? null,
  }
}

function normalizeAddress(addr: string): string {
  const hex = addr.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`publisher address must be 40-char hex; got "${addr}"`)
  }
  return hex
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
