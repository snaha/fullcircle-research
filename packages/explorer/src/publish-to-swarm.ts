// CLI: upload the built SvelteKit explorer to Swarm using the global
// `swarm-cli` binary. bee-js's streamDirectory has been unreliable against
// flaky Bee nodes, so we delegate the upload + feed update to swarm-cli
// (which handles its own retry/chunking) and only use bee-js for the
// deterministic feed-manifest chunk.
//
// Usage:
//   pnpm publish-to-swarm --batch-id <postage-batch-id>
//   pnpm publish-to-swarm --batch-id abc123... --bee-url http://localhost:1633
//   pnpm publish-to-swarm --batch-id abc123... --build-dir ./build
//   pnpm publish-to-swarm --batch-id abc123... --feed-signer-key <key>

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bee } from '@ethersphere/bee-js'
import { loadSigner } from '@fullcircle/era/feed-publisher'
import { FEED_TOPIC_STRINGS, FEED_TOPICS } from '@fullcircle/era/feed-topics'
import { saveLatestRefs } from '@fullcircle/era/refs-state'

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data')
const DEFAULT_BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../build')
const SWARM_CLI_CONFIG = resolve(DATA_DIR, '.swarm-cli-publish')
const IDENTITY_NAME = 'fullcircle-publisher'

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
  console.error('Requires `swarm-cli` on PATH (install: `pnpm add -g swarm-cli`).')
  process.exit(1)
}

if (!existsSync(args.buildDir)) {
  console.error(`error: build directory not found at ${args.buildDir}`)
  console.error('Run `pnpm build` first.')
  process.exit(1)
}

// ---------- swarm-cli subprocess helper ----------

// Runs swarm-cli, streams its output to our stdout/stderr, and captures stdout
// for downstream parsing. swarm-cli exits 0 even on connection errors, so
// callers must verify success by extracting a 64-hex reference from the output.
async function runSwarmCli(cliArgs: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('swarm-cli', cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      process.stdout.write(chunk)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('swarm-cli not found on PATH — install with `pnpm add -g swarm-cli`'))
      } else {
        reject(err)
      }
    })
    proc.on('exit', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`swarm-cli exited with code ${code}`))
    })
  })
}

// Extract the last 64-hex reference swarm-cli emitted. With `-q` the reference
// is printed on its own line, but non-quiet modes embed it in a status line —
// either way, the last 64-hex run in the output is the one we want.
function extractRef(output: string): string | null {
  const matches = output.match(/[0-9a-f]{64}/gi)
  return matches?.[matches.length - 1]?.toLowerCase() ?? null
}

// ---------- Setup scratch swarm-cli config + identity ----------

const signer = loadSigner(args.feedSignerKey)

// A scratch config folder keeps the publisher identity isolated from the
// user's own swarm-cli config. We wipe and re-import on every run so the
// identity always matches the provided signer key.
if (signer) {
  await rm(SWARM_CLI_CONFIG, { recursive: true, force: true })
  await mkdir(SWARM_CLI_CONFIG, { recursive: true })
  const keyHex = args.feedSignerKey ?? process.env.FULLCIRCLE_FEED_SIGNER_KEY!
  await runSwarmCli([
    'identity',
    'import',
    keyHex,
    '-i',
    IDENTITY_NAME,
    '--config-folder',
    SWARM_CLI_CONFIG,
    '-q',
    '-y',
  ])
}

// ---------- Upload build directory ----------

const batchId = args.batchId
const started = Date.now()

console.log(`uploading ${args.buildDir} → ${args.beeUrl}`)

const uploadOut = await runSwarmCli([
  'upload',
  args.buildDir,
  '--bee-api-url',
  args.beeUrl,
  '--stamp',
  batchId,
  '--index-document',
  'index.html',
  '--error-document',
  'index.html',
  '-y',
  '-q',
])

const rootHex = extractRef(uploadOut)
if (!rootHex) {
  console.error('error: swarm-cli upload did not return a reference — upload failed')
  process.exit(1)
}

const elapsed = Date.now() - started

// ---------- Feed update ----------

let publisher: string | undefined
let feedManifestRef: string | undefined

if (signer) {
  const ownerHex = signer.publicKey().address().toHex()
  publisher = ownerHex

  const feedOut = await runSwarmCli([
    'feed',
    'update',
    '--identity',
    IDENTITY_NAME,
    '--stamp',
    batchId,
    '--bee-api-url',
    args.beeUrl,
    '--reference',
    rootHex,
    '--topic-string',
    FEED_TOPIC_STRINGS.app,
    '--config-folder',
    SWARM_CLI_CONFIG,
    '-y',
    '-q',
  ])

  const socRef = extractRef(feedOut)
  if (!socRef) {
    console.error('error: swarm-cli feed update did not return a reference — feed update failed')
    process.exit(1)
  }
  console.log(`feed[app] updated · owner 0x${ownerHex} · ref=${socRef}`)

  // createFeedManifest is a deterministic single-chunk upload (hash of
  // topic || owner metadata). Safe to re-run; kept on bee-js because
  // swarm-cli doesn't expose this primitive directly.
  const bee = new Bee(args.beeUrl)
  const fm = await bee.createFeedManifest(batchId, FEED_TOPICS.app, ownerHex)
  feedManifestRef = fm.toHex()
  console.log(`  feed manifest: ${feedManifestRef}`)
  console.log(`  feed access:   ${args.beeUrl}/bzz/${feedManifestRef}/`)
} else {
  console.log('feed[app] skipped · set FULLCIRCLE_FEED_SIGNER_KEY or --feed-signer-key to publish')
}

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

await saveLatestRefs({ publisher, feedManifest: feedManifestRef })
