// Re-execute blocks from cached erae files through @ethereumjs/vm and emit
// one NDJSON line per balance mutation. Scoped to pre-Byzantium mainnet for
// now — that's where the VM is bit-perfect against geth.
//
// Output, per processed era (matching the existing era-package file-naming
// convention — same `fileBase` as `.erae` / `.blocks.ndjson` / etc):
//
//   data/<fileBase>.balance-events.ndjson       one {block,addr,pre,post}
//   data/<fileBase>.balance-events.meta.ndjson  one sentinel per block
//   data/<fileBase>.state-checkpoint.json       end-of-era state root + meta
//
// State trie + blockchain are persisted across runs under
// data/.state-cache/{trie,blockchain}.sqlite. Running era K replays it from
// the checkpoint written at the end of era K-1; pass era 0 (or 0..N) to
// (re)build from genesis. To wipe and start over: rm -rf data/.state-cache
// data/*.state-checkpoint.json.

import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RLP } from '@ethereumjs/rlp'
import { createBlockFromRLP } from '@ethereumjs/block'
import { createBlockchain } from '@ethereumjs/blockchain'
import { Common, Mainnet, Hardfork } from '@ethereumjs/common'
import { getGenesis } from '@ethereumjs/genesis'
import { createMPT } from '@ethereumjs/mpt'
import { MerkleStateManager } from '@ethereumjs/statemanager'
import type { Account, Address } from '@ethereumjs/util'
import { createVM, runBlock } from '@ethereumjs/vm'

import { DATA_DIR, downloadIfMissing, fmtBytes, resolveTargets, type Target } from './cli-shared.js'
import { parseEraeFile } from './erae.js'
import { SqliteDB } from './state-cache.js'

const STATE_CACHE_DIR = resolve(DATA_DIR, '.state-cache')
const TRIE_DB_PATH = resolve(STATE_CACHE_DIR, 'trie.sqlite')
const BLOCKCHAIN_DB_PATH = resolve(STATE_CACHE_DIR, 'blockchain.sqlite')

interface BalanceEvent {
  block: string // decimal
  addr: string // 0x-prefixed 40 hex chars
  pre: string // decimal wei
  post: string // decimal wei
}

// A MerkleStateManager that forwards every balance mutation to an async writer
// before delegating to super. modifyAccountFields also funnels through
// putAccount (see @ethereumjs/statemanager/util.js), so this single override
// sees every change — block rewards, tx value transfers, gas accounting,
// SELFDESTRUCT, etc.
class TrackingStateManager extends MerkleStateManager {
  currentBlock = 0n
  writer: ((ev: BalanceEvent) => Promise<void> | void) | undefined

  override async putAccount(address: Address, account: Account | undefined): Promise<void> {
    const before = await this.getAccount(address)
    const preBal = before?.balance ?? 0n
    await super.putAccount(address, account)
    const postBal = account?.balance ?? 0n
    if (preBal !== postBal && this.writer !== undefined) {
      await this.writer({
        block: this.currentBlock.toString(),
        addr: address.toString(),
        pre: preBal.toString(),
        post: postBal.toString(),
      })
    }
  }
}

async function emitGenesisEvents(
  genesisState: unknown,
  writer: (ev: BalanceEvent) => Promise<void>,
): Promise<number> {
  let n = 0
  for (const [addrHex, value] of Object.entries(genesisState as Record<string, unknown>)) {
    const balance = Array.isArray(value) ? (value[0] as string) : (value as string)
    const bn = BigInt(balance)
    if (bn === 0n) continue
    await writer({
      block: '0',
      addr: addrHex.toLowerCase(),
      pre: '0',
      post: bn.toString(),
    })
    n++
  }
  return n
}

function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (stream.write(line + '\n')) return Promise.resolve()
  return once(stream, 'drain').then(() => undefined)
}

function closeStream(stream: WriteStream): Promise<void> {
  stream.end()
  return once(stream, 'finish').then(() => undefined)
}

