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
  addBalanceEventsToManifest,
  addBlocksToManifest,
  getManifestBlockRange,
  openManifest,
  saveManifest,
  writeBlockRangeMeta,
} from './swarm.js'
import { BeeChunkStream } from './swarm-ws.js'

// ---------- Parse arguments ----------

interface Args {
  beeUrl?: string
  batchId?: string
  manifestHash?: string
  target?: string
  cacheManifest: boolean
  ws: boolean
  /** Save the manifest every N blocks; undefined = save only at the end. */
  saveEvery?: number
  /** Skip uploading per-address/per-block balance events even when extracted. */
  noState: boolean
}

function parseArgs(argv: string[]): Args {
  const result: Args = { cacheManifest: true, ws: false, noState: false }

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
    } else if (arg === '--ws') {
      result.ws = true
    } else if (arg === '--no-state') {
      result.noState = true
    } else if (arg === '--per-block') {
      result.saveEvery = 1
    } else if (arg === '--save-every' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10)
      if (!Number.isFinite(n) || n < 1) {
        console.error(`error: --save-every expects a positive integer, got ${argv[i]}`)
        process.exit(1)
      }
      result.saveEvery = n
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
    '  pnpm era:upload --batch-id <postage-batch-id> [--manifest <hash>] [--no-manifest-cache] [--ws] [range]',
  )
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload --batch-id abc123... 0')
  console.error('  pnpm era:upload --batch-id abc123... --manifest def456... 1')
  console.error('  pnpm era:upload --bee-url http://bee.example.com --batch-id abc123... 5')
  console.error('  pnpm era:upload --batch-id abc123... --no-manifest-cache 1')
  console.error(
    '  pnpm era:upload --batch-id abc123... --ws 0   # stream manifest chunks over /chunks/stream',
  )
  console.error(
    '  pnpm era:upload --batch-id abc123... --per-block 2992       # checkpoint manifest after every block',
  )
  console.error(
    '  pnpm era:upload --batch-id abc123... --save-every 500 2992  # checkpoint every 500 blocks',
  )
  console.error(
    '  pnpm era:upload --batch-id abc123... --no-state 0..6        # skip balance-events upload',
  )
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

if (args.saveEvery !== undefined && args.saveEvery <= 10) {
  console.log(
    `\nnote: --save-every ${args.saveEvery} will do a full manifest walk after every ${args.saveEvery}\n` +
      `      block(s). Each walk is O(dirty-nodes-since-last-save), and 100 random-hash\n` +
      `      tx/ forks easily dirty tens of thousands of interior nodes — the first save\n` +
      `      may sit quietly in the recursive-fanout phase for a while before chunks start\n` +
      `      flowing. If it feels stuck, try --save-every 500 or 1000 instead.\n`,
  )
}

// If checkpointing is enabled, open the ws chunk stream (if requested) up
// front so intermediate saves also get to use it.
let chunkStream: BeeChunkStream | undefined
if (args.ws) {
  chunkStream = new BeeChunkStream({ beeUrl, batchId })
  await timed('open ws /chunks/stream', () => chunkStream!.open())
}

async function saveManifestNow(label: string, writeTreeSnapshot: boolean) {
  return saveManifest(bee, manifest, {
    batchId,
    onProgress: (msg) => console.log(`       [${label}] ${msg}`),
    cacheManifest: args.cacheManifest,
    chunkStream,
    writeTreeSnapshot,
  })
}

for (const t of uploadable) {
  console.log(header(t))
  const started = Date.now()

  const progressPath = resolve(DATA_DIR, `${t.fileBase}.upload-progress.json`)
  const checkpoint =
    args.saveEvery !== undefined
      ? {
          every: args.saveEvery,
          fn: async (processed: number, lastBlockNumber: string) => {
            const checkpointStarted = Date.now()
            console.log(`\n       ── checkpoint ${processed} blocks (last=${lastBlockNumber}) ──`)
            // Skip the snapshot rewrite here: it walks the whole tree and
            // pays O(total-chunks) disk I/O per checkpoint. Recovery from the
            // previous snapshot + the intermediate manifest ref is good
            // enough; the final save at end-of-run refreshes the snapshot.
            const refs = await saveManifestNow(`checkpoint ${processed}`, false)
            const payload = {
              manifestReference: refs.root,
              subManifests: {
                number: refs.numberManifest,
                hash: refs.hashManifest,
                tx: refs.txManifest,
              },
              meta: refs.meta,
              blocksProcessed: processed,
              lastBlockNumber,
              file: t.fileBase,
              batchId,
              beeUrl,
              updatedAt: new Date().toISOString(),
            }
            await writeFile(progressPath, JSON.stringify(payload, null, 2))
            console.log(
              `       ✓ checkpoint ${processed} saved in ${Date.now() - checkpointStarted} ms\n` +
                `         manifest: ${refs.root}\n` +
                `         resume:   pnpm era:upload --batch-id ${batchId} --manifest ${refs.root} ...\n` +
                `         progress: ${progressPath}`,
            )
          },
        }
      : undefined

  const res = await addBlocksToManifest(bee, manifest, t.blocksPath, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
    checkpoint,
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
      addBalanceEventsToManifest(bee, manifest, eventsPaths, {
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

console.log('\n== manifest ==')
const meta = await timed('write /meta', () =>
  writeBlockRangeMeta(bee, manifest, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
  }),
)

const refs = await timed('save manifest', () =>
  saveManifest(bee, manifest, {
    batchId,
    onProgress: (msg) => console.log(`       ${msg}`),
    cacheManifest: args.cacheManifest,
    chunkStream,
  }),
)

if (chunkStream) {
  await timed('close ws /chunks/stream', () => chunkStream!.close())
}

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
  manifestReference: refs.root,
  subManifests: {
    number: refs.numberManifest,
    hash: refs.hashManifest,
    tx: refs.txManifest,
    address: refs.addressManifest,
    balanceBlock: refs.balanceBlockManifest,
  },
  meta: refs.meta,
  firstBlock: meta?.firstBlock ?? null,
  lastBlock: meta?.lastBlock ?? null,
  blocksUploaded: totals.blocksUploaded,
  txHashesIndexed: totals.txHashesIndexed,
  addressesUploaded: stateTotals.addressCount,
  stateBlocksUploaded: stateTotals.blockCount,
  eventsUploaded: stateTotals.eventCount,
}
await writeFile(manifestPath, JSON.stringify(manifestData, null, 2))

console.log(
  `\nupload ${totals.blocksUploaded} blocks, ${totals.txHashesIndexed} txs,` +
    ` ${stateTotals.addressCount} addresses, ${stateTotals.eventCount} events` +
    ` in ${formatDuration(elapsed)}`,
)
console.log(`       manifest:      ${refs.root}`)
console.log(`       number:        ${refs.numberManifest ?? '(empty)'}`)
console.log(`       hash:          ${refs.hashManifest ?? '(empty)'}`)
console.log(`       tx:            ${refs.txManifest ?? '(empty)'}`)
console.log(`       address:       ${refs.addressManifest ?? '(empty)'}`)
console.log(`       balance-block: ${refs.balanceBlockManifest ?? '(empty)'}`)
console.log(`       written:       ${manifestPath}`)
