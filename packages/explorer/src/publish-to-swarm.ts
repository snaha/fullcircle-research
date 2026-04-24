// CLI: upload the built SvelteKit explorer to Swarm.
//
// Usage:
//   pnpm publish-to-swarm --batch-id <postage-batch-id>
//   pnpm publish-to-swarm --batch-id abc123... --bee-url http://localhost:1633
//   pnpm publish-to-swarm --batch-id abc123... --build-dir ./build
//   pnpm publish-to-swarm --batch-id abc123... --feed-signer-key <key>

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bee } from '@ethersphere/bee-js'
import { loadSigner } from '@fullcircle/era/feed-publisher'
import { FEED_TOPICS } from '@fullcircle/era/feed-topics'
import { saveLatestRefs } from '@fullcircle/era/refs-state'

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data')
const DEFAULT_BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../build')

// ---------- Args ----------

interface Args {
  beeUrl: string
  batchId?: string
  buildDir: string
  feedSignerKey?: string
}

function parseArgs(argv: string[]): Args {
  const result: Args = { beeUrl: 'http://localhost:1633', buildDir: DEFAULT_BUILD_DIR }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) result.beeUrl = argv[++i]
    else if (arg === '--batch-id' && argv[i + 1]) result.batchId = argv[++i]
    else if (arg === '--build-dir' && argv[i + 1]) result.buildDir = resolve(argv[++i])
    else if (arg === '--feed-signer-key' && argv[i + 1]) result.feedSignerKey = argv[++i]
  }
  return result
}

const args = parseArgs(process.argv)

if (!args.batchId) {
  console.error('error: --batch-id is required')
  console.error('')
  console.error('Usage:')
  console.error('  pnpm publish-to-swarm --batch-id <postage-batch-id>')
  console.error('  pnpm publish-to-swarm --batch-id abc123... --bee-url http://localhost:1633')
  console.error('  pnpm publish-to-swarm --batch-id abc123... --build-dir ./build')
  console.error('  pnpm publish-to-swarm --batch-id abc123... --feed-signer-key <key>')
  console.error('')
  console.error('Run `pnpm build` first to produce the build/ directory.')
  process.exit(1)
}

if (!existsSync(args.buildDir)) {
  console.error(`error: build directory not found at ${args.buildDir}`)
  console.error('Run `pnpm build` first.')
  process.exit(1)
}

// ---------- Upload ----------

const bee = new Bee(args.beeUrl)
const batchId = args.batchId
const started = Date.now()
let lastPct = -1

console.log(`uploading ${args.buildDir} → ${args.beeUrl}`)

const result = await bee.streamDirectory(
  batchId,
  args.buildDir,
  ({ total, processed }) => {
    const pct = total > 0 ? Math.floor((processed / total) * 100) : 0
    if (pct !== lastPct && pct % 5 === 0) {
      process.stdout.write(`\r  ${processed}/${total} chunks (${pct}%)`)
      lastPct = pct
    }
  },
  { indexDocument: 'index.html', errorDocument: 'index.html' },
)

const elapsed = Date.now() - started
const rootHex = result.reference.toHex()
process.stdout.write('\n')

// ---------- Output ----------

const outputPath = resolve(DATA_DIR, `explorer-${Date.now()}.manifest.json`)
const output = {
  publishedAt: new Date().toISOString(),
  beeUrl: args.beeUrl,
  batchId,
  buildDir: args.buildDir,
  manifestReference: rootHex,
}
await writeFile(outputPath, JSON.stringify(output, null, 2))

console.log(`\ndone in ${elapsed} ms`)
console.log(`  manifest: ${rootHex}`)
console.log(`  access:   ${args.beeUrl}/bzz/${rootHex}/`)
console.log(`  written:  ${outputPath}`)

// Sequence-based feed update — same primitive `swarm-cli feed update` calls.
// Bee's /bzz/{feedManifest}/ resolver does sequence lookup, so this is what
// makes the stable URL actually resolve to the latest build. The era data
// feeds (manifest/sqlite/pot) stay on epoch scheme because the explorer reads
// them with createSyncEpochFinder; the `app` feed is read by Bee, not by JS.
const signer = loadSigner(args.feedSignerKey)
let publisher: string | undefined
let feedManifestRef: string | undefined

if (signer) {
  const ownerHex = signer.publicKey().address().toHex()
  publisher = ownerHex
  const topic = FEED_TOPICS.app

  const writer = bee.makeFeedWriter(topic, signer)
  const update = await writer.uploadReference(batchId, rootHex)
  console.log(`feed[app] updated · owner 0x${ownerHex} · ref=${update.reference.toHex()}`)

  const fm = await bee.createFeedManifest(batchId, topic, ownerHex)
  feedManifestRef = fm.toHex()
  console.log(`  feed manifest: ${feedManifestRef}`)
  console.log(`  feed access:   ${args.beeUrl}/bzz/${feedManifestRef}/`)
} else {
  console.log('feed[app] skipped · set FULLCIRCLE_FEED_SIGNER_KEY or --feed-signer-key to publish')
}

await saveLatestRefs({ publisher, feedManifest: feedManifestRef })
