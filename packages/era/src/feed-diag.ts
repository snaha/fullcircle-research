// Diagnostic: given a publisher address and an indexer kind, compute the
// expected SOC addresses along the root → leaf epoch spine and probe Bee
// for each. Tells us whether the uploaded feed chunks are at the addresses
// the explorer's finder will look for.
//
// Usage:
//   pnpm era:feed-diag --owner <40-hex> [--kind manifest|pot|sqlite] [--bee-url http://localhost:1633]

import { EpochIndex, epochIdentifier, MAX_EPOCH_LEVEL } from './feed-epoch.js'
import { FEED_TOPIC_STRINGS, FEED_TOPICS, type FeedKind } from './feed-topics.js'

interface Args {
  owner?: string
  kind: FeedKind
  beeUrl: string
}

function parseArgs(argv: string[]): Args {
  const out: Args = { kind: 'sqlite', beeUrl: 'http://localhost:1633' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--owner' && argv[i + 1]) out.owner = argv[++i]
    else if (a === '--kind' && argv[i + 1]) {
      const k = argv[++i]
      if (k !== 'manifest' && k !== 'pot' && k !== 'sqlite') {
        console.error(`error: --kind must be manifest|pot|sqlite, got "${k}"`)
        process.exit(1)
      }
      out.kind = k
    } else if (a === '--bee-url' && argv[i + 1]) out.beeUrl = argv[++i]
  }
  return out
}

function hexToBytes(s: string): Uint8Array {
  const h = s.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2 !== 0) {
    throw new Error(`invalid hex: "${s}"`)
  }
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function socAddress(identifier: Uint8Array, owner: Uint8Array): Uint8Array {
  // keccak256(identifier || owner) — same as makeSOCAddress in bee-js.
  // We compute locally to keep the diagnostic dependency-free beyond
  // what feed-epoch.ts already uses (@noble/hashes).
  const buf = new Uint8Array(identifier.length + owner.length)
  buf.set(identifier, 0)
  buf.set(owner, identifier.length)
  // Lazy import via dynamic require-like pattern isn't necessary; reuse keccak_256
  // that feed-epoch already pulls in. Re-import here to avoid exporting it.
  // (Small duplication but keeps feed-epoch.ts's public surface tight.)
  return keccak256Wrapper(buf)
}

// Tiny adapter so we don't have to re-export keccak_256 from feed-epoch.
// @noble/hashes/sha3 is already an era dependency.
import { keccak_256 } from '@noble/hashes/sha3'
function keccak256Wrapper(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

async function probe(
  beeUrl: string,
  start: bigint,
  level: number,
  topic: Uint8Array,
  owner: Uint8Array,
): Promise<void> {
  const epoch = new EpochIndex(start, level)
  const identifier = epochIdentifier(topic, epoch)
  const address = socAddress(identifier, owner)
  const addrHex = bytesToHex(address)

  const t0 = Date.now()
  let status: string
  let size: number | undefined
  try {
    const res = await fetch(`${beeUrl.replace(/\/$/, '')}/chunks/${addrHex}`, {
      headers: { connection: 'close' },
    })
    if (res.ok) {
      const body = new Uint8Array(await res.arrayBuffer())
      size = body.length
      status = `200 OK (${size}B)`
    } else {
      status = `${res.status} ${res.statusText}`
    }
  } catch (err) {
    status = `ERR ${(err as Error).message}`
  }
  const ms = Date.now() - t0

  const startStr = start.toString().padStart(11, ' ')
  const lvl = String(level).padStart(2, ' ')
  console.log(
    `  (${startStr}, ${lvl})  soc=${addrHex}  ${status}  (${ms}ms)` +
      `\n                      id=${bytesToHex(identifier)}`,
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  if (!args.owner) {
    console.error('error: --owner is required (40-char hex publisher address)')
    console.error('')
    console.error(
      'Usage: pnpm era:feed-diag --owner <40-hex> [--kind manifest|pot|sqlite] [--bee-url http://localhost:1633]',
    )
    process.exit(1)
  }

  const ownerHex = args.owner.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(ownerHex)) {
    console.error(`error: --owner must be 40-char hex, got "${args.owner}"`)
    process.exit(1)
  }
  const owner = hexToBytes(ownerHex)
  const topic = FEED_TOPICS[args.kind].toUint8Array()

  console.log(`bee:    ${args.beeUrl}`)
  console.log(`kind:   ${args.kind}  (topic string "${FEED_TOPIC_STRINGS[args.kind]}")`)
  console.log(`topic:  ${bytesToHex(topic)}`)
  console.log(`owner:  0x${ownerHex}`)
  console.log('')
  console.log('probing epoch spine (the finder walks up from level 0 and down from root):')

  const at = BigInt(Math.floor(Date.now() / 1000))

  // The upload side descends root → at-childAt at each step. Replicate that
  // spine here so every epoch we've likely written to gets probed.
  const spine: Array<{ start: bigint; level: number }> = []
  let epoch = new EpochIndex(0n, MAX_EPOCH_LEVEL)
  spine.push({ start: epoch.start, level: epoch.level })
  while (epoch.level > 0) {
    epoch = epoch.childAt(at)
    spine.push({ start: epoch.start, level: epoch.level })
    if (spine.length > 8) break // beyond level ~24 we've seen no uploads
  }

  for (const { start, level } of spine) {
    await probe(args.beeUrl, start, level, topic, owner)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
