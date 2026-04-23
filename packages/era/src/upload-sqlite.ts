// CLI entry point for uploading block data to Swarm using SQLite indexing.
//
// This is an alternative to the Mantaray manifest approach. Instead of
// creating a manifest with paths for each block/tx, this creates a SQLite
// database that can be queried via sql.js-httpvfs with Swarm Range requests.
//
// The database is uploaded as a single blob, enabling lazy loading via HTTP
// Range requests - only the pages needed for each query are fetched.
//
// Usage:
//   pnpm era:upload-sqlite --batch-id <postage-batch-id> [--db <path>] [range]
//
// Examples:
//   pnpm era:upload-sqlite --batch-id abc123... 0
//   pnpm era:upload-sqlite --batch-id abc123... --db ./my-index.sqlite 0..6
//   pnpm era:upload-sqlite --bee-url http://bee.example.com --batch-id abc123... 5
//   pnpm era:upload-sqlite --batch-id abc123... --block 100 0  # single block

import { createReadStream, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { Bee } from '@ethersphere/bee-js'
import { DATA_DIR, header, parseFeedSignerFlag, resolveTargets, type Target } from './cli-shared.js'
import { loadSigner, tryPublishFeedUpdate } from './feed-publisher.js'
import { openSqliteIndexer } from './swarm-sqlite.js'

// ---------- Parse arguments ----------

function parseArgs(argv: string[]): {
  beeUrl?: string
  batchId?: string
  dbPath?: string
  target?: string
  blockNumber?: number
  perBlock?: number | { start: number; end: number }
} {
  const result: {
    beeUrl?: string
    batchId?: string
    dbPath?: string
    target?: string
    blockNumber?: number
    perBlock?: number | { start: number; end: number }
  } = {}

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) {
      result.beeUrl = argv[++i]
    } else if (arg === '--batch-id' && argv[i + 1]) {
      result.batchId = argv[++i]
    } else if (arg === '--db' && argv[i + 1]) {
      result.dbPath = argv[++i]
    } else if (arg === '--block' && argv[i + 1]) {
      result.blockNumber = parseInt(argv[++i], 10)
    } else if (arg === '--per-block' && argv[i + 1]) {
      const val = argv[++i]
      if (val.includes('..')) {
        const [start, end] = val.split('..').map((s) => parseInt(s, 10))
        result.perBlock = { start, end }
      } else {
        result.perBlock = parseInt(val, 10)
      }
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
  console.error('  pnpm era:upload-sqlite --batch-id <postage-batch-id> [--db <path>] [range]')
  console.error('')
  console.error('Options:')
  console.error('  --batch-id <id>     Postage batch ID (required)')
  console.error('  --bee-url <url>     Bee node URL (default: http://localhost:1633)')
  console.error('  --db <path>         SQLite database path (default: data/index.sqlite)')
  console.error('  --block <number>    Upload only a specific block number')
  console.error('  --per-block <n|start..end>  Process blocks by position (e.g., 5 or 1000..2000)')
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload-sqlite --batch-id abc123... 0')
  console.error('  pnpm era:upload-sqlite --batch-id abc123... --db ./my-index.sqlite 0..6')
  console.error('  pnpm era:upload-sqlite --batch-id abc123... --block 100 0')
  console.error('  pnpm era:upload-sqlite --batch-id abc123... --per-block 5 0')
  console.error('  pnpm era:upload-sqlite --batch-id abc123... --per-block 1000..2000 0')
  process.exit(1)
}

// ---------- Main ----------

const batchId = args.batchId
const beeUrl = args.beeUrl ?? 'http://localhost:1633'
const bee = new Bee(beeUrl)

const dbPath = args.dbPath ?? resolve(DATA_DIR, 'index.sqlite')

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

// Open SQLite indexer
console.log(`\n== SQLite indexer ==`)
console.log(`       db: ${dbPath}`)

const indexer = openSqliteIndexer({
  dbPath,
  onProgress: (msg) => console.log(`       ${msg}`),
})

const totals = { blocksAdded: 0, blocksSkipped: 0, txHashesAdded: 0 }
const runStarted = Date.now()

let stats: { blockCount: number; txCount: number; dbSizeBytes: number }

if (args.perBlock) {
  const range = typeof args.perBlock === 'number' ? { start: 0, end: args.perBlock } : args.perBlock

  console.log(`\n== per-block mode (positions ${range.start}..${range.end}) ==`)

  // Stream blocks one at a time from each target file
  let position = 0
  targetLoop: for (const t of uploadable) {
    const rl = createInterface({
      input: createReadStream(t.blocksPath, 'utf8'),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (position >= range.end) {
        rl.close()
        break targetLoop
      }
      if (!line.trim()) continue

      // Skip blocks before the start position
      if (position < range.start) {
        position++
        continue
      }

      const t0 = performance.now()
      const result = await indexer.addSingleBlock(bee, line, batchId)
      const t1 = performance.now()

      if (result.skipped) {
        console.log(`Block ${result.blockNumber}: skipped (already exists)`)
        totals.blocksSkipped++
        position++
        continue
      }

      totals.blocksAdded++
      totals.txHashesAdded += result.txHashesAdded

      console.log(`Block ${result.blockNumber}: upload=${(t1 - t0).toFixed(0)}ms`)

      position++
    }
  }

  // Get final stats before vacuum
  stats = indexer.getStats()
  console.log(
    `\n       ${stats.blockCount} blocks, ${stats.txCount} txs, ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  )
} else {
  // Bulk flow: process each era file
  for (const t of uploadable) {
    console.log(header(t))
    const started = Date.now()

    const res = await indexer.addBlocksFromNdjson(bee, t.blocksPath, {
      batchId,
      blockNumber: args.blockNumber,
      onProgress: (msg) => console.log(`       ${msg}`),
    })

    totals.blocksAdded += res.blocksAdded
    totals.blocksSkipped += res.blocksSkipped
    totals.txHashesAdded += res.txHashesAdded
    const skipMsg = res.blocksSkipped > 0 ? `, skipped ${res.blocksSkipped}` : ''
    console.log(
      `       added ${res.blocksAdded} blocks${skipMsg}, ${res.txHashesAdded} txs in ${Date.now() - started} ms`,
    )
  }

  // Get stats before vacuum
  stats = indexer.getStats()
  console.log(
    `\n       ${stats.blockCount} blocks, ${stats.txCount} txs, ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  )
}

// Compact database before uploading
console.log('\n== compacting database ==')
indexer.vacuum()
stats = indexer.getStats()
console.log(`       after vacuum: ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`)

// Sync database to Swarm with chunk-level tracking
console.log('\n== syncing database to Swarm ==')
const syncStarted = Date.now()
const syncResult = await indexer.sync(bee, {
  batchId,
  onProgress: (msg) => console.log(`       ${msg}`),
})
console.log(`       synced in ${Date.now() - syncStarted} ms`)
console.log(
  `       pages: ${syncResult.pagesUploaded} uploaded, ${syncResult.pagesSkipped} skipped`,
)
console.log(`       db ref: ${syncResult.dbRef}`)

const dbRef = syncResult.dbRef

// Close the database after sync completes
indexer.close()

// Write metadata file
const firstEra = uploadable[0].era
const lastEra = uploadable[uploadable.length - 1].era
const rangeLabel =
  firstEra !== null && lastEra !== null
    ? firstEra === lastEra
      ? `${firstEra}`
      : `${firstEra}-${lastEra}`
    : uploadable[0].fileBase

const metadataPath = resolve(DATA_DIR, `eras-${rangeLabel}.sqlite-index.json`)
const metadata = {
  type: 'sqlite-index',
  eras: uploadable.map((t) => t.era).filter((e): e is number => e !== null),
  files: uploadable.map((t) => t.fileBase),
  uploadedAt: new Date().toISOString(),
  beeUrl,
  batchId,
  dbRef: dbRef,
  totalPages: syncResult.totalPages,
  pagesUploaded: syncResult.pagesUploaded,
  pagesSkipped: syncResult.pagesSkipped,
  blocksIndexed: totals.blocksAdded,
  blocksSkipped: totals.blocksSkipped,
  txHashesIndexed: totals.txHashesAdded,
  dbSizeBytes: stats.dbSizeBytes,
}
await writeFile(metadataPath, JSON.stringify(metadata, null, 2))

const elapsed = Date.now() - runStarted

console.log(`\n== summary ==`)
const summarySkipMsg = totals.blocksSkipped > 0 ? `, ${totals.blocksSkipped} skipped` : ''
console.log(
  `       indexed ${totals.blocksAdded} blocks${summarySkipMsg}, ${totals.txHashesAdded} txs in ${elapsed} ms`,
)
console.log(`       db ref: ${dbRef}`)
console.log(`       metadata:   ${metadataPath}`)

await tryPublishFeedUpdate({
  kind: 'sqlite',
  referenceHex: dbRef,
  bee,
  batchId,
  signer: loadSigner(parseFeedSignerFlag(process.argv)),
  tagUid: syncResult.tagUid,
})
