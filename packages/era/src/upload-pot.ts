// CLI entry point for uploading block data to Swarm via POT JS indexes.
//
// Mirror of ./upload.ts, but with POT-backed indexing instead of Mantaray.
// Produces `eras-<range>.pot.json` with the four root references
// (byNumber / byHash / byTx / meta) and upload stats.
//
// Usage:
//   pnpm era:upload-pot --batch-id <postage-batch-id> [--refs <pot-json>] [--chunks | --ws] [range]
//   pnpm era:upload-pot --batch-id abc123... 0..6
//   pnpm era:upload-pot --batch-id abc123... --refs data/eras-0.pot.json 1
//   pnpm era:upload-pot --bee-url http://bee.example.com --batch-id abc123... 5
//   pnpm era:upload-pot --batch-id abc123... --chunks 11   # HTTP /chunks (client-chunked)
//   pnpm era:upload-pot --batch-id abc123... --ws 11       # WebSocket /chunks/stream

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bee } from '@ethersphere/bee-js'
import { DATA_DIR, header, resolveTargets, type Target } from './cli-shared.js'
import { uploadBundleAsTree, type ChunkUploader } from './swarm-chunk.js'
import {
  addBlocksToPot,
  getPotBlockRange,
  openPotIndexes,
  savePotIndexes,
  writePotBlockRangeMeta,
  type BundleUploader,
  type PotIndexRefs,
} from './swarm-pot.js'
import { BeeChunkStream } from './swarm-ws.js'

// ---------- Parse arguments ----------

type UploadMode = 'bytes' | 'chunks' | 'ws'

interface CliArgs {
  beeUrl?: string
  batchId?: string
  refsPath?: string
  target?: string
  uploadMode: UploadMode
  useTag: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { uploadMode: 'bytes', useTag: true }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) result.beeUrl = argv[++i]
    else if (arg === '--batch-id' && argv[i + 1]) result.batchId = argv[++i]
    else if (arg === '--refs' && argv[i + 1]) result.refsPath = argv[++i]
    else if (arg === '--chunks') result.uploadMode = 'chunks'
    else if (arg === '--ws') result.uploadMode = 'ws'
    else if (arg === '--no-tag') result.useTag = false
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
  firstBlock: string | null
  lastBlock: string | null
  blocksUploaded: number
  txHashesIndexed: number
}

async function loadExistingRefs(path: string): Promise<PotIndexRefs> {
  const raw = await readFile(path, 'utf8')
  const meta = JSON.parse(raw) as PotMetaFile
  if (!meta.indexes?.byNumber || !meta.indexes?.byHash || !meta.indexes?.byTx) {
    throw new Error(`${path}: missing indexes.{byNumber,byHash,byTx}`)
  }
  return { ...meta.indexes, meta: meta.indexes.meta ?? null }
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
    '  pnpm era:upload-pot --batch-id <postage-batch-id> [--refs <pot-json>] [--chunks | --ws] [range]',
  )
  console.error('')
  console.error('Upload mode (for block bundles — POT chunks still go via the WASM runtime):')
  console.error('  default     HTTP POST /bytes — Bee chunks and BMT-hashes on the server side')
  console.error(
    '  --chunks    HTTP POST /chunks — client pre-chunks + BMT-hashes, one HTTP / chunk',
  )
  console.error(
    '  --ws        WebSocket /chunks/stream — same as --chunks but pipelined on one socket',
  )
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload-pot --batch-id abc123... 0')
  console.error('  pnpm era:upload-pot --batch-id abc123... --refs data/eras-0.pot.json 1')
  console.error('  pnpm era:upload-pot --bee-url http://bee.example.com --batch-id abc123... 5')
  console.error('  pnpm era:upload-pot --batch-id abc123... --chunks 11')
  console.error('  pnpm era:upload-pot --batch-id abc123... --ws 11')
  process.exit(1)
}

