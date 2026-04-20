import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  buildEraeIndex,
  fetchEraeFile,
  parseEraeFile,
  type EraeBlock,
  type EraeFile,
  type EraeIndex,
} from './erae.js'

const BASE_URL = 'https://data.ethpandaops.io/erae/mainnet'
const CHECKSUMS_URL = `${BASE_URL}/checksums_sha256.txt`
const DATA_DIR = resolve('data')

// CLI: `tsx src/run.ts`            → eras 0..6
//      `tsx src/run.ts 0..6`       → eras 0..6
//      `tsx src/run.ts 12`         → era 12 only
//      `tsx src/run.ts https://…`  → explicit URL
const arg = process.argv[2]
await mkdir(DATA_DIR, { recursive: true })

if (arg && /^https?:\/\//.test(arg)) {
  await processUrl(arg)
} else {
  const [lo, hi] = parseRange(arg ?? '0..6')
  const filenames = await loadFilenames()
  for (let era = lo; era <= hi; era++) {
    const fn = filenames.get(era)
    if (!fn) {
      console.error(`era ${era}: no filename in checksums — skipping`)
      continue
    }
    console.log(`\n== era ${era} ==`)
    await processUrl(`${BASE_URL}/${fn}`)
  }
}

// ---------- driver ----------

async function processUrl(url: string): Promise<void> {
  const fileBase = basename(new URL(url).pathname).replace(/\.erae$/, '')
  const eraePath = resolve(DATA_DIR, `${fileBase}.erae`)
  const blocksPath = resolve(DATA_DIR, `${fileBase}.blocks.ndjson`)
  const indexPath = resolve(DATA_DIR, `${fileBase}.index.json`)
  const summaryPath = resolve(DATA_DIR, `${fileBase}.summary.json`)

  let bytes: Uint8Array
  if (existsSync(eraePath)) {
    const t = Date.now()
    bytes = new Uint8Array(await readFile(eraePath))
    console.log(
      `cache  ${fmtBytes(bytes.length)} from ${basename(eraePath)} in ${Date.now() - t} ms`,
    )
  } else {
    const t = Date.now()
    console.log(`fetch  ${url}`)
    bytes = await fetchEraeFile(url)
    await writeFile(eraePath, bytes)
    console.log(
      `       ${fmtBytes(bytes.length)} in ${Date.now() - t} ms -> ${basename(eraePath)}`,
    )
  }

  const t1 = Date.now()
  const file = parseEraeFile(bytes)
  console.log(
    `parse  version=0x${file.version.toString(16)} start=${file.startingBlock} count=${file.blockCount} in ${Date.now() - t1} ms`,
  )

  const t2 = Date.now()
  const index = buildEraeIndex(file)
  console.log(
    `index  ${index.byNumber.size} blocks, ${index.byTxHash.size} txs in ${Date.now() - t2} ms`,
  )

  await writeSummary(summaryPath, url, file)
  await writeBlocksNdjson(blocksPath, file)
  await writeIndex(indexPath, index)
  console.log(
    `write  summary=${fmtBytes(statSync(summaryPath).size)}  blocks=${fmtBytes(statSync(blocksPath).size)}  index=${fmtBytes(statSync(indexPath).size)}`,
  )
}

// ---------- checksums ----------

async function loadFilenames(): Promise<Map<number, string>> {
  const localPath = resolve(DATA_DIR, 'checksums_sha256.txt')
  let text: string
  if (existsSync(localPath)) {
    text = await readFile(localPath, 'utf8')
  } else {
    console.log(`fetch  ${CHECKSUMS_URL}`)
    const res = await fetch(CHECKSUMS_URL)
    if (!res.ok) {
      throw new Error(
        `checksums: ${res.status} ${res.statusText} for ${CHECKSUMS_URL}`,
      )
    }
    text = await res.text()
    await writeFile(localPath, text)
  }
  const out = new Map<number, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\s+(mainnet-(\d{5})-[0-9a-f]+\.erae)\s*$/)
    if (m) out.set(parseInt(m[2], 10), m[1])
  }
  return out
}

// ---------- range parsing ----------

function parseRange(s: string): [number, number] {
  const m = s.match(/^(\d+)(?:\.\.(\d+))?$/)
  if (!m) throw new Error(`invalid range: ${s}`)
  const lo = parseInt(m[1], 10)
  const hi = m[2] ? parseInt(m[2], 10) : lo
  if (hi < lo) throw new Error(`invalid range: ${s}`)
  return [lo, hi]
}

// ---------- formatting ----------

function fmtBytes(n: number): string {
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`
}
function hex(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

// ---------- writers ----------

async function writeSummary(
  path: string,
  sourceUrl: string,
  f: EraeFile,
): Promise<void> {
  const first = f.blocks[0]
  const last = f.blocks[f.blocks.length - 1]
  const body = {
    sourceUrl,
    version: `0x${f.version.toString(16)}`,
    startingBlock: f.startingBlock.toString(),
    blockCount: f.blockCount,
    accumulatorRoot: f.accumulatorRoot ? `0x${hex(f.accumulatorRoot)}` : null,
    firstBlock: {
      number: first.number.toString(),
      hash: `0x${hex(first.hash)}`,
      txCount: first.txHashes.length,
    },
    lastBlock: {
      number: last.number.toString(),
      hash: `0x${hex(last.hash)}`,
      txCount: last.txHashes.length,
    },
    totalTxs: f.blocks.reduce((n, b) => n + b.txHashes.length, 0),
  }
  await writeFile(path, JSON.stringify(body, null, 2))
}

async function writeBlocksNdjson(path: string, f: EraeFile): Promise<void> {
  const lines: string[] = new Array(f.blocks.length)
  for (let i = 0; i < f.blocks.length; i++) lines[i] = blockToJson(f.blocks[i])
  await writeFile(path, lines.join('\n') + '\n')
}

function blockToJson(b: EraeBlock): string {
  return JSON.stringify({
    number: b.number.toString(),
    hash: `0x${hex(b.hash)}`,
    totalDifficulty: b.totalDifficulty?.toString() ?? null,
    txHashes: b.txHashes.map((h) => `0x${hex(h)}`),
    rawHeader: `0x${hex(b.rawHeader)}`,
    rawBody: `0x${hex(b.rawBody)}`,
    rawReceipts: `0x${hex(b.rawReceipts)}`,
    proof: b.proof ? `0x${hex(b.proof)}` : null,
  })
}

async function writeIndex(path: string, idx: EraeIndex): Promise<void> {
  const numberToHash: Record<string, string> = {}
  const hashToNumber: Record<string, string> = {}
  for (const [n, b] of idx.byNumber) {
    numberToHash[n.toString()] = `0x${hex(b.hash)}`
  }
  for (const [h, b] of idx.byBlockHash) {
    hashToNumber[`0x${h}`] = b.number.toString()
  }
  const txHashToLoc: Record<string, [string, number]> = {}
  for (const [h, loc] of idx.byTxHash) {
    txHashToLoc[`0x${h}`] = [loc.block.number.toString(), loc.txIndex]
  }
  await writeFile(
    path,
    JSON.stringify({ numberToHash, hashToNumber, txHashToLoc }),
  )
}
