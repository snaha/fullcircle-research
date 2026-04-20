// Loads per-era metadata + indexes from the shared `data/` directory and
// provides lookups used by the RPC handlers. The data folder stands in for
// Swarm while the project is still a PoC.

import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline'

export interface EraMeta {
  fileBase: string
  startingBlock: bigint
  blockCount: number
  blocksPath: string
  indexPath: string
  summaryPath: string
}

export interface EraLocator {
  era: EraMeta
  number: bigint
}

export interface BlockRecord {
  number: bigint
  hash: string // 0x-prefixed
  totalDifficulty: bigint | null
  txHashes: string[] // 0x-prefixed
  rawHeader: Uint8Array
}

interface RawBlockLine {
  number: string
  hash: string
  totalDifficulty: string | null
  txHashes: string[]
  rawHeader: string
  rawBody: string
  rawReceipts: string
  proof: string | null
}

interface SummaryFile {
  startingBlock: string
  blockCount: number
}

interface IndexTxLine {
  kind: 'tx'
  hash: string
  blockNumber: string
  txIndex: number
}

interface IndexBlockLine {
  kind: 'block'
  number: string
  hash: string
}

type IndexLine = IndexTxLine | IndexBlockLine

export class DataStore {
  private eras: EraMeta[] = []
  private byBlockHash = new Map<string, EraLocator>()
  private byTxHash = new Map<string, { era: EraMeta; blockNumber: bigint; txIndex: number }>()
  private highestBlock = -1n

  constructor(public readonly dataDir: string) {}

  async load(): Promise<void> {
    const entries = await readdir(this.dataDir)
    const summaryFiles = entries
      .filter((f) => f.endsWith('.summary.json'))
      .sort()

    for (const name of summaryFiles) {
      const summaryPath = resolve(this.dataDir, name)
      const raw = await readFile(summaryPath, 'utf8')
      const summary = JSON.parse(raw) as SummaryFile
      const fileBase = name.replace(/\.summary\.json$/, '')
      const era: EraMeta = {
        fileBase,
        startingBlock: BigInt(summary.startingBlock),
        blockCount: summary.blockCount,
        blocksPath: resolve(this.dataDir, `${fileBase}.blocks.ndjson`),
        indexPath: resolve(this.dataDir, `${fileBase}.index.ndjson`),
        summaryPath,
      }
      this.eras.push(era)
      const last = era.startingBlock + BigInt(era.blockCount) - 1n
      if (last > this.highestBlock) this.highestBlock = last
      await this.ingestIndex(era)
    }

    this.eras.sort((a, b) =>
      a.startingBlock < b.startingBlock ? -1 : a.startingBlock > b.startingBlock ? 1 : 0,
    )
  }

  get latestBlockNumber(): bigint {
    if (this.highestBlock < 0n) throw new Error('DataStore: no eras loaded')
    return this.highestBlock
  }

  get loadedEras(): readonly EraMeta[] {
    return this.eras
  }

  eraForNumber(n: bigint): EraMeta | null {
    for (const era of this.eras) {
      const end = era.startingBlock + BigInt(era.blockCount)
      if (n >= era.startingBlock && n < end) return era
    }
    return null
  }

  locatorForHash(hash: string): EraLocator | null {
    return this.byBlockHash.get(hash.toLowerCase()) ?? null
  }

  /**
   * Stream the era's blocks.ndjson, return the block at the requested number.
   * O(blocksInEra) scan per call — good enough for a PoC; a byte-offset index
   * would be the follow-up.
   */
  async readBlockByNumber(n: bigint): Promise<BlockRecord | null> {
    const era = this.eraForNumber(n)
    if (!era) return null
    const target = n.toString()
    const stream = createReadStream(era.blocksPath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line) continue
        const row = JSON.parse(line) as RawBlockLine
        if (row.number !== target) continue
        return toBlockRecord(row)
      }
      return null
    } finally {
      rl.close()
      stream.destroy()
    }
  }

  async readBlockByHash(hash: string): Promise<BlockRecord | null> {
    const loc = this.locatorForHash(hash)
    if (!loc) return null
    return this.readBlockByNumber(loc.number)
  }

  private async ingestIndex(era: EraMeta): Promise<void> {
    const stream = createReadStream(era.indexPath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line) continue
        const row = JSON.parse(line) as IndexLine
        if (row.kind === 'block') {
          this.byBlockHash.set(row.hash.toLowerCase(), {
            era,
            number: BigInt(row.number),
          })
        } else {
          this.byTxHash.set(row.hash.toLowerCase(), {
            era,
            blockNumber: BigInt(row.blockNumber),
            txIndex: row.txIndex,
          })
        }
      }
    } finally {
      rl.close()
      stream.destroy()
    }
  }
}

function toBlockRecord(row: RawBlockLine): BlockRecord {
  return {
    number: BigInt(row.number),
    hash: row.hash,
    totalDifficulty: row.totalDifficulty ? BigInt(row.totalDifficulty) : null,
    txHashes: row.txHashes,
    rawHeader: hexToBytes(row.rawHeader),
  }
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex
  if (s.length % 2 !== 0) throw new Error(`hexToBytes: odd-length hex from ${basename(hex)}`)
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
