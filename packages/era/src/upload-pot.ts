// CLI entry point for uploading block data to Swarm via POT JS indexes.
//
// Mirror of ./upload.ts, but with POT-backed indexing instead of Mantaray.
// Produces `eras-<range>.pot.json` with every root reference
// (byNumber / byHash / byTx / byAddress / byBalanceBlock / meta), the
// consolidated `envelope` ref, and upload stats.
//
// Usage:
//   pnpm era:upload-pot --batch-id <postage-batch-id> [--refs <pot-json>] [--no-state] [range]
//   pnpm era:upload-pot --batch-id abc123... 0..6
//   pnpm era:upload-pot --batch-id abc123... --refs data/eras-0.pot.json 1
//   pnpm era:upload-pot --bee-url http://bee.example.com --batch-id abc123... 5
//   pnpm era:upload-pot --batch-id abc123... --no-state 0..6   # skip balance events

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bee } from '@ethersphere/bee-js'
import { DATA_DIR, header, parseFeedSignerFlag, resolveTargets, type Target } from './cli-shared.js'
import { loadSigner, tryPublishFeedUpdate, uploadPotEnvelope } from './feed-publisher.js'
import {
  addBalanceEventsToPot,
  addBlocksToPot,
  getPotBlockRange,
  openPotIndexes,
  savePotIndexes,
  writePotBlockRangeMeta,
  type PotIndexRefs,
} from './swarm-pot.js'

// ---------- Parse arguments ----------

interface CliArgs {
  beeUrl?: string
  batchId?: string
  refsPath?: string
  target?: string
  noState: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { noState: false }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) result.beeUrl = argv[++i]
    else if (arg === '--batch-id' && argv[i + 1]) result.batchId = argv[++i]
    else if (arg === '--refs' && argv[i + 1]) result.refsPath = argv[++i]
    else if (arg === '--no-state') result.noState = true
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
  envelope: string | null
  firstBlock: string | null
  lastBlock: string | null
  blocksUploaded: number
  txHashesIndexed: number
  addressesUploaded: number
  stateBlocksUploaded: number
  eventsUploaded: number
}

async function loadExistingRefs(path: string): Promise<PotIndexRefs> {
  const raw = await readFile(path, 'utf8')
  const meta = JSON.parse(raw) as PotMetaFile
  if (!meta.indexes?.byNumber || !meta.indexes?.byHash || !meta.indexes?.byTx) {
    throw new Error(`${path}: missing indexes.{byNumber,byHash,byTx}`)
  }
  return {
    byNumber: meta.indexes.byNumber,
    byHash: meta.indexes.byHash,
    byTx: meta.indexes.byTx,
    byAddress: meta.indexes.byAddress ?? '',
    byBalanceBlock: meta.indexes.byBalanceBlock ?? '',
    meta: meta.indexes.meta ?? null,
  }
}

// ---------- Duration helpers ----------

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  const msPart = ms % 1_000

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

// ---------- Main ----------

const args = parseArgs(process.argv)

if (!args.batchId) {
  console.error('error: --batch-id is required')
  console.error('')
  console.error('Usage:')
  console.error(
    '  pnpm era:upload-pot --batch-id <postage-batch-id> [--refs <pot-json>] [--no-state] [range]',
  )
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload-pot --batch-id abc123... 0')
  console.error('  pnpm era:upload-pot --batch-id abc123... --refs data/eras-0.pot.json 1')
  console.error('  pnpm era:upload-pot --bee-url http://bee.example.com --batch-id abc123... 5')
  console.error(
    '  pnpm era:upload-pot --batch-id abc123... --no-state 0..6   # skip balance events',
  )
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

const indexes = await timed('open indexes', () =>
  openPotIndexes({
    bee,
    beeUrl,
    batchId,
    existingRefs,
    onProgress: (msg) => console.log(msg),
  }),
)

const rangeBefore = getPotBlockRange(indexes)
if (rangeBefore) {
  console.log(`before: firstBlock=${rangeBefore.firstBlock} lastBlock=${rangeBefore.lastBlock}`)
} else {
  console.log('before: empty indexes')
}

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
    `       added ${res.blocksUploaded} blocks, ${res.txHashesIndexed} txs in ${formatDuration(Date.now() - started)}`,
  )
}

