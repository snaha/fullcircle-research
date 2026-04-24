// Shared state file tracking the latest uploaded Swarm references.
// Written by upload-pot, upload-sqlite, and publish-to-swarm after each
// successful upload. Read by publish-refs to get defaults for feed publishing.

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DATA_DIR } from './cli-shared.js'

const STATE_PATH = resolve(DATA_DIR, 'latest-refs.json')

export interface LatestRefs {
  publisher?: string
  manifest?: string
  feedManifest?: string
  pot?: string
  sqlite?: string
  updatedAt?: string
}

export async function loadLatestRefs(): Promise<LatestRefs> {
  if (!existsSync(STATE_PATH)) return {}
  try {
    const raw = await readFile(STATE_PATH, 'utf8')
    return JSON.parse(raw) as LatestRefs
  } catch {
    return {}
  }
}

export async function saveLatestRefs(patch: Omit<LatestRefs, 'updatedAt'>): Promise<void> {
  const existing = await loadLatestRefs()
  const updated: LatestRefs = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    updatedAt: new Date().toISOString(),
  }
  await writeFile(STATE_PATH, JSON.stringify(updated, null, 2))
  console.log(`refs saved → ${STATE_PATH}`)
}
