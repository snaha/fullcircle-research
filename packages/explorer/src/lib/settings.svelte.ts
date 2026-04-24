// Bee gateway URL + data source selection. Persisted in localStorage so the
// explorer remembers which source to query across reloads.
//
// Three sources are supported:
//   manifest — Mantaray manifest ref; data served via `/bzz/{ref}/...`.
//   pot      — six POT refs (byNumber / byHash / byTx / byAddress /
//              byBalanceBlock / meta); bundle, account, and balance-events
//              bytes are resolved through POT key-value lookups, then fetched
//              from `/bytes/{ref}`. A single envelope ref can hydrate all of
//              them — see `hydratePotFromEnvelope`.
//   sqlite   — SQLite database synced to Swarm as 4KB page chunks; lookups use
//              sql.js (SQLite WASM) to query the database, fetching pages
//              on-demand from Swarm.
//
// Build-time defaults are injected by vite.config.ts from data/latest-refs.json
// so the explorer works out of the box without the user opening settings.

import { browser } from '$app/environment'
import { fetchPotEnvelope, resolveLatest } from './feed-resolver'

// Injected at build time from data/latest-refs.json
declare const __BUILD_PUBLISHER__: string
declare const __BUILD_MANIFEST__: string
declare const __BUILD_POT__: string
declare const __BUILD_SQLITE__: string
// Injected at build time from FULLCIRCLE_BEE_URL env var (default: localhost:1633)
declare const __BUILD_BEE_URL__: string

export type Source = 'manifest' | 'pot' | 'sqlite'

const KEY_BEE = 'fullcircle.explorer.beeUrl'
const KEY_USE_FEED = 'fullcircle.explorer.useFeed'
const KEY_SOURCE = 'fullcircle.explorer.source'
const KEY_PUBLISHER = 'fullcircle.explorer.publisherAddress'
const KEY_MANIFEST = 'fullcircle.explorer.manifestRef'
const KEY_POT_BY_NUMBER = 'fullcircle.explorer.pot.byNumber'
const KEY_POT_BY_HASH = 'fullcircle.explorer.pot.byHash'
const KEY_POT_BY_TX = 'fullcircle.explorer.pot.byTx'
const KEY_POT_BY_ADDRESS = 'fullcircle.explorer.pot.byAddress'
const KEY_POT_BY_BALANCE_BLOCK = 'fullcircle.explorer.pot.byBalanceBlock'
const KEY_POT_META = 'fullcircle.explorer.pot.meta'
const KEY_SQLITE_DB_REF = 'fullcircle.explorer.sqlite.dbRef'
const KEY_SQLITE_META = 'fullcircle.explorer.sqlite.meta'

const DEFAULT_BEE = __BUILD_BEE_URL__
const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const ZERO_REF = '0'.repeat(64)

function load(key: string, fallback: string): string {
  if (!browser) return fallback
  return localStorage.getItem(key) ?? fallback
}

function loadSource(): Source {
  const raw = load(KEY_SOURCE, 'manifest')
  if (raw === 'pot') return 'pot'
  if (raw === 'sqlite') return 'sqlite'
  return 'manifest'
}

function loadUseFeed(): boolean {
  if (!browser) return true
  const stored = localStorage.getItem(KEY_USE_FEED)
  // Default to true (use feed) when not previously set
  return stored === null ? true : stored === 'true'
}

export const settings = $state({
  beeUrl: load(KEY_BEE, DEFAULT_BEE),
  useFeed: loadUseFeed(),
  source: loadSource(),
  publisherAddress: load(KEY_PUBLISHER, __BUILD_PUBLISHER__),
  manifestRef: load(KEY_MANIFEST, __BUILD_MANIFEST__),
  potByNumber: load(KEY_POT_BY_NUMBER, __BUILD_POT__),
  potByHash: load(KEY_POT_BY_HASH, ''),
  potByTx: load(KEY_POT_BY_TX, ''),
  potByAddress: load(KEY_POT_BY_ADDRESS, ''),
  potByBalanceBlock: load(KEY_POT_BY_BALANCE_BLOCK, ''),
  potMeta: load(KEY_POT_META, ''),
  sqliteDbRef: load(KEY_SQLITE_DB_REF, __BUILD_SQLITE__),
  sqliteMeta: load(KEY_SQLITE_META, ''),
})

export interface SaveArgs {
  beeUrl: string
  useFeed: boolean
  source: Source
  publisherAddress: string
  manifestRef: string
  potByNumber: string
  potByHash: string
  potByTx: string
  potByAddress: string
  potByBalanceBlock: string
  potMeta: string
  sqliteDbRef: string
  sqliteMeta: string
}

export function saveSettings(args: SaveArgs): void {
  settings.beeUrl = args.beeUrl.trim().replace(/\/$/, '')
  settings.useFeed = args.useFeed
  settings.source = args.source
  settings.publisherAddress = normAddress(args.publisherAddress)
  settings.manifestRef = normHex(args.manifestRef)
  settings.potByNumber = normHex(args.potByNumber)
  settings.potByHash = normHex(args.potByHash)
  settings.potByTx = normHex(args.potByTx)
  settings.potByAddress = normHex(args.potByAddress)
  settings.potByBalanceBlock = normHex(args.potByBalanceBlock)
  settings.potMeta = normHex(args.potMeta)
  settings.sqliteDbRef = normHex(args.sqliteDbRef)
  settings.sqliteMeta = normHex(args.sqliteMeta)
  if (browser) {
    localStorage.setItem(KEY_BEE, settings.beeUrl)
    localStorage.setItem(KEY_USE_FEED, String(settings.useFeed))
    localStorage.setItem(KEY_SOURCE, settings.source)
    localStorage.setItem(KEY_PUBLISHER, settings.publisherAddress)
    localStorage.setItem(KEY_MANIFEST, settings.manifestRef)
    localStorage.setItem(KEY_POT_BY_NUMBER, settings.potByNumber)
    localStorage.setItem(KEY_POT_BY_HASH, settings.potByHash)
    localStorage.setItem(KEY_POT_BY_TX, settings.potByTx)
    localStorage.setItem(KEY_POT_BY_ADDRESS, settings.potByAddress)
    localStorage.setItem(KEY_POT_BY_BALANCE_BLOCK, settings.potByBalanceBlock)
    localStorage.setItem(KEY_POT_META, settings.potMeta)
    localStorage.setItem(KEY_SQLITE_DB_REF, settings.sqliteDbRef)
    localStorage.setItem(KEY_SQLITE_META, settings.sqliteMeta)
  }
}