function toHex(b: Uint8Array): string {
  let s = '0x'
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

interface EraOutput {
  eventsStream: WriteStream
  metaStream: WriteStream
  eventsPath: string
  metaPath: string
  eventCount: number
}

function openEraOutput(target: Target): EraOutput {
  const eventsPath = resolve(DATA_DIR, `${target.fileBase}.balance-events.ndjson`)
  const metaPath = resolve(DATA_DIR, `${target.fileBase}.balance-events.meta.ndjson`)
  return {
    eventsStream: createWriteStream(eventsPath, { flags: 'w' }),
    metaStream: createWriteStream(metaPath, { flags: 'w' }),
    eventsPath,
    metaPath,
    eventCount: 0,
  }
}

async function closeEraOutput(out: EraOutput): Promise<void> {
  await closeStream(out.eventsStream)
  await closeStream(out.metaStream)
}

interface StateCheckpoint {
  era: number
  lastBlockNumber: string
  lastBlockHash: string
  stateRoot: string
  eventCountTotal: number
  updatedAt: string
}

function checkpointPath(target: Target): string {
  return resolve(DATA_DIR, `${target.fileBase}.state-checkpoint.json`)
}

async function readCheckpoint(target: Target): Promise<StateCheckpoint | null> {
  const path = checkpointPath(target)
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf8')) as StateCheckpoint
}

async function writeCheckpoint(target: Target, cp: StateCheckpoint): Promise<void> {
  const path = checkpointPath(target)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(cp, null, 2))
  await rename(tmp, path)
}

