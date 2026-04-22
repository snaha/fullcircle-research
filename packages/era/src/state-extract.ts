// Re-execute blocks from cached erae files through @ethereumjs/vm and emit
// one NDJSON line per balance mutation. Scoped to pre-Byzantium mainnet for
// now — that's where the VM is bit-perfect against geth.
//
// Output, per processed era (matching the existing era-package file-naming
// convention — same `fileBase` as `.erae` / `.blocks.ndjson` / etc):
//
//   data/<fileBase>.balance-events.ndjson       one {block,addr,pre,post}
//   data/<fileBase>.balance-events.meta.ndjson  one sentinel per block
//
// The range MUST start at era 0. Checkpoint resume isn't implemented yet, so
// every run replays from genesis in-memory.

import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RLP } from '@ethereumjs/rlp'
import { createBlockFromRLP } from '@ethereumjs/block'
import { createBlockchain } from '@ethereumjs/blockchain'
import { Common, Mainnet, Hardfork } from '@ethereumjs/common'
import { getGenesis } from '@ethereumjs/genesis'
import { MerkleStateManager } from '@ethereumjs/statemanager'
import type { Account, Address } from '@ethereumjs/util'
import { createVM, runBlock } from '@ethereumjs/vm'

import { DATA_DIR, downloadIfMissing, fmtBytes, resolveTargets, type Target } from './cli-shared.js'
import { parseEraeFile } from './erae.js'

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

async function extract(loRange: number, hiRange: number): Promise<void> {
  if (loRange !== 0) {
    throw new Error(
      `state-extract: range must start at era 0 (got ${loRange}). Checkpoint resume isn't supported yet — the VM replays from genesis every run.`,
    )
  }

  await mkdir(DATA_DIR, { recursive: true })

  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Chainstart })
  const stateManager = new TrackingStateManager({ common })

  const genesisState = getGenesis(1) // mainnet
  if (genesisState === undefined) throw new Error('getGenesis(1) returned undefined')

  await stateManager.generateCanonicalGenesis(genesisState)

  const blockchain = await createBlockchain({
    common,
    genesisState,
    validateBlocks: false,
    validateConsensus: false,
  })
  const vm = await createVM({ common, stateManager, blockchain })

  const targets = await resolveTargets(`${loRange}..${hiRange}`)
  const startTs = Date.now()
  let blocksProcessed = 0
  let totalEvents = 0
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
    if (t.era === 0) {
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

      await writeLine(
        activeOutput.metaStream,
        JSON.stringify({
          kind: 'block',
          block: eb.number.toString(),
          hash: toHex(eb.hash),
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