/**
 * Hydrate every POT ref from a single envelope ref (the JSON bundle the
 * uploader writes unconditionally at the end of `upload-pot`). Writes the
 * resolved values straight into `settings` + localStorage so the user doesn't
 * need to paste each ref individually.
 */
export async function hydratePotFromEnvelope(envelopeRef: string): Promise<void> {
  const resolved = await fetchPotEnvelope(settings.beeUrl, envelopeRef)
  settings.potByNumber = resolved.byNumber
  settings.potByHash = resolved.byHash
  settings.potByTx = resolved.byTx
  settings.potByAddress = resolved.byAddress
  settings.potByBalanceBlock = resolved.byBalanceBlock
  settings.potMeta = resolved.meta ?? ''
  updateRef(KEY_POT_BY_NUMBER, resolved.byNumber)
  updateRef(KEY_POT_BY_HASH, resolved.byHash)
  updateRef(KEY_POT_BY_TX, resolved.byTx)
  updateRef(KEY_POT_BY_ADDRESS, resolved.byAddress)
  updateRef(KEY_POT_BY_BALANCE_BLOCK, resolved.byBalanceBlock)
  updateRef(KEY_POT_META, resolved.meta ?? '')
}

/**
 * Write a single ref field back to `settings` and localStorage. Used after
 * feed resolution so the resolved values are kept across reloads.
 */
function updateRef(key: string, value: string): void {
  if (browser) localStorage.setItem(key, value)
}

/**
 * Resolve the active source's refs from the publisher's epoch feed. Always
 * re-resolves (ignores any previously cached ref) — intended for use when
 * useFeed is true. Throws on feed-resolution errors.
 */
export async function resolveActiveSourceFromFeed(): Promise<void> {
  if (!isAddress(settings.publisherAddress)) return
  const resolved = await resolveLatest(settings.beeUrl, settings.publisherAddress, settings.source)
  if (resolved.kind === 'manifest') {
    settings.manifestRef = resolved.manifestRef
    updateRef(KEY_MANIFEST, resolved.manifestRef)
  } else if (resolved.kind === 'sqlite') {
    settings.sqliteDbRef = resolved.dbRef
    updateRef(KEY_SQLITE_DB_REF, resolved.dbRef)
  } else {
    settings.potByNumber = resolved.byNumber
    settings.potByHash = resolved.byHash
    settings.potByTx = resolved.byTx
    settings.potByAddress = resolved.byAddress
    settings.potByBalanceBlock = resolved.byBalanceBlock
    settings.potMeta = resolved.meta ?? ''
    updateRef(KEY_POT_BY_NUMBER, resolved.byNumber)
    updateRef(KEY_POT_BY_HASH, resolved.byHash)
    updateRef(KEY_POT_BY_TX, resolved.byTx)
    updateRef(KEY_POT_BY_ADDRESS, resolved.byAddress)
    updateRef(KEY_POT_BY_BALANCE_BLOCK, resolved.byBalanceBlock)
    updateRef(KEY_POT_META, resolved.meta ?? '')
  }
}

function normHex(s: string): string {
  return s.trim().toLowerCase().replace(/^0x/, '')
}

function normAddress(s: string): string {
  const hex = s.trim().toLowerCase().replace(/^0x/, '')
  return HEX40.test(hex) ? hex : ''
}

export function isHex64(s: string): boolean {
  return HEX64.test(s)
}

export function isAddress(s: string): boolean {
  return HEX40.test(s)
}

/** True when the selected source has the minimum refs needed to serve blocks. */
export function hasSource(): boolean {
  if (settings.source === 'manifest') return isHex64(settings.manifestRef)
  if (settings.source === 'sqlite') return isHex64(settings.sqliteDbRef)
  return isHex64(settings.potByNumber) && isHex64(settings.potByHash)
}

/** True when tx-hash → block lookup is available on the selected source. */
export function hasTxIndex(): boolean {
  if (settings.source === 'manifest') return isHex64(settings.manifestRef)
  if (settings.source === 'sqlite') return isHex64(settings.sqliteDbRef)
  return isHex64(settings.potByTx) && settings.potByTx !== ZERO_REF
}

/** True when address → balance lookup is available. */
export function hasAddressIndex(): boolean {
  if (settings.source === 'manifest') return isHex64(settings.manifestRef)
  if (settings.source === 'pot') {
    return isHex64(settings.potByAddress) && settings.potByAddress !== ZERO_REF
  }
  return false
}

/** Short human label for the current source — used in the header badge. */
export function sourceLabel(): string {
  if (settings.source === 'manifest') {
    return `manifest · ${short(settings.manifestRef)}`
  }
  if (settings.source === 'sqlite') {
    return `sqlite · ${short(settings.sqliteDbRef)}`
  }
  return `pot · ${short(settings.potByNumber)}`
}

function short(ref: string): string {
  if (!isHex64(ref)) return '(unset)'
  return `${ref.slice(0, 10)}…${ref.slice(-6)}`
}
