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
import { DATA_DIR, header, resolveTargets } from './cli-shared.js'
import { uploadBlocksAndBuildManifest } from './swarm.js'

// ---------- Parse arguments ----------

function parseArgs(argv: string[]): {
  beeUrl?: string
  batchId?: string
  manifestHash?: string
  target?: string
} {
  const result: { beeUrl?: string; batchId?: string; manifestHash?: string; target?: string } = {}

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bee-url' && argv[i + 1]) {
      result.beeUrl = argv[++i]
    } else if (arg === '--batch-id' && argv[i + 1]) {
      result.batchId = argv[++i]
    } else if (arg === '--manifest' && argv[i + 1]) {
      result.manifestHash = argv[++i]
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
  console.error('  pnpm era:upload --batch-id <postage-batch-id> [--manifest <hash>] [range]')
  console.error('')
  console.error('Examples:')
  console.error('  pnpm era:upload --batch-id abc123... 0')
  console.error('  pnpm era:upload --batch-id abc123... --manifest def456... 1')
  console.error('  pnpm era:upload --bee-url http://bee.example.com --batch-id abc123... 5')
  process.exit(1)
}

// ---------- Main ----------

const targets = await resolveTargets(args.target)

for (const t of targets) {
  console.log(header(t))

  if (!existsSync(t.blocksPath)) {
    console.error(`error: no blocks file at ${t.blocksPath}`)
    console.error('       run "pnpm era:process" first to generate the blocks.ndjson file')
    continue
  }

  const started = Date.now()

  const result = await uploadBlocksAndBuildManifest(t.blocksPath, {
    beeUrl: args.beeUrl,
    batchId: args.batchId,
    manifestHash: args.manifestHash,
    onProgress: (msg) => console.log(`       ${msg}`),
  })

  const elapsed = Date.now() - started

  // Write manifest metadata file
  const manifestPath = resolve(DATA_DIR, `${t.fileBase}.manifest.json`)
  const manifestData = {
    era: t.era,
    uploadedAt: new Date().toISOString(),
    beeUrl: args.beeUrl ?? 'http://localhost:1633',
    batchId: args.batchId,
    manifestReference: result.manifestReference,
    blocksUploaded: result.blocksUploaded,
    txHashesIndexed: result.txHashesIndexed,
  }
  await writeFile(manifestPath, JSON.stringify(manifestData, null, 2))

  console.log(`upload ${result.blocksUploaded} blocks, ${result.txHashesIndexed} txs in ${elapsed} ms`)
  console.log(`       manifest: ${result.manifestReference}`)
  console.log(`       written:  ${manifestPath}`)
}
