// Publish epoch-feed updates announcing the latest uploaded index.
//
// Three feeds, one per indexer type. Owner = signer EOA. The feed payload is
// a single 32-byte Swarm reference that the explorer resolves at read time:
//
//   manifest → the Mantaray manifest root ref (self-contained)
//   sqlite   → the SQLite Merkle-tree root ref (dbRef)
//   pot      → ref of a small JSON envelope on Swarm that carries
//              { byNumber, byHash, byTx, byAddress, byBalanceBlock, meta }
//              — see `uploadPotEnvelope`
//
// The signer is read from FULLCIRCLE_FEED_SIGNER_KEY or --feed-signer-key.
// If neither is set, publishFeedUpdate prints a warning and returns null —
// the upload itself still succeeds.
//
// Epoch math is stateless but each update needs a prior hint (epoch +
// timestamp) to land on the correct next epoch. We recover that hint by
// walking the publisher's own feed spine on Swarm before each publish —
// Swarm is the source of truth, so wiping local state or running from a
// fresh machine stays safe.
//
// Implementation: bee-js v11's `makeSOCWriter` handles the SOC upload; the
// epoch math (identifier derivation, next-epoch calculation) lives in
// ./feed-epoch. We don't use @snaha/swarm-id here because its published
// bundle inlines a browser-only axios path that fails on Node.

import { Bee, Identifier, PrivateKey } from '@ethersphere/bee-js'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  EpochIndex,
  MAX_EPOCH_LEVEL,
  epochIdentifier,
  epochPayload,
  nextEpoch,
} from './feed-epoch.js'
import { FEED_TOPIC_STRINGS, FEED_TOPICS, type FeedKind } from './feed-topics.js'

export type { FeedKind } from './feed-topics.js'
export { FEED_TOPICS as TOPICS } from './feed-topics.js'

const SIGNER_KEY_ENV = 'FULLCIRCLE_FEED_SIGNER_KEY'

// SOC wire format: identifier(32) || signature(65) || span(8) || payload
const SOC_HEADER_LEN = 32 + 65 + 8

/**
 * Resolve a signer private key from the CLI flag (if given) or the
 * FULLCIRCLE_FEED_SIGNER_KEY env var. Returns null when neither is set so
 * callers can warn-and-skip without breaking the upload.
 */
export function loadSigner(flagValue?: string): PrivateKey | null {
  const raw = flagValue ?? process.env[SIGNER_KEY_ENV]
  if (!raw) return null
  const hex = raw.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`feed signer key must be 32-byte hex (64 chars); got ${hex.length} chars`)
  }
  return new PrivateKey(hex)
}

/**
 * Walk the publisher's feed spine on Swarm and return the deepest existing
 * update's (epoch, timestamp) as a seed for `nextEpoch`.
 *
 * Descends root → `childAt(at)` while each candidate SOC exists, parsing the
 * timestamp out of the chunk payload at each step. Returns null when the
 * publisher has never written a feed update (root is empty).
 *
 * Good enough for seeding even when the most-recent update is off the
 * now-spine: `EpochIndex.next()` only consults the prev epoch when `at` still
 * falls within its range; otherwise it uses `lca(at, last)` which needs only
 * the timestamp. An ancestor hint is always safe because the newer SOC we
 * publish dominates any prior chunk we'd re-write at the same address.
 */
async function recoverFeedHints(
  bee: Bee,
  topic: Uint8Array,
  ownerHex: string,
  at: bigint,
): Promise<{ epoch: EpochIndex; timestamp: bigint } | null> {
  const ownerBytes = hexToBytes(ownerHex)
  let epoch = new EpochIndex(0n, MAX_EPOCH_LEVEL)
  let hint: { epoch: EpochIndex; timestamp: bigint } | null = null

  while (true) {
    const identifier = epochIdentifier(topic, epoch)
    const socBuf = new Uint8Array(identifier.length + ownerBytes.length)
    socBuf.set(identifier, 0)
    socBuf.set(ownerBytes, identifier.length)
    const addrHex = bytesToHex(keccak_256(socBuf))

    const res = await fetch(`${bee.url.replace(/\/$/, '')}/chunks/${addrHex}`, {
      headers: { connection: 'close' },
    })
    if (!res.ok) break
    const chunk = new Uint8Array(await res.arrayBuffer())
    if (chunk.length < SOC_HEADER_LEN + 8) break
    const ts = new DataView(chunk.buffer, chunk.byteOffset + SOC_HEADER_LEN, 8).getBigUint64(
      0,
      false,
    )
    hint = { epoch, timestamp: ts }
    if (epoch.level === 0) break
    epoch = epoch.childAt(at)
  }
  return hint
}

