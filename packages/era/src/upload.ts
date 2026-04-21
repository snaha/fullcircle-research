// CLI entry point for uploading block data to Swarm.
//
// Usage:
//   pnpm era:upload --batch-id <postage-batch-id> [--manifest <hash>] [range]
//   pnpm era:upload --batch-id abc123... 0..6
//   pnpm era:upload --batch-id abc123... --manifest def456... 1
//   pnpm era:upload --bee-url http://bee.example.com --batch-id abc123... 5

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bee } from '@ethersphere/bee-js'
import { DATA_DIR, header, resolveTargets, type Target } from './cli-shared.js'
import {
  addBlocksToManifest,
  getManifestBlockRange,
  openManifest,
  saveManifest,
  writeBlockRangeMeta,
} from './swarm.js'

// ---------- Parse arguments ----------

function parseArgs(argv: string[]): {
  beeUrl?: string
  batchId?: string
  manifestHash?: string
  target?: string
  cacheManifest: boolean
} {
  const result: {
    beeUrl?: string
    batchId?: string
    manifestHash?: string
    target?: string
    cacheManifest: boolean
  } = { cacheManifest: true }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) {
      result.beeUrl = argv[++i]
    } else if (arg === '--batch-id' && argv[i + 1]) {
      result.batchId = argv[++i]
    } else if (arg === '--manifest' && argv[i + 1]) {
      result.manifestHash = argv[++i]
    } else if (arg === '--no-manifest-cache') {
      result.cacheManifest = false
    } else if (!arg.startsWith('--')) {
      result.target = arg
    }
  }

  return result
}

const args = parseArgs(process.argv)

if (!args.batchId) {
  console.error('error: --batch-id is required')
  console.error('')
  console.error('Usage:')
  console.error(
    '  pnpm era:upload --batch-id <postage-batch-id> [--manifest <hash>] [--no-manifest-cache] [range]',
  )
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload --batch-id abc123... 0')
  console.error('  pnpm era:upload --batch-id abc123... --manifest def456... 1')
  console.error('  pnpm era:upload --bee-url http://bee.example.com --batch-id abc123... 5')
  console.error('  pnpm era:upload --batch-id abc123... --no-manifest-cache 1')
  process.exit(1)
}

// ---------- Main ----------

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  const msPart = ms % 1_000

  // Drop leading zero units, but pad subsequent units so columns line up.
  let pretty: string
  if (h > 0) {
    pretty = `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s ${String(msPart).padStart(3, '0')}ms`
  } else if (m > 0) {
    pretty = `${m}m ${String(s).padStart(2, '0')}s ${String(msPart).padStart(3, '0')}ms`
  } else if (s > 0) {
    pretty = `${s}s ${String(msPart).padStart(3, '0')}ms`
  } else {
    pretty = `${msPart}ms`
  }
  return `${ms} ms (${pretty})`
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const result = await fn()
  console.log(`⏱  ${label}: ${formatDuration(Date.now() - started)}`)
  return result
}

const batchId = args.batchId
const beeUrl = args.beeUrl ?? 'http://localhost:1633'
const bee = new Bee(beeUrl)

const targets = await resolveTargets(args.target)
const uploadable: Target[] = []
for (const t of targets) {
  if (!existsSync(t.blocksPath)) {
    console.error(`skip   no blocks file at ${t.blocksPath} — run "pnpm era:process" first`)
    continue
  }
  uploadable.push(t)
}

if (uploadable.length === 0) {
  console.error('error: nothing to upload')
  process.exit(1)
}

// Single manifest for the whole range: load once (or start fresh), mutate as
// we process each blocks file, save exactly once at the end. Uploading a
// growing manifest per-era would be O(N²) chunks.
const manifest = await timed('open manifest', () =>
  openManifest(bee, {
    manifestHash: args.manifestHash,
    onProgress: (msg) => console.log(msg),
    cacheManifest: args.cacheManifest,
  }),
)

const rangeBefore = getManifestBlockRange(manifest)
if (rangeBefore) {
  console.log(`before: firstBlock=${rangeBefore.firstBlock} lastBlock=${rangeBefore.lastBlock}`)
} else {
  console.log('before: empty manifest')
}

const totals = { blocksUploaded: 0, txHashesIndexed: 0 }
const runStarted = Date.now()

for (const t of uploadable) {
  console.log(header(t))
  const started = Date.now()

  const res = await addBlocksToManifest(bee, manifest, t.blocksPath, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
  })

  totals.blocksUploaded += res.blocksUploaded
  totals.txHashesIndexed += res.txHashesIndexed
  console.log(
    `       added ${res.blocksUploaded} blocks, ${res.txHashesIndexed} txs in ${formatDuration(Date.now() - started)}`,
  )
}

console.log('\n== manifest ==')
const meta = await timed('write /meta', () =>
  writeBlockRangeMeta(bee, manifest, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
  }),
)
const manifestReference = await timed('save manifest', () =>
  saveManifest(bee, manifest, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
    cacheManifest: args.cacheManifest,
  }),
)

if (meta) {
  console.log(`after:  firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock}`)
} else {
  console.log('after:  empty manifest')
}

const elapsed = Date.now() - runStarted

// Write one manifest metadata file describing the whole range.
const firstEra = uploadable[0].era
const lastEra = uploadable[uploadable.length - 1].era
const rangeLabel =
  firstEra !== null && lastEra !== null
    ? firstEra === lastEra
      ? `${firstEra}`
      : `${firstEra}-${lastEra}`
    : uploadable[0].fileBase

const manifestPath = resolve(DATA_DIR, `eras-${rangeLabel}.manifest.json`)
const manifestData = {
  eras: uploadable.map((t) => t.era).filter((e): e is number => e !== null),
  files: uploadable.map((t) => t.fileBase),
  uploadedAt: new Date().toISOString(),
  beeUrl,
  batchId,
  extendedFrom: args.manifestHash ?? null,
  manifestReference,
  firstBlock: meta?.firstBlock ?? null,
  lastBlock: meta?.lastBlock ?? null,
  blocksUploaded: totals.blocksUploaded,
  txHashesIndexed: totals.txHashesIndexed,
}
await writeFile(manifestPath, JSON.stringify(manifestData, null, 2))

console.log(
  `\nupload ${totals.blocksUploaded} blocks, ${totals.txHashesIndexed} txs in ${formatDuration(elapsed)}`,
)
console.log(`       manifest: ${manifestReference}`)
console.log(`       written:  ${manifestPath}`)