function hexToBytes(s: string): Uint8Array {
  const clean = s.startsWith('0x') ? s.slice(2) : s
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function extract(loRange: number, hiRange: number): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(STATE_CACHE_DIR, { recursive: true })

  // Resume support: if the requested range starts past era 0, locate the
  // previous era's checkpoint to seed the state root. The trie and blockchain
  // DBs persist across runs, so the underlying nodes/blocks are already on
  // disk — we just need to point the trie at the right root.
  let resumeFrom: StateCheckpoint | null = null
  if (loRange > 0) {
    const [prevTarget] = await resolveTargets(`${loRange - 1}..${loRange - 1}`)
    if (!prevTarget) {
      throw new Error(
        `state-extract: cannot resume — no target known for era ${loRange - 1} (checksums entry missing).`,
      )
    }
    resumeFrom = await readCheckpoint(prevTarget)
    if (!resumeFrom) {
      throw new Error(
        `state-extract: cannot resume era ${loRange} — no checkpoint at ${checkpointPath(prevTarget)}.\n` +
          `Run \`pnpm era:state-extract 0..${loRange - 1}\` first (or pass a range starting at 0).`,
      )
    }
    console.log(
      `resume from era ${resumeFrom.era}: stateRoot=${resumeFrom.stateRoot} ` +
        `lastBlock=${resumeFrom.lastBlockNumber} totalEvents=${resumeFrom.eventCountTotal}`,
    )
  }

  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Chainstart })

  // Persistent stores. SqliteDB.open() is a no-op (DB opens in constructor),
  // but we await for symmetry with the @ethereumjs DB contract.
  const trieDb = new SqliteDB<string, string | Uint8Array>(TRIE_DB_PATH)
  const blockchainDb = new SqliteDB(BLOCKCHAIN_DB_PATH)
  await trieDb.open()
  await blockchainDb.open()

  const trie = await createMPT({ db: trieDb, useKeyHashing: true, common })
  const stateManager = new TrackingStateManager({ common, trie })

  const genesisState = getGenesis(1) // mainnet
  if (genesisState === undefined) throw new Error('getGenesis(1) returned undefined')

  if (resumeFrom) {
    // The trie nodes for the saved root are already in trieDb from the prior
    // run — just point the trie at that root and we're at the resume state.
    await stateManager.setStateRoot(hexToBytes(resumeFrom.stateRoot))
  } else {
    // Cold start (or restart from era 0): hydrate genesis allocations into
    // the trie. Idempotent against an already-populated trie — same node
    // hashes overwrite the same keys.
    await stateManager.generateCanonicalGenesis(genesisState)
  }

  const blockchain = await createBlockchain({
    common,
    db: blockchainDb,
    genesisState,
    validateBlocks: false,
    validateConsensus: false,
  })
  const vm = await createVM({ common, stateManager, blockchain })

  const targets = await resolveTargets(`${loRange}..${hiRange}`)
  const startTs = Date.now()
  let blocksProcessed = 0
  let totalEvents = resumeFrom?.eventCountTotal ?? 0
  let activeOutput: EraOutput | null = null

  // The writer closure is wired through the state manager once and reused
  // across eras — it always appends to whichever EraOutput is currently
  // active. This means the VM mutation path is uninterrupted as we rotate
  // files between eras.
  stateManager.writer = async (ev) => {
    const out = activeOutput
    if (out === null) return
    out.eventCount++
    totalEvents++
    await writeLine(out.eventsStream, JSON.stringify(ev))
  }

  for (const t of targets) {
    console.log(`\n== era ${t.era} ==`)
    activeOutput = openEraOutput(t)

    // Genesis allocations are synthetic "0 → balance" events. They belong
    // only to era 0 since block 0 lives there. generateCanonicalGenesis has
    // already hydrated the trie above, so we emit the events straight here
    // without going through the putAccount hook (no double-count risk).
    // Skip when resuming — era 0 is already complete, otherwise we wouldn't
    // have a checkpoint to resume from.
    if (t.era === 0 && resumeFrom === null) {
      let genesisEvents = 0
      const genesisWriter = async (ev: BalanceEvent): Promise<void> => {
        const out = activeOutput
        if (out === null) return
        out.eventCount++
        totalEvents++
        genesisEvents++
        await writeLine(out.eventsStream, JSON.stringify(ev))
      }
      await emitGenesisEvents(genesisState, genesisWriter)
      console.log(`  emitted ${genesisEvents} genesis allocation events`)
    }

    const bytes = await downloadIfMissing(t)
    console.log(`parsing ${fmtBytes(bytes.length)}`)
    const file = parseEraeFile(bytes)
    console.log(`  ${file.blockCount} blocks starting at ${file.startingBlock}`)

    const eraStart = Date.now()
    let lastBlockNumber = ''
    let lastBlockHashHex = ''
    for (const eb of file.blocks) {
      if (eb.number === 0n) continue // genesis, already loaded

      // Reconstruct full block RLP from separate header + body records.
      const headerFields = RLP.decode(eb.rawHeader) as unknown as Uint8Array[]
      const bodyFields = RLP.decode(eb.rawBody) as unknown as Uint8Array[][]
      const fullBlockRLP = RLP.encode([headerFields, ...bodyFields] as never)

      const block = createBlockFromRLP(fullBlockRLP, {
        common,
        skipConsensusFormatValidation: true,
      })

      stateManager.currentBlock = eb.number

      await runBlock(vm, {
        block,
        skipBlockValidation: true,
        skipHardForkValidation: true,
        skipHeaderValidation: true,
      })

      // Add to the blockchain so subsequent blocks' BLOCKHASH opcodes can
      // look this one up (valid for the last 256 blocks per EVM spec).
      await blockchain.putBlock(block)

      lastBlockNumber = eb.number.toString()
      lastBlockHashHex = toHex(eb.hash)
      await writeLine(
        activeOutput.metaStream,
        JSON.stringify({
          kind: 'block',
          block: lastBlockNumber,
          hash: lastBlockHashHex,
          cumulative: activeOutput.eventCount,
        }),
      )

      blocksProcessed++
      if (blocksProcessed % 1000 === 0) {
        const rate = blocksProcessed / ((Date.now() - startTs) / 1000)
        console.log(
          `  block ${eb.number}  total events=${totalEvents}  ${rate.toFixed(0)} blocks/s`,
        )
      }
    }

    console.log(
      `  era ${t.era} done in ${((Date.now() - eraStart) / 1000).toFixed(1)}s  events=${activeOutput.eventCount}`,
    )
    console.log(`    -> ${activeOutput.eventsPath}`)
    console.log(`    -> ${activeOutput.metaPath}`)
    await closeEraOutput(activeOutput)
    activeOutput = null

    if (t.era !== null && lastBlockNumber !== '') {
      const stateRoot = await stateManager.getStateRoot()
      await writeCheckpoint(t, {
        era: t.era,
        lastBlockNumber,
        lastBlockHash: lastBlockHashHex,
        stateRoot: toHex(stateRoot),
        eventCountTotal: totalEvents,
        updatedAt: new Date().toISOString(),
      })
      console.log(`    -> ${checkpointPath(t)}  stateRoot=${toHex(stateRoot)}`)
    }
  }

  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)
  console.log(
    `\nwrote ${totalEvents} events from ${blocksProcessed} blocks across ${targets.length} era(s) in ${elapsed}s`,
  )
}

const arg = process.argv[2] ?? '0..7'
const m = arg.match(/^(\d+)(?:\.\.(\d+))?$/)
if (m === null) {
  console.error(`invalid range: ${arg} (use e.g. "0..7" or "5")`)
  process.exit(1)
}
const lo = Number(m[1])
const hi = m[2] !== undefined ? Number(m[2]) : lo
await extract(lo, hi)
