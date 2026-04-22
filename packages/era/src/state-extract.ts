// Re-execute blocks from cached erae files through @ethereumjs/vm and emit
// one NDJSON line per balance mutation. Scoped to pre-Byzantium mainnet for
// now — that's where the VM is bit-perfect against geth.
//
// Output:
//   data/balance-events.ndjson       — one {block,addr,pre,post} per change
//   data/balance-events.meta.ndjson  — one sentinel per block (for checkpointing)

import { createWriteStream, type WriteStream } from 'node:fs'
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

import { DATA_DIR, downloadIfMissing, fmtBytes, resolveTargets } from './cli-shared.js'
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

// Genesis allocations are synthetic "0 → balance" events for block 0. Emitted
// before the VM hook is attached, then generateCanonicalGenesis loads them
// into the trie without double-counting.
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

function makeStreamWriter(stream: WriteStream): (line: string) => Promise<void> {
  return async (line) => {
    if (!stream.write(line)) {
      await new Promise<void>((res) => stream.once('drain', () => res()))
    }
  }
}

function toHex(b: Uint8Array): string {
  let s = '0x'
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

async function extract(loRange: number, hiRange: number): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const outPath = resolve(DATA_DIR, 'balance-events.ndjson')
  const metaPath = resolve(DATA_DIR, 'balance-events.meta.ndjson')

  const outStream = createWriteStream(outPath, { flags: 'w' })
  const metaStream = createWriteStream(metaPath, { flags: 'w' })
  const writeOut = makeStreamWriter(outStream)
  const writeMeta = makeStreamWriter(metaStream)

  let eventCount = 0
  const eventWriter = async (ev: BalanceEvent): Promise<void> => {
    eventCount++
    await writeOut(JSON.stringify(ev) + '\n')
  }

  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Chainstart })
  const stateManager = new TrackingStateManager({ common })

  // Mainnet genesis state. chainId = 1.
  const genesisState = getGenesis(1)
  if (genesisState === undefined) throw new Error('getGenesis(1) returned undefined')

  // Emit genesis events BEFORE attaching the writer to the state manager, so
  // the trie hydration below doesn't double-count.
  console.log(`emitting genesis allocations…`)
  const genesisEvents = await emitGenesisEvents(genesisState, eventWriter)
  console.log(`  ${genesisEvents} non-zero genesis allocations`)

  await stateManager.generateCanonicalGenesis(genesisState)
  stateManager.writer = eventWriter

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

  for (const t of targets) {
    console.log(`\n== era ${t.era} ==`)
    const bytes = await downloadIfMissing(t)
    console.log(`parsing ${fmtBytes(bytes.length)}`)
    const file = parseEraeFile(bytes)
    console.log(`  ${file.blockCount} blocks starting at ${file.startingBlock}`)

    const eraStart = Date.now()
    for (const eb of file.blocks) {
      if (eb.number === 0n) continue // genesis, already loaded

      // Reconstruct full block RLP from separate header + body records.
      // RLP.encode takes the same nested-array shape the decoder returns.
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

      await writeMeta(
        JSON.stringify({
          kind: 'block',
          block: eb.number.toString(),
          hash: toHex(eb.hash),
          cumulative: eventCount,
        }) + '\n',
      )

      blocksProcessed++
      if (blocksProcessed % 1000 === 0) {
        const rate = blocksProcessed / ((Date.now() - startTs) / 1000)
        console.log(
          `  block ${eb.number}  events=${eventCount}  ${rate.toFixed(0)} blocks/s`,
        )
      }
    }
    console.log(
      `  era ${t.era} done in ${((Date.now() - eraStart) / 1000).toFixed(1)}s`,
    )
  }

  await new Promise<void>((res) => outStream.end(() => res()))
  await new Promise<void>((res) => metaStream.end(() => res()))

  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)
  console.log(
    `\nwrote ${eventCount} events from ${blocksProcessed} blocks in ${elapsed}s`,
  )
  console.log(`  -> ${outPath}`)
  console.log(`  -> ${metaPath}`)
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
