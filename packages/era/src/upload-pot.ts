// CLI entry point for uploading block data to Swarm via POT JS indexes.
//
// Mirror of ./upload.ts, but with POT-backed indexing instead of Mantaray.
// Produces `eras-<range>.pot.json` with the three root references
// (byNumber / byHash / byTx) and upload stats.
//
// Usage:
//   pnpm era:upload-pot --batch-id <postage-batch-id> [--refs <pot-json>] [range]
//   pnpm era:upload-pot --batch-id abc123... 0..6
//   pnpm era:upload-pot --batch-id abc123... --refs data/eras-0.pot.json 1
//   pnpm era:upload-pot --bee-url http://bee.example.com --batch-id abc123... 5

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bee } from '@ethersphere/bee-js'
import { DATA_DIR, header, resolveTargets, type Target } from './cli-shared.js'
import { addBlocksToPot, openPotIndexes, savePotIndexes, type PotIndexRefs } from './swarm-pot.js'

// ---------- Parse arguments ----------

interface CliArgs {
  beeUrl?: string
  batchId?: string
  refsPath?: string
  target?: string
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) result.beeUrl = argv[++i]
    else if (arg === '--batch-id' && argv[i + 1]) result.batchId = argv[++i]
    else if (arg === '--refs' && argv[i + 1]) result.refsPath = argv[++i]
    else if (!arg.startsWith('--')) result.target = arg
  }
  return result
}

interface PotMetaFile {
  eras: number[]
  files: string[]
  uploadedAt: string
  beeUrl: string
  batchId: string
  extendedFrom: string | null
  indexes: PotIndexRefs
  blocksUploaded: number
  txHashesIndexed: number
}

async function loadExistingRefs(path: string): Promise<PotIndexRefs> {
  const raw = await readFile(path, 'utf8')
  const meta = JSON.parse(raw) as PotMetaFile
  if (!meta.indexes?.byNumber || !meta.indexes?.byHash || !meta.indexes?.byTx) {
    throw new Error(`${path}: missing indexes.{byNumber,byHash,byTx}`)
  }
  return meta.indexes
}

// ---------- Main ----------

const args = parseArgs(process.argv)

if (!args.batchId) {
  console.error('error: --batch-id is required')
  console.error('')
  console.error('Usage:')
  console.error('  pnpm era:upload-pot --batch-id <postage-batch-id> [--refs <pot-json>] [range]')
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload-pot --batch-id abc123... 0')
  console.error('  pnpm era:upload-pot --batch-id abc123... --refs data/eras-0.pot.json 1')
  console.error('  pnpm era:upload-pot --bee-url http://bee.example.com --batch-id abc123... 5')
  process.exit(1)
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

const existingRefs = args.refsPath ? await loadExistingRefs(args.refsPath) : undefined

const indexes = await openPotIndexes({
  beeUrl,
  batchId,
  existingRefs,
  onProgress: (msg) => console.log(msg),
})

const totals = { blocksUploaded: 0, txHashesIndexed: 0 }
const runStarted = Date.now()

for (const t of uploadable) {
  console.log(header(t))
  const started = Date.now()
  const res = await addBlocksToPot(bee, indexes, t.blocksPath, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
  })
  totals.blocksUploaded += res.blocksUploaded
  totals.txHashesIndexed += res.txHashesIndexed
  console.log(
    `       added ${res.blocksUploaded} blocks, ${res.txHashesIndexed} txs in ${Date.now() - started} ms`,
  )
}

console.log('\n== saving POT indexes ==')
const indexRefs = await savePotIndexes(indexes)
console.log(`       byNumber: ${indexRefs.byNumber}`)
console.log(`       byHash:   ${indexRefs.byHash}`)
console.log(`       byTx:     ${indexRefs.byTx}`)

const elapsed = Date.now() - runStarted

const firstEra = uploadable[0].era
const lastEra = uploadable[uploadable.length - 1].era
const rangeLabel =
  firstEra !== null && lastEra !== null
    ? firstEra === lastEra
      ? `${firstEra}`
      : `${firstEra}-${lastEra}`
    : uploadable[0].fileBase

const metaPath = resolve(DATA_DIR, `eras-${rangeLabel}.pot.json`)
const meta: PotMetaFile = {
  eras: uploadable.map((t) => t.era).filter((e): e is number => e !== null),
  files: uploadable.map((t) => t.fileBase),
  uploadedAt: new Date().toISOString(),
  beeUrl,
  batchId,
  extendedFrom: args.refsPath ?? null,
  indexes: indexRefs,
  blocksUploaded: totals.blocksUploaded,
  txHashesIndexed: totals.txHashesIndexed,
}
await writeFile(metaPath, JSON.stringify(meta, null, 2))

console.log(
  `\nupload ${totals.blocksUploaded} blocks, ${totals.txHashesIndexed} txs in ${elapsed} ms`,
)
console.log(`       written:  ${metaPath}`)
