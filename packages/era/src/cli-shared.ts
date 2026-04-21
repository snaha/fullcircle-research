import { once } from 'node:events'
import { createWriteStream, existsSync, statSync, type WriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchEraeFile, openEraeFile, type EraeBlock, type EraeReader } from './erae.js'

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
  balanceEventsPath: string
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
    balanceEventsPath: resolve(DATA_DIR, `${fileBase}.balance-events.ndjson`),
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

/**
 * Stream-process an erae file: decompress one block at a time, write directly
 * to disk. Reduces peak memory from ~3 GB to ~750 MB for large files.
 */
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
  const reader = openEraeFile(bytes)
  console.log(
    `open   version=0x${reader.version.toString(16)} start=${reader.startingBlock} count=${reader.blockCount} in ${Date.now() - t1} ms`,
  )

  // Stream one block at a time: decompress → serialize → append → free. Holding
  // all decoded blocks at once OOMs on full eras (~2M txs, GBs of raw bytes).
  const t2 = Date.now()
  const blocksStream = createWriteStream(t.blocksPath)
  const indexStream = createWriteStream(t.indexPath)

  let firstBlock: EraeBlockSummary | null = null
  let lastBlock: EraeBlockSummary | null = null
  let totalTxs = 0

  try {
    for (const block of reader.blocks()) {
      await writeLine(blocksStream, blockToJson(block))
      const number = block.number.toString()
      const blockHash = `0x${hex(block.hash)}`
      await writeLine(indexStream, JSON.stringify({ kind: 'block', number, hash: blockHash }))
      for (let i = 0; i < block.txHashes.length; i++) {
        await writeLine(
          indexStream,
          JSON.stringify({
            kind: 'tx',
            hash: `0x${hex(block.txHashes[i])}`,
            blockNumber: number,
            txIndex: i,
          }),
        )
      }

      const summary: EraeBlockSummary = {
        number,
        hash: blockHash,
        txCount: block.txHashes.length,
      }
      if (!firstBlock) firstBlock = summary
      lastBlock = summary
      totalTxs += block.txHashes.length
    }
  } finally {
    await closeStream(blocksStream)
    await closeStream(indexStream)
  }

  if (!firstBlock || !lastBlock) {
    throw new Error(`processTarget: no blocks decoded from ${basename(t.eraePath)}`)
  }
  console.log(`stream txs=${totalTxs} in ${Date.now() - t2} ms`)

  await writeSummary(t.summaryPath, t.url, reader, firstBlock, lastBlock, totalTxs)
  console.log(
    `write  summary=${fmtBytes(statSync(t.summaryPath).size)}  blocks=${fmtBytes(statSync(t.blocksPath).size)}  index=${fmtBytes(statSync(t.indexPath).size)}`,
  )
}

interface EraeBlockSummary {
  number: string
  hash: string
  txCount: number
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (!stream.write(line + '\n')) await once(stream, 'drain')
}

async function closeStream(stream: WriteStream): Promise<void> {
  stream.end()
  await once(stream, 'finish')
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

async function writeSummary(
  path: string,
  sourceUrl: string,
  reader: EraeReader,
  firstBlock: EraeBlockSummary,
  lastBlock: EraeBlockSummary,
  totalTxs: number,
): Promise<void> {
  const body = {
    sourceUrl,
    version: `0x${reader.version.toString(16)}`,
    startingBlock: reader.startingBlock.toString(),
    blockCount: reader.blockCount,
    accumulatorRoot: reader.accumulatorRoot ? `0x${hex(reader.accumulatorRoot)}` : null,
    firstBlock,
    lastBlock,
    totalTxs,
  }
  await writeFile(path, JSON.stringify(body, null, 2))
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