const batchId = args.batchId
const beeUrl = args.beeUrl ?? 'http://localhost:1633'
const bee = new Bee(beeUrl)

// ---------- Upload mode wiring ----------

// A tag is how Bee scores "upload fully pushed to network". bee-js docs note
// that posting chunks without a tag against a node with no peers can hang;
// the --no-tag flag opts out for debugging / fully-isolated setups.
const tagUid: number | undefined =
  args.uploadMode !== 'bytes' && args.useTag ? (await bee.createTag()).uid : undefined
if (tagUid !== undefined) console.log(`created tag ${tagUid}`)

let chunkStream: BeeChunkStream | undefined
if (args.uploadMode === 'ws') {
  chunkStream = new BeeChunkStream({ beeUrl, batchId, tag: tagUid })
  await timed('open ws /chunks/stream', () => chunkStream!.open())
}

// Concrete `uploadChunk` for the two client-chunked modes. Left undefined for
// the default /bytes path, which takes a different code path entirely.
const uploadChunk: ChunkUploader | undefined =
  args.uploadMode === 'chunks'
    ? async (chunkData: Uint8Array, _address: Uint8Array) => {
        await bee.uploadChunk(
          batchId,
          chunkData,
          tagUid !== undefined ? { tag: tagUid } : undefined,
        )
      }
    : args.uploadMode === 'ws'
      ? async (chunkData: Uint8Array, address: Uint8Array) => {
          await chunkStream!.sendChunkData(chunkData, address)
        }
      : undefined

// Wraps `uploadBundleAsTree` so `addBlocksToPot` sees the same signature it
// always has: bundle bytes in → 32-byte Swarm ref out. The tree-builder
// handles the ≤4KB (single leaf) and >4KB (fan-out) cases uniformly.
const bundleUploader: BundleUploader | undefined = uploadChunk
  ? (bytes) => uploadBundleAsTree(bytes, uploadChunk)
  : undefined

console.log(`upload mode: ${args.uploadMode}${tagUid !== undefined ? ` (tag=${tagUid})` : ''}`)

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
    bundleUploader,
    onProgress: (msg) => console.log(`       ${msg}`),
  })
  totals.blocksUploaded += res.blocksUploaded
  totals.txHashesIndexed += res.txHashesIndexed
  console.log(
    `       added ${res.blocksUploaded} blocks, ${res.txHashesIndexed} txs in ${formatDuration(Date.now() - started)}`,
  )
}

console.log('\n== saving POT indexes ==')
const meta = await timed('write meta', () =>
  writePotBlockRangeMeta(bee, indexes, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
  }),
)
const indexRefs = await timed('save indexes', () => savePotIndexes(indexes))
console.log(`       byNumber: ${indexRefs.byNumber}`)
console.log(`       byHash:   ${indexRefs.byHash}`)
console.log(`       byTx:     ${indexRefs.byTx}`)
console.log(`       meta:     ${indexRefs.meta ?? '(none)'}`)

if (chunkStream) {
  await timed('close ws /chunks/stream', () => chunkStream!.close())
}

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

const metaPath = resolve(DATA_DIR, `eras-${rangeLabel}.pot.json`)
const metaFile: PotMetaFile = {
  eras: uploadable.map((t) => t.era).filter((e): e is number => e !== null),
  files: uploadable.map((t) => t.fileBase),
  uploadedAt: new Date().toISOString(),
  beeUrl,
  batchId,
  extendedFrom: args.refsPath ?? null,
  indexes: indexRefs,
  firstBlock: meta?.firstBlock ?? null,
  lastBlock: meta?.lastBlock ?? null,
  blocksUploaded: totals.blocksUploaded,
  txHashesIndexed: totals.txHashesIndexed,
}
await writeFile(metaPath, JSON.stringify(metaFile, null, 2))

console.log(
  `\nupload ${totals.blocksUploaded} blocks, ${totals.txHashesIndexed} txs in ${formatDuration(elapsed)}`,
)
console.log(`       written:  ${metaPath}`)
