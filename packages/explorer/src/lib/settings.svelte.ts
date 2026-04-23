// Bee gateway URL + data source selection. Persisted in localStorage so the
// explorer remembers which source to query across reloads.
//
// Three sources are supported:
//   manifest — Mantaray manifest ref; data served via `/bzz/{ref}/...`.
//   pot      — four POT refs (byNumber / byHash / byTx / meta); bundle bytes
//              are resolved through POT key-value lookups, then fetched from
//              `/bytes/{ref}`.
//   sqlite   — SQLite database synced to Swarm as 4KB page chunks; lookups use
//              sql.js (SQLite WASM) to query the database, fetching pages
//              on-demand from Swarm.

import { browser } from '$app/environment'
import { resolveLatest } from './feed-resolver'

export type Source = 'manifest' | 'pot' | 'sqlite'

const KEY_BEE = 'fullcircle.explorer.beeUrl'
const KEY_SOURCE = 'fullcircle.explorer.source'
const KEY_PUBLISHER = 'fullcircle.explorer.publisherAddress'
const KEY_MANIFEST = 'fullcircle.explorer.manifestRef'
const KEY_POT_BY_NUMBER = 'fullcircle.explorer.pot.byNumber'
const KEY_POT_BY_HASH = 'fullcircle.explorer.pot.byHash'
const KEY_POT_BY_TX = 'fullcircle.explorer.pot.byTx'
const KEY_POT_META = 'fullcircle.explorer.pot.meta'
const KEY_SQLITE_DB_REF = 'fullcircle.explorer.sqlite.dbRef'
const KEY_SQLITE_META = 'fullcircle.explorer.sqlite.meta'

const DEFAULT_BEE = 'http://localhost:1633'
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

export const settings = $state({
  beeUrl: load(KEY_BEE, DEFAULT_BEE),
  source: loadSource(),
  publisherAddress: load(KEY_PUBLISHER, ''),
  manifestRef: load(KEY_MANIFEST, ''),
  potByNumber: load(KEY_POT_BY_NUMBER, ''),
  potByHash: load(KEY_POT_BY_HASH, ''),
  potByTx: load(KEY_POT_BY_TX, ''),
  potMeta: load(KEY_POT_META, ''),
  sqliteDbRef: load(KEY_SQLITE_DB_REF, ''),
  sqliteMeta: load(KEY_SQLITE_META, ''),
})

export interface SaveArgs {
  beeUrl: string
  source: Source
  publisherAddress: string
  manifestRef: string
  potByNumber: string
  potByHash: string
  potByTx: string
  potMeta: string
  sqliteDbRef: string
  sqliteMeta: string
}

export function saveSettings(args: SaveArgs): void {
  settings.beeUrl = args.beeUrl.trim().replace(/\/$/, '')
  settings.source = args.source
  settings.publisherAddress = normAddress(args.publisherAddress)
  settings.manifestRef = normHex(args.manifestRef)
  settings.potByNumber = normHex(args.potByNumber)
  settings.potByHash = normHex(args.potByHash)
  settings.potByTx = normHex(args.potByTx)
  settings.potMeta = normHex(args.potMeta)
  settings.sqliteDbRef = normHex(args.sqliteDbRef)
  settings.sqliteMeta = normHex(args.sqliteMeta)
  if (browser) {
    localStorage.setItem(KEY_BEE, settings.beeUrl)
    localStorage.setItem(KEY_SOURCE, settings.source)
    localStorage.setItem(KEY_PUBLISHER, settings.publisherAddress)
    localStorage.setItem(KEY_MANIFEST, settings.manifestRef)
    localStorage.setItem(KEY_POT_BY_NUMBER, settings.potByNumber)
    localStorage.setItem(KEY_POT_BY_HASH, settings.potByHash)
    localStorage.setItem(KEY_POT_BY_TX, settings.potByTx)
    localStorage.setItem(KEY_POT_META, settings.potMeta)
    localStorage.setItem(KEY_SQLITE_DB_REF, settings.sqliteDbRef)
    localStorage.setItem(KEY_SQLITE_META, settings.sqliteMeta)
  }
}

/**
 * Write a single ref field back to `settings` and localStorage. Used after
 * feed resolution so the resolved values are kept across reloads.
 */
function updateRef(key: string, value: string): void {
  if (browser) localStorage.setItem(key, value)
}

/**
 * Resolve the active source's refs from the publisher's epoch feed. Writes
 * the result into `settings` and localStorage so the explorer behaves as if
 * the user had pasted them manually. Does nothing if publisherAddress is
 * empty. Throws on feed-resolution errors so callers can surface them.
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
    settings.potMeta = resolved.meta ?? ''
    updateRef(KEY_POT_BY_NUMBER, resolved.byNumber)
    updateRef(KEY_POT_BY_HASH, resolved.byHash)
    updateRef(KEY_POT_BY_TX, resolved.byTx)
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

/** True when address → balance lookup is available. Manifest-only for now. */
export function hasAddressIndex(): boolean {
  return settings.source === 'manifest' && isHex64(settings.manifestRef)
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
