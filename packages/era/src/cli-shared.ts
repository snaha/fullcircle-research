import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchEraeFile, parseEraeFile, type EraeBlock, type EraeFile } from './erae.js'

export const BASE_URL = 'https://data.ethpandaops.io/erae/mainnet'
export const CHECKSUMS_URL = `${BASE_URL}/checksums_sha256.txt`

// Always write into the repo-root `data/` directory, regardless of where the
// CLI is invoked from. Override with FULLCIRCLE_DATA_DIR.
export const DATA_DIR =
  process.env.FULLCIRCLE_DATA_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../data')

export interface Target {
  era: number | null // null when the URL was passed directly
  url: string
  fileBase: string
  eraePath: string
  blocksPath: string
  indexPath: string
  summaryPath: string
}

function targetFor(url: string, era: number | null): Target {
  const fileBase = basename(new URL(url).pathname).replace(/\.erae$/, '')
  return {
    era,
    url,
    fileBase,
    eraePath: resolve(DATA_DIR, `${fileBase}.erae`),
    blocksPath: resolve(DATA_DIR, `${fileBase}.blocks.ndjson`),
    indexPath: resolve(DATA_DIR, `${fileBase}.index.ndjson`),
    summaryPath: resolve(DATA_DIR, `${fileBase}.summary.json`),
  }
}

// CLI argument forms:
//   (nothing)       → eras 0..6
//   "7"             → era 7
//   "0..6"          → eras 0..6
//   "https://…"     → explicit URL (single target, no era number)
export async function resolveTargets(arg: string | undefined): Promise<Target[]> {
  await mkdir(DATA_DIR, { recursive: true })
  if (arg && /^https?:\/\//.test(arg)) return [targetFor(arg, null)]

  const [lo, hi] = parseRange(arg ?? '0..6')
  const filenames = await loadFilenames()
  const out: Target[] = []
  for (let era = lo; era <= hi; era++) {
    const fn = filenames.get(era)
    if (!fn) {
      console.error(`era ${era}: no filename in checksums — skipping`)
      continue
    }
    out.push(targetFor(`${BASE_URL}/${fn}`, era))
  }
  return out
}

export function header(t: Target): string {
  return t.era !== null ? `\n== era ${t.era} ==` : `\n== ${t.fileBase} ==`
}

// ---------- download ----------

/** Fetch the erae file if not already cached. Returns bytes either way. */
export async function downloadIfMissing(t: Target): Promise<Uint8Array> {
  if (existsSync(t.eraePath)) {
    const bytes = new Uint8Array(await readFile(t.eraePath))
    console.log(`cache  ${fmtBytes(bytes.length)} from ${basename(t.eraePath)}`)
    return bytes
  }
  const started = Date.now()
  console.log(`fetch  ${t.url}`)
  const bytes = await fetchEraeFile(t.url)
  await writeFile(t.eraePath, bytes)
  console.log(
    `       ${fmtBytes(bytes.length)} in ${Date.now() - started} ms -> ${basename(t.eraePath)}`,
  )
  return bytes
}

// ---------- process ----------

/** Read cached erae bytes, parse, build index, write artefacts. */
export async function processTarget(t: Target): Promise<void> {
  if (!existsSync(t.eraePath)) {
    throw new Error(`no cached file at ${t.eraePath} — run the download step first`)
  }
  const t0 = Date.now()
  const bytes = new Uint8Array(await readFile(t.eraePath))
  console.log(
    `read   ${fmtBytes(bytes.length)} from ${basename(t.eraePath)} in ${Date.now() - t0} ms`,
  )

  const t1 = Date.now()
  const file = parseEraeFile(bytes)
  const txTotal = file.blocks.reduce((n, b) => n + b.txHashes.length, 0)
  console.log(
    `parse  version=0x${file.version.toString(16)} start=${file.startingBlock} count=${file.blockCount} txs=${txTotal} in ${Date.now() - t1} ms`,
  )

  await writeSummary(t.summaryPath, t.url, file)
  await writeBlocksNdjson(t.blocksPath, file)
  await writeIndex(t.indexPath, file)
  console.log(
    `write  summary=${fmtBytes(statSync(t.summaryPath).size)}  blocks=${fmtBytes(statSync(t.blocksPath).size)}  index=${fmtBytes(statSync(t.indexPath).size)}`,
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
      throw new Error(`checksums: ${res.status} ${res.statusText} for ${CHECKSUMS_URL}`)
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

// ---------- helpers ----------

function parseRange(s: string): [number, number] {
  const m = s.match(/^(\d+)(?:\.\.(\d+))?$/)
  if (!m) throw new Error(`invalid range: ${s}`)
  const lo = parseInt(m[1], 10)
  const hi = m[2] ? parseInt(m[2], 10) : lo
  if (hi < lo) throw new Error(`invalid range: ${s}`)
  return [lo, hi]
}

export function fmtBytes(n: number): string {
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`
}

function hex(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += byte.toString(16).padStart(2, '0')
  return s
}

// ---------- writers ----------

async function writeSummary(path: string, sourceUrl: string, f: EraeFile): Promise<void> {
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

// Records are emitted interleaved in block order so an RPC tailer can just
// append new lines (one "block" + one "tx" per transaction) without
// rewriting. A consumer builds lookup maps by scanning the whole file once.
async function writeIndex(path: string, f: EraeFile): Promise<void> {
  const lines: string[] = []
  for (const b of f.blocks) {
    const number = b.number.toString()
    const blockHash = `0x${hex(b.hash)}`
    lines.push(JSON.stringify({ kind: 'block', number, hash: blockHash }))
    for (let i = 0; i < b.txHashes.length; i++) {
      lines.push(
        JSON.stringify({
          kind: 'tx',
          hash: `0x${hex(b.txHashes[i])}`,
          blockNumber: number,
          txIndex: i,
        }),
      )
    }
  }
  await writeFile(path, lines.join('\n') + '\n')
}