const stateTotals = { addressCount: 0, blockCount: 0, eventCount: 0 }
if (!args.noState) {
  const eventsPaths = uploadable.map((t) => t.balanceEventsPath).filter((p) => existsSync(p))
  const skipped = uploadable.length - eventsPaths.length
  if (eventsPaths.length > 0) {
    console.log('\n== state ==')
    if (skipped > 0) {
      console.log(`note: ${skipped} era(s) have no balance-events file — skipping those`)
    }
    const stateRes = await timed('add state events', () =>
      addBalanceEventsToPot(bee, indexes, eventsPaths, {
        batchId,
        onProgress: (msg) => console.log(`       ${msg}`),
      }),
    )
    stateTotals.addressCount = stateRes.addressCount
    stateTotals.blockCount = stateRes.blockCount
    stateTotals.eventCount = stateRes.eventCount
  } else {
    console.log(
      '\nno balance-events files found — run "pnpm era:state-extract" first to index state',
    )
  }
}

console.log('\n== saving POT indexes ==')
const meta = await timed('write meta', () =>
  writePotBlockRangeMeta(bee, indexes, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
  }),
)
const indexRefs = await timed('save indexes', () => savePotIndexes(indexes))
console.log(`       byNumber:       ${indexRefs.byNumber}`)
console.log(`       byHash:         ${indexRefs.byHash}`)
console.log(`       byTx:           ${indexRefs.byTx}`)
console.log(`       byAddress:      ${indexRefs.byAddress}`)
console.log(`       byBalanceBlock: ${indexRefs.byBalanceBlock}`)
console.log(`       meta:           ${indexRefs.meta ?? '(none)'}`)

if (meta) {
  console.log(`after:  firstBlock=${meta.firstBlock} lastBlock=${meta.lastBlock}`)
} else {
  console.log('after:  empty indexes')
}

const elapsed = Date.now() - runStarted

const firstEra = uploadable[0].era
const lastEra = uploadable[uploadable.length - 1].era
const rangeLabel =
  firstEra !== null && lastEra !== null
    ? firstEra === lastEra
      ? `${firstEra}`
      : `${firstEra}-${lastEra}`
    : uploadable[0].fileBase

// Upload a single envelope JSON carrying every POT ref (+ meta). Done
// unconditionally so a user with no feed signer still gets one pasteable
// reference instead of six. The feed (if enabled) also stores this ref.
const envelopeRef = await timed('upload envelope', () =>
  uploadPotEnvelope(bee, batchId, {
    byNumber: indexRefs.byNumber,
    byHash: indexRefs.byHash,
    byTx: indexRefs.byTx,
    byAddress: indexRefs.byAddress,
    byBalanceBlock: indexRefs.byBalanceBlock,
    meta: indexRefs.meta,
  }),
)

const metaPath = resolve(DATA_DIR, `eras-${rangeLabel}.pot.json`)
const metaFile: PotMetaFile = {
  eras: uploadable.map((t) => t.era).filter((e): e is number => e !== null),
  files: uploadable.map((t) => t.fileBase),
  uploadedAt: new Date().toISOString(),
  beeUrl,
  batchId,
  extendedFrom: args.refsPath ?? null,
  indexes: indexRefs,
  envelope: envelopeRef,
  firstBlock: meta?.firstBlock ?? null,
  lastBlock: meta?.lastBlock ?? null,
  blocksUploaded: totals.blocksUploaded,
  txHashesIndexed: totals.txHashesIndexed,
  addressesUploaded: stateTotals.addressCount,
  stateBlocksUploaded: stateTotals.blockCount,
  eventsUploaded: stateTotals.eventCount,
}
await writeFile(metaPath, JSON.stringify(metaFile, null, 2))

console.log(
  `\nupload ${totals.blocksUploaded} blocks, ${totals.txHashesIndexed} txs,` +
    ` ${stateTotals.addressCount} addresses, ${stateTotals.eventCount} events` +
    ` in ${formatDuration(elapsed)}`,
)
console.log(`       envelope: ${envelopeRef}`)
console.log(`       written:  ${metaPath}`)

const signer = loadSigner(parseFeedSignerFlag(process.argv))
await tryPublishFeedUpdate({
  kind: 'pot',
  referenceHex: envelopeRef,
  bee,
  batchId,
  signer,
})
