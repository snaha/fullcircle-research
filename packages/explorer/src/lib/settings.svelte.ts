// Bee gateway URL + manifest reference. Persisted in localStorage so the
// explorer remembers which Swarm manifest to query across reloads.

import { browser } from '$app/environment'

const KEY_BEE = 'fullcircle.explorer.beeUrl'
const KEY_MANIFEST = 'fullcircle.explorer.manifestRef'

const DEFAULT_BEE = 'http://localhost:1633'

function load(key: string, fallback: string): string {
  if (!browser) return fallback
  return localStorage.getItem(key) ?? fallback
}

export const settings = $state({
  beeUrl: load(KEY_BEE, DEFAULT_BEE),
  manifestRef: load(KEY_MANIFEST, ''),
})

export function saveSettings(beeUrl: string, manifestRef: string): void {
  settings.beeUrl = beeUrl.trim().replace(/\/$/, '')
  settings.manifestRef = manifestRef.trim().toLowerCase().replace(/^0x/, '')
  if (browser) {
    localStorage.setItem(KEY_BEE, settings.beeUrl)
    localStorage.setItem(KEY_MANIFEST, settings.manifestRef)
  }
}

export function hasManifest(): boolean {
  return /^[0-9a-f]{64}$/.test(settings.manifestRef)
}