export interface PublishFeedUpdateOptions {
  kind: FeedKind
  /** 32-byte reference as lowercase hex (no 0x). */
  referenceHex: string
  bee: Bee
  /** Postage batch id used to stamp the SOC upload. */
  batchId: string
  signer: PrivateKey
  /**
   * Optional Bee tag uid to attach to the SOC upload. Reusing the tag from
   * the main sync keeps peerless dev nodes from hanging on the feed POST;
   * fresh tags can stall if Bee is still settling the previous batch.
   * A fresh tag is created when not provided.
   */
  tagUid?: number
  onProgress?: (msg: string) => void
}

export interface PublishFeedUpdateResult {
  owner: string
  topic: string
  epoch: { start: bigint; level: number }
  timestamp: bigint
}

/**
 * Write one epoch-feed update announcing `referenceHex` as the latest index
 * ref for the given kind. Recovers the previous hint by walking the
 * publisher's own spine on Swarm (no local state file), signs and uploads a
 * SOC via bee-js.
 */
export async function publishFeedUpdate(
  options: PublishFeedUpdateOptions,
): Promise<PublishFeedUpdateResult> {
  const log = options.onProgress ?? console.log

  const referenceBytes = hexToBytes(options.referenceHex)
  if (referenceBytes.length !== 32 && referenceBytes.length !== 64) {
    throw new Error(`feed reference must be 32 or 64 bytes; got ${referenceBytes.length}`)
  }

  const at = BigInt(Math.floor(Date.now() / 1000))
  const ownerHex = options.signer.publicKey().address().toHex()
  const topic = FEED_TOPICS[options.kind].toUint8Array()

  const hint = await recoverFeedHints(options.bee, topic, ownerHex, at)
  log(
    hint
      ? `feed[${options.kind}] recovered hint · epoch{start:${hint.epoch.start},level:${hint.epoch.level}} · lastTs=${hint.timestamp}`
      : `feed[${options.kind}] no prior updates on Swarm — starting at root`,
  )
  const epoch = nextEpoch(hint?.epoch, hint?.timestamp ?? 0n, at)

  const identifier = epochIdentifier(topic, epoch)
  const payload = epochPayload(at, referenceBytes)

  // POST the SOC to /soc/{owner}/{id}?sig=… — the only endpoint that stores
  // single-owner chunks at their SOC address (keccak256(id||owner)).
  //
  // `Connection: close` + explicit `Content-Length` are required: without
  // them Node's fetch (and bee-js's axios) hang against /soc on a peerless
  // Bee. A fresh tag per SOC is also required; reusing the sqlite sync tag
  // triggers the same hang. `swarm-postage-batch-id` is server-side
  // stamping — the batch is owned by the Bee node, not the feed signer.
  //
  // On gateways the /tags endpoint may be unavailable; in that case we fall
  // back to uploading with `swarm-deferred-upload: false` and no tag header.
  let tagUid: number | null = null
  try {
    const freshTag = await options.bee.createTag()
    tagUid = freshTag.uid
  } catch (err) {
    log(
      `feed[${options.kind}] createTag failed (${(err as Error).message}); uploading SOC with deferred=false and no tag header`,
    )
  }
  const identifierObj = new Identifier(identifier)
  const cac = options.bee.makeContentAddressedChunk(payload)
  const soc = cac.toSingleOwnerChunk(identifierObj, options.signer)
  const socAddressHex = soc.address.toHex()

  const url =
    `${options.bee.url.replace(/\/$/, '')}/soc/${ownerHex}/${identifierObj.toHex()}` +
    `?sig=${soc.signature.toHex()}`
  const body = new Uint8Array(cac.data)
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'swarm-postage-batch-id': options.batchId,
    connection: 'close',
  }
  if (tagUid !== null) {
    headers['swarm-tag'] = String(tagUid)
  } else {
    headers['swarm-deferred-upload'] = 'false'
  }
  const res = await fetch(url, { method: 'POST', headers, body })
  const responseText = await res.text()
  if (!res.ok) {
    throw new Error(`SOC upload failed: ${res.status} ${res.statusText} — ${responseText}`)
  }
  let responseRef: string
  try {
    const parsed = JSON.parse(responseText) as { reference?: string }
    if (!parsed.reference) throw new Error('missing reference field')
    responseRef = parsed.reference
  } catch (err) {
    throw new Error(`SOC upload returned invalid JSON: ${responseText}`, { cause: err })
  }
  if (responseRef.toLowerCase() !== socAddressHex.toLowerCase()) {
    throw new Error(
      `SOC stored under unexpected address: expected ${socAddressHex}, got ${responseRef}`,
    )
  }

  // Safety net: confirm the chunk actually landed at the SOC address.
  // Catches the case where Bee returns 200 but the chunk didn't persist.
  try {
    await withTimeout(
      options.bee.downloadChunk(socAddressHex),
      10_000,
      `feed[${options.kind}] SOC verify-download`,
    )
  } catch (err) {
    throw new Error(
      `SOC upload returned 200 but ${socAddressHex} is not retrievable: ${(err as Error).message}`,
      { cause: err },
    )
  }

  log(
    `feed[${options.kind}] updated · owner 0x${ownerHex}` +
      ` · epoch{start:${epoch.start},level:${epoch.level}}` +
      ` · t=${at}` +
      ` · soc=${socAddressHex}`,
  )
  return {
    owner: ownerHex,
    topic: FEED_TOPIC_STRINGS[options.kind],
    epoch: { start: epoch.start, level: epoch.level },
    timestamp: at,
  }
}

