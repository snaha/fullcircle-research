// Bee gateway URL + data source selection. Persisted in localStorage so the
// explorer remembers which source to query across reloads.
//
// Two sources are supported:
//   manifest — Mantaray manifest ref; data served via `/bzz/{ref}/...`.
//   pot      — four POT refs (byNumber / byHash / byTx / meta); bundle bytes
//              are resolved through POT key-value lookups, then fetched from
//              `/bytes/{ref}`.

import { browser } from '$app/environment'

export type Source = 'manifest' | 'pot'

const KEY_BEE = 'fullcircle.explorer.beeUrl'
const KEY_SOURCE = 'fullcircle.explorer.source'
const KEY_MANIFEST = 'fullcircle.explorer.manifestRef'
const KEY_POT_BY_NUMBER = 'fullcircle.explorer.pot.byNumber'
const KEY_POT_BY_HASH = 'fullcircle.explorer.pot.byHash'
const KEY_POT_BY_TX = 'fullcircle.explorer.pot.byTx'
const KEY_POT_META = 'fullcircle.explorer.pot.meta'

const DEFAULT_BEE = 'http://localhost:1633'
const HEX64 = /^[0-9a-f]{64}$/
const ZERO_REF = '0'.repeat(64)

function load(key: string, fallback: string): string {
  if (!browser) return fallback
  return localStorage.getItem(key) ?? fallback
}

function loadSource(): Source {
  const raw = load(KEY_SOURCE, 'manifest')
  return raw === 'pot' ? 'pot' : 'manifest'
}

export const settings = $state({
  beeUrl: load(KEY_BEE, DEFAULT_BEE),
  source: loadSource(),
  manifestRef: load(KEY_MANIFEST, ''),
  potByNumber: load(KEY_POT_BY_NUMBER, ''),
  potByHash: load(KEY_POT_BY_HASH, ''),
  potByTx: load(KEY_POT_BY_TX, ''),
  potMeta: load(KEY_POT_META, ''),
})

export interface SaveArgs {
  beeUrl: string
  source: Source
  manifestRef: string
  potByNumber: string
  potByHash: string
  potByTx: string
  potMeta: string
}

export function saveSettings(args: SaveArgs): void {
  settings.beeUrl = args.beeUrl.trim().replace(/\/$/, '')
  settings.source = args.source
  settings.manifestRef = normHex(args.manifestRef)
  settings.potByNumber = normHex(args.potByNumber)
  settings.potByHash = normHex(args.potByHash)
  settings.potByTx = normHex(args.potByTx)
  settings.potMeta = normHex(args.potMeta)
  if (browser) {
    localStorage.setItem(KEY_BEE, settings.beeUrl)
    localStorage.setItem(KEY_SOURCE, settings.source)
    localStorage.setItem(KEY_MANIFEST, settings.manifestRef)
    localStorage.setItem(KEY_POT_BY_NUMBER, settings.potByNumber)
    localStorage.setItem(KEY_POT_BY_HASH, settings.potByHash)
    localStorage.setItem(KEY_POT_BY_TX, settings.potByTx)
    localStorage.setItem(KEY_POT_META, settings.potMeta)
  }
}

function normHex(s: string): string {
  return s.trim().toLowerCase().replace(/^0x/, '')
}

export function isHex64(s: string): boolean {
  return HEX64.test(s)
}

/** True when the selected source has the minimum refs needed to serve blocks. */
export function hasSource(): boolean {
  if (settings.source === 'manifest') return isHex64(settings.manifestRef)
  return isHex64(settings.potByNumber) && isHex64(settings.potByHash)
}

/** True when tx-hash → block lookup is available on the selected source. */
export function hasTxIndex(): boolean {
  if (settings.source === 'manifest') return isHex64(settings.manifestRef)
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
  return `pot · ${short(settings.potByNumber)}`
}

function short(ref: string): string {
  if (!isHex64(ref)) return '(unset)'
  return `${ref.slice(0, 10)}…${ref.slice(-6)}`
}
