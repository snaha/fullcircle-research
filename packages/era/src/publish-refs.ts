// CLI: publish uploaded Swarm refs to epoch feeds without re-uploading data.
//
// Reads latest refs from data/latest-refs.json (written by upload-pot,
// upload-sqlite, and publish-to-swarm) and publishes them to the matching
// epoch feeds. Per-ref CLI flags override the saved values.
//
// Usage:
//   pnpm era:publish-refs --batch-id <id>
//   pnpm era:publish-refs --batch-id <id> --manifest <ref>
//   pnpm era:publish-refs --batch-id <id> --pot <ref> --sqlite <ref>
//   pnpm era:publish-refs --batch-id <id> --feed-signer-key <key>

import { Bee } from '@ethersphere/bee-js'
import { parseFeedSignerFlag } from './cli-shared.js'
import { loadSigner, tryPublishFeedUpdate } from './feed-publisher.js'
import { loadLatestRefs, saveLatestRefs } from './refs-state.js'

// ---------- Args ----------

interface CliArgs {
  beeUrl: string
  batchId?: string
  manifest?: string
  pot?: string
  sqlite?: string
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { beeUrl: 'http://localhost:1633' }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) result.beeUrl = argv[++i]
    else if (arg === '--batch-id' && argv[i + 1]) result.batchId = argv[++i]
    else if (arg === '--manifest' && argv[i + 1]) result.manifest = argv[++i]
    else if (arg === '--pot' && argv[i + 1]) result.pot = argv[++i]
    else if (arg === '--sqlite' && argv[i + 1]) result.sqlite = argv[++i]
  }
  return result
}

const args = parseArgs(process.argv)

if (!args.batchId) {
  console.error('error: --batch-id is required')
  console.error('')
  console.error('Usage:')
  console.error('  pnpm era:publish-refs --batch-id <id> [--manifest <ref>] [--pot <ref>] [--sqlite <ref>]')
  console.error('')
  console.error('Options:')
  console.error('  --batch-id <id>        Postage batch ID (required)')
  console.error('  --bee-url <url>        Bee node URL (default: http://localhost:1633)')
  console.error('  --manifest <ref>       Manifest ref to publish (default: from data/latest-refs.json)')
  console.error('  --pot <ref>            POT envelope ref to publish (default: from data/latest-refs.json)')
  console.error('  --sqlite <ref>         SQLite db ref to publish (default: from data/latest-refs.json)')
  console.error('  --feed-signer-key <k>  Private key for feed signing (or set FULLCIRCLE_FEED_SIGNER_KEY)')
  process.exit(1)
}

// ---------- Load saved refs, apply CLI overrides ----------

const saved = await loadLatestRefs()

const manifest = args.manifest ?? saved.manifest
const pot = args.pot ?? saved.pot
const sqlite = args.sqlite ?? saved.sqlite

console.log('latest-refs.json:')
console.log(`  manifest: ${saved.manifest ?? '(none)'}`)
console.log(`  pot:      ${saved.pot ?? '(none)'}`)
console.log(`  sqlite:   ${saved.sqlite ?? '(none)'}`)

if (!manifest && !pot && !sqlite) {
  console.error('')
  console.error('error: no refs to publish')
  console.error('       run an upload command first (era:upload-pot, era:upload-sqlite,')
  console.error('       explorer:publish-to-swarm) to populate data/latest-refs.json,')
  console.error('       or provide at least one of --manifest, --pot, --sqlite')
  process.exit(1)
}

// ---------- Publish ----------

const signer = loadSigner(parseFeedSignerFlag(process.argv))
const bee = new Bee(args.beeUrl)
const batchId = args.batchId

console.log(`\npublishing to feeds via ${args.beeUrl}`)
if (manifest) console.log(`  manifest: ${manifest}`)
if (pot) console.log(`  pot:      ${pot}`)
if (sqlite) console.log(`  sqlite:   ${sqlite}`)
console.log('')

let publisher: string | undefined
if (manifest) {
  const r = await tryPublishFeedUpdate({ kind: 'manifest', referenceHex: manifest, bee, batchId, signer })
  publisher ??= r?.owner
}
if (pot) {
  const r = await tryPublishFeedUpdate({ kind: 'pot', referenceHex: pot, bee, batchId, signer })
  publisher ??= r?.owner
}
if (sqlite) {
  const r = await tryPublishFeedUpdate({ kind: 'sqlite', referenceHex: sqlite, bee, batchId, signer })
  publisher ??= r?.owner
}

// Save any explicit CLI overrides + publisher back to the state file
const patch: { manifest?: string; pot?: string; sqlite?: string; publisher?: string } = {}
if (args.manifest) patch.manifest = args.manifest
if (args.pot) patch.pot = args.pot
if (args.sqlite) patch.sqlite = args.sqlite
if (publisher) patch.publisher = publisher
if (Object.keys(patch).length > 0) {
  await saveLatestRefs(patch)
}