/**
 * Try to publish a feed update. Returns null (with a warning log) when no
 * signer is configured, so uploads continue to work without feeds.
 */
export async function tryPublishFeedUpdate(
  options: Omit<PublishFeedUpdateOptions, 'signer'> & { signer: PrivateKey | null },
): Promise<PublishFeedUpdateResult | null> {
  const log = options.onProgress ?? console.log
  if (!options.signer) {
    log(`feed[${options.kind}] skipped · set ${SIGNER_KEY_ENV} or --feed-signer-key to publish`)
    return null
  }
  try {
    return await publishFeedUpdate({ ...options, signer: options.signer })
  } catch (err) {
    log(`feed[${options.kind}] FAILED · ${(err as Error).message}`)
    return null
  }
}

/**
 * Shape of the JSON envelope uploaded for the POT feed payload. The explorer
 * fetches this via /bytes/{ref} and uses it to populate the four POT refs.
 */
export interface PotFeedEnvelope {
  byNumber: string
  byHash: string
  byTx: string
  byAddress: string
  byBalanceBlock: string
  meta: string | null
}

/**
 * Upload a POT envelope JSON as raw bytes and return its Swarm reference
 * (hex, no 0x). The reference is what gets stored in the POT feed update.
 */
export async function uploadPotEnvelope(
  bee: Bee,
  batchId: string,
  envelope: PotFeedEnvelope,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  const { reference } = await bee.uploadData(batchId, bytes)
  return reference.toHex()
}

/**
 * Race a Bee call against a wall-clock timeout. Mirrors the pattern used in
 * swarm-sqlite.ts — bee-js's axios has no default timeout, so a stalled Bee
 * endpoint otherwise hangs forever instead of failing loudly.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${msg}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId!))
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().toLowerCase().replace(/^0x/, '')
  if (h.length % 2 !== 0) throw new Error(`invalid hex length: ${h.length}`)
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
