// SQLite + Swarm indexer with proper Merkle tree for Range request support.
//
// Stores block indexes in a SQLite database and uploads to Swarm as a proper
// content-addressed Merkle tree. This enables sql.js-httpvfs to query the
// database via HTTP Range requests - Swarm can serve any byte range by
// traversing the tree structure.
//
// Schema:
//   blocks(number INTEGER PRIMARY KEY, hash BLOB, swarm_ref BLOB)
//   transactions(tx_hash BLOB PRIMARY KEY, block_number INTEGER)
//   accounts(address BLOB PRIMARY KEY, swarm_ref BLOB) -- ref of AccountRecord JSON
//   balance_blocks(block_number INTEGER PRIMARY KEY, swarm_ref BLOB) -- ref of BlockEventsRecord JSON
//   meta(key TEXT PRIMARY KEY, value TEXT) -- aggregate counts; see writeMeta()
//
// Lookup flow (client):
//   1. Fetch SQLite database via root reference (dbRef)
//   2. Use sql.js-httpvfs with Swarm Range requests to query SQLite
//   3. Get swarm_ref for block/account, fetch payload directly via /bytes/{ref}

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { Bee } from '@ethersphere/bee-js'
import { encodeBlockBundle } from './bundle.js'

// ---------- Constants ----------

const PAGE_SIZE = 4096 // SQLite default page size, matches Swarm chunk size
const SEGMENT_SIZE = 32

// ---------- Types ----------

export interface BlockRecord {
  number: string
  hash: string
  totalDifficulty: string | null
  txHashes: string[]
  rawHeader: string
  rawBody: string
  rawReceipts: string
}

export interface SqliteIndexerOptions {
  dbPath: string // Local path to SQLite file
  onProgress?: (msg: string) => void
}

export interface SyncOptions {
  batchId: string
  onProgress?: (msg: string) => void
}

export interface SyncResult {
  dbRef: string // Swarm reference to root of Merkle tree (enables Range requests)
  totalPages: number
  pagesUploaded: number
  pagesSkipped: number
  /**
   * The Bee tag uid used for every chunk uploaded in this sync. Reuse for
   * related follow-up uploads (e.g. the epoch-feed SOC) so Bee sees them as
   * the same sync batch — fresh tags can hang on peerless nodes.
   *
   * `null` when the `/tags` endpoint is unavailable (e.g. on a public
   * gateway). In that case chunks are uploaded with `deferred=false` instead.
   */
  tagUid: number | null
}

export interface AddBlocksResult {
  blocksAdded: number
  blocksSkipped: number
  txHashesAdded: number
}

export interface AddSingleBlockResult {
  blockNumber: number
  skipped: boolean
  txHashesAdded: number
}

export interface AddBalanceEventsResult {
  addressCount: number
  blockCount: number
  eventCount: number
}

/**
 * Aggregate counts persisted in the `meta` table of the DB. Matches the
 * shape of `PotMeta` / `ManifestMeta` so the explorer can treat it
 * source-agnostically.
 */
export interface SqliteMeta {
  firstBlock: string
  lastBlock: string
  blockCount: string
  txCount: string
  addressCount: string
  eventCount: string
}

// Chunk with span tracking for proper Merkle tree building
interface ChunkWithSpan {
  data: Uint8Array // span (8 bytes) + payload
  address: Uint8Array // BMT hash (content address)
  span: bigint // actual span value (for cumulative tracking)
}

// Number of 32-byte references per chunk (4096 / 32 = 128)
const REFS_PER_CHUNK = 128

// ---------- BMT Hash Utilities ----------

// Simple keccak256 using @noble/hashes
import { keccak_256 } from '@noble/hashes/sha3'

function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

function partition(data: Uint8Array, size: number): Uint8Array[] {
  const result: Uint8Array[] = []
  for (let i = 0; i < data.length; i += size) {
    result.push(data.slice(i, i + size))
  }
  return result
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

// ---------- Hex Utilities ----------

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

// ---------- SqliteIndexer Class ----------

export class SqliteIndexer {
  private db: DatabaseSync
  private dbPath: string
  private log: (msg: string) => void

  constructor(options: SqliteIndexerOptions) {
    this.dbPath = options.dbPath
    this.log = options.onProgress ?? console.log
    this.db = new DatabaseSync(this.dbPath)
    this.initSchema()
  }

  private initSchema(): void {
    // Set page size to 4096 (must be done before creating tables)
    this.db.exec('PRAGMA page_size = 4096')
    // WAL mode for better write performance with frequent commits
    this.db.exec('PRAGMA journal_mode = WAL')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        number INTEGER PRIMARY KEY,
        hash BLOB NOT NULL,
        swarm_ref BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);

      CREATE TABLE IF NOT EXISTS transactions (
        tx_hash BLOB PRIMARY KEY,
        block_number INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block_number);

      CREATE TABLE IF NOT EXISTS accounts (
        address BLOB PRIMARY KEY,
        swarm_ref BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS balance_blocks (
        block_number INTEGER PRIMARY KEY,
        swarm_ref BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  private runInTransaction(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Create a content-addressed chunk with explicit span.
   * The span is crucial for Range request support - intermediates need cumulative span.
   */
  private makeContentAddressedChunkWithSpan(payload: Uint8Array, span?: bigint): ChunkWithSpan {
    const actualSpan = span ?? BigInt(payload.length)

    // Build span bytes (8 bytes, little-endian)
    const spanBytes = new Uint8Array(8)
    new DataView(spanBytes.buffer).setBigUint64(0, actualSpan, true)

    // Pad payload to 4096 bytes for BMT computation
    const padded = new Uint8Array(PAGE_SIZE)
    padded.set(payload.slice(0, Math.min(payload.length, PAGE_SIZE)))

    // Build BMT tree by hashing pairs of 32-byte segments
    let currentLevel = partition(padded, SEGMENT_SIZE)
    while (currentLevel.length > 1) {
      const nextLevel: Uint8Array[] = []
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i]
        const right = currentLevel[i + 1]
        nextLevel.push(keccak256(concatBytes(left, right)))
      }
      currentLevel = nextLevel
    }

    // Final hash includes span (this is the chunk address)
    const address = keccak256(concatBytes(spanBytes, currentLevel[0]))

    // Full chunk data = span + payload
    const data = concatBytes(spanBytes, payload)

    return { data, address, span: actualSpan }
  }

  /**
   * Build Merkle tree from chunk refs, upload intermediate chunks, return root ref.
   * Tracks cumulative spans for proper Range request support.
   */
  private async buildMerkleTree(
    bee: Bee,
    batchId: string,
    refs: ChunkWithSpan[],
    log: (msg: string) => void,
    tagUid: number | null,
  ): Promise<string> {
    // Base case: single ref is the root
    if (refs.length === 1) {
      return bytesToHex(refs[0].address)
    }

    const intermediateRefs: ChunkWithSpan[] = []

    // Process refs in batches of REFS_PER_CHUNK (128)
    for (let i = 0; i < refs.length; i += REFS_PER_CHUNK) {
      const batch = refs.slice(i, Math.min(i + REFS_PER_CHUNK, refs.length))

      // Calculate cumulative span for this intermediate node
      const totalSpan = batch.reduce((sum, ref) => sum + ref.span, 0n)

      // Build payload: concatenate 32-byte addresses
      const payload = new Uint8Array(batch.length * 32)
      batch.forEach((ref, idx) => payload.set(ref.address, idx * 32))

      // Create intermediate chunk with cumulative span
      const chunk = this.makeContentAddressedChunkWithSpan(payload, totalSpan)

      // Upload intermediate chunk using bee-js. Tag is required to avoid
      // hanging on peerless nodes; when /tags is unavailable (e.g. gateway)
      // we fall back to deferred=false so Bee pushes synchronously.
      await bee.uploadChunk(batchId, chunk.data, chunkUploadOptions(tagUid))
      intermediateRefs.push(chunk)
    }

    log(`built ${intermediateRefs.length} intermediate chunks (level)`)

    // Recursively build until we have a single root
    return this.buildMerkleTree(bee, batchId, intermediateRefs, log, tagUid)
  }

  /**
   * Add a single block to the index.
   */
  addBlock(
    blockNumber: number,
    blockHash: Uint8Array,
    swarmRef: Uint8Array,
    txHashes: Uint8Array[],
  ): void {
    const insertBlock = this.db.prepare(
      'INSERT OR REPLACE INTO blocks (number, hash, swarm_ref) VALUES (?, ?, ?)',
    )
    const insertTx = this.db.prepare(
      'INSERT OR REPLACE INTO transactions (tx_hash, block_number) VALUES (?, ?)',
    )

    this.runInTransaction(() => {
      insertBlock.run(blockNumber, blockHash, swarmRef)
      for (const txHash of txHashes) {
        insertTx.run(txHash, blockNumber)
      }
    })
  }

  /**
   * Get all block numbers that already have a swarm_ref in the database.
   * Used for resume detection - blocks with swarm_ref have been successfully uploaded.
   */
  getExistingBlockNumbers(): Set<number> {
    const stmt = this.db.prepare('SELECT number FROM blocks WHERE swarm_ref IS NOT NULL')
    const rows = stmt.all() as Array<{ number: number }>
    return new Set(rows.map((r) => r.number))
  }

  /**
   * Check if a specific block number exists in the database with a swarm_ref.
   */
  hasBlock(blockNumber: number): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM blocks WHERE number = ? AND swarm_ref IS NOT NULL')
    return stmt.get(blockNumber) !== undefined
  }

  /**
   * Stream blocks from ndjson file and add to index + upload bundles.
   */
  async addBlocksFromNdjson(
    bee: Bee,
    blocksPath: string,
    options: { batchId: string; blockNumber?: number; onProgress?: (msg: string) => void },
  ): Promise<AddBlocksResult> {
    const log = options.onProgress ?? this.log
    let blocksAdded = 0
    let blocksSkipped = 0
    let txHashesAdded = 0

    // Load existing blocks for resume detection (O(1) lookup)
    const existingBlocks = this.getExistingBlockNumbers()
    if (existingBlocks.size > 0) {
      log(`found ${existingBlocks.size} existing blocks, resuming...`)
    }

    const insertBlock = this.db.prepare(
      'INSERT OR REPLACE INTO blocks (number, hash, swarm_ref) VALUES (?, ?, ?)',
    )
    const insertTx = this.db.prepare(
      'INSERT OR REPLACE INTO transactions (tx_hash, block_number) VALUES (?, ?)',
    )

    const rl = createInterface({
      input: createReadStream(blocksPath, 'utf8'),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (!line.trim()) continue

      const block = JSON.parse(line) as BlockRecord
      const blockNumber = parseInt(block.number, 10)

      // Skip blocks that don't match target (single block mode)
      if (options.blockNumber !== undefined && blockNumber !== options.blockNumber) {
        continue
      }

      // Skip already-uploaded blocks (resume support)
      if (existingBlocks.has(blockNumber)) {
        blocksSkipped++
        // Early exit in single block mode
        if (options.blockNumber !== undefined) {
          break
        }
        continue
      }

      // Encode and upload block bundle
      const bundleBytes = encodeBlockBundle({
        rawHeader: hexToBytes(block.rawHeader),
        rawBody: hexToBytes(block.rawBody),
        rawReceipts: hexToBytes(block.rawReceipts),
        totalDifficulty: block.totalDifficulty === null ? null : BigInt(block.totalDifficulty),
      })
      const uploadResult = await withTimeout(
        bee.uploadData(options.batchId, bundleBytes),
        30_000,
        `block ${blockNumber}`,
      )
      const swarmRef = uploadResult.reference.toUint8Array()

      // Add to SQLite index (committed immediately for crash recovery)
      const blockHash = hexToBytes(block.hash)
      const txHashes = block.txHashes.map(hexToBytes)

      this.runInTransaction(() => {
        insertBlock.run(blockNumber, blockHash, swarmRef)
        for (const txHash of txHashes) {
          insertTx.run(txHash, blockNumber)
        }
        txHashesAdded += txHashes.length
      })

      blocksAdded++
      if (blocksAdded % 100 === 0) {
        log(`indexed ${blocksAdded} blocks, ${txHashesAdded} tx hashes`)
      }

      // Early exit in single block mode
      if (options.blockNumber !== undefined) {
        break
      }
    }

    return { blocksAdded, blocksSkipped, txHashesAdded }
  }

  /**
   * Add a single block to the index (for per-block timing measurements).
   * Parses JSON, encodes bundle, uploads to Swarm, and inserts into SQLite.
   */
  async addSingleBlock(
    bee: Bee,
    blockJson: string,
    batchId: string,
  ): Promise<AddSingleBlockResult> {
    const block = JSON.parse(blockJson) as BlockRecord
    const blockNumber = parseInt(block.number, 10)

    // Check if block already exists (skip if already uploaded)
    if (this.hasBlock(blockNumber)) {
      return { blockNumber, skipped: true, txHashesAdded: 0 }
    }

    // Encode and upload block bundle
    const bundleBytes = encodeBlockBundle({
      rawHeader: hexToBytes(block.rawHeader),
      rawBody: hexToBytes(block.rawBody),
      rawReceipts: hexToBytes(block.rawReceipts),
      totalDifficulty: block.totalDifficulty === null ? null : BigInt(block.totalDifficulty),
    })
    const uploadResult = await withTimeout(
      bee.uploadData(batchId, bundleBytes),
      30_000,
      `block ${blockNumber}`,
    )
    const swarmRef = uploadResult.reference.toUint8Array()

    // Add to SQLite index
    const blockHash = hexToBytes(block.hash)
    const txHashes = block.txHashes.map(hexToBytes)

    const insertBlock = this.db.prepare(
      'INSERT OR REPLACE INTO blocks (number, hash, swarm_ref) VALUES (?, ?, ?)',
    )
    const insertTx = this.db.prepare(
      'INSERT OR REPLACE INTO transactions (tx_hash, block_number) VALUES (?, ?)',
    )

    this.runInTransaction(() => {
      insertBlock.run(blockNumber, blockHash, swarmRef)
      for (const txHash of txHashes) {
        insertTx.run(txHash, blockNumber)
      }
    })

    return { blockNumber, skipped: false, txHashesAdded: txHashes.length }
  }

  /**
   * Aggregate balance-mutation events from one or more NDJSON files and add
   * them to the SQLite `accounts` and `balance_blocks` tables. Events are
   * accumulated across every input file first so per-address history spans
   * all eras in the run — mirrors `addBalanceEventsToPot` /
   * `addBalanceEventsToManifest`.
   *
   * Per address, uploads one `AccountRecord` JSON chunk (final balance + the
   * full block-ordered event log) and records its ref in `accounts`. Per
   * block, uploads one `BlockEventsRecord` JSON chunk and records its ref in
   * `balance_blocks`. Upload is two-phase (parallel uploads, then a single
   * SQL transaction) to keep bee-js concurrency high while the SQLite writes
   * stay cheap.
   *
   * Overwrite semantics: re-running with overlapping data replaces the
   * previous row (the earlier JSON chunk is orphaned). Upload all eras in
   * one run to keep per-address history coherent.
   */
  async addBalanceEventsFromNdjson(
    bee: Bee,
    eventsPaths: string[],
    options: {
      batchId: string
      onProgress?: (msg: string) => void
      concurrency?: number
    },
  ): Promise<AddBalanceEventsResult> {
    const log = options.onProgress ?? this.log
    const concurrency = options.concurrency ?? 32

    const byAddr = new Map<string, { block: string; pre: string; post: string }[]>()
    const byBlock = new Map<string, { addr: string; pre: string; post: string }[]>()
    let eventCount = 0

    for (const path of eventsPaths) {
      log(`reading ${path}`)
      let perFile = 0
      for await (const ev of readBalanceEventsNdjson(path)) {
        const addrEntry = byAddr.get(ev.addr)
        if (addrEntry === undefined) {
          byAddr.set(ev.addr, [{ block: ev.block, pre: ev.pre, post: ev.post }])
        } else {
          addrEntry.push({ block: ev.block, pre: ev.pre, post: ev.post })
        }
        const blockEntry = byBlock.get(ev.block)
        if (blockEntry === undefined) {
          byBlock.set(ev.block, [{ addr: ev.addr, pre: ev.pre, post: ev.post }])
        } else {
          blockEntry.push({ addr: ev.addr, pre: ev.pre, post: ev.post })
        }
        eventCount++
        perFile++
      }
      log(`  ${perFile} events from ${path}`)
    }

    if (eventCount === 0) {
      log('no balance events — skipping state upload')
      return { addressCount: 0, blockCount: 0, eventCount: 0 }
    }

    log(
      `aggregated ${eventCount} events across ${byAddr.size} addresses and ${byBlock.size} blocks`,
    )

    const accountEntries = [...byAddr.entries()]
    log(`uploading ${accountEntries.length} account records...`)
    const accountRefs: { key: Uint8Array; ref: Uint8Array }[] = new Array(accountEntries.length)
    await runWithConcurrency(
      accountEntries,
      concurrency,
      async ([addr, events], i) => {
        events.sort((a, b) => {
          const da = BigInt(a.block) - BigInt(b.block)
          return da < 0n ? -1 : da > 0n ? 1 : 0
        })
        const record: AccountRecord = {
          addr,
          balance: events[events.length - 1].post,
          eventCount: events.length,
          events,
        }
        const bytes = textEncoder.encode(JSON.stringify(record))
        const { reference } = await bee.uploadData(options.batchId, bytes)
        const normalizedAddr = addr.toLowerCase().replace(/^0x/, '')
        if (!/^[0-9a-f]{40}$/.test(normalizedAddr)) {
          throw new Error(`invalid address in balance events: ${addr}`)
        }
        accountRefs[i] = { key: hexToBytes(normalizedAddr), ref: reference.toUint8Array() }
      },
      (done, total) => log(`  accounts ${done}/${total}`),
    )

    const blockEntries = [...byBlock.entries()]
    log(`uploading ${blockEntries.length} per-block event records...`)
    const blockRefs: { key: number; ref: Uint8Array }[] = new Array(blockEntries.length)
    await runWithConcurrency(
      blockEntries,
      concurrency,
      async ([blockStr, events], i) => {
        events.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
        const record: BlockEventsRecord = { block: blockStr, events }
        const bytes = textEncoder.encode(JSON.stringify(record))
        const { reference } = await bee.uploadData(options.batchId, bytes)
        const numberKey = Number(blockStr)
        if (!Number.isSafeInteger(numberKey)) {
          throw new Error(`block number ${blockStr} exceeds Number.MAX_SAFE_INTEGER`)
        }
        blockRefs[i] = { key: numberKey, ref: reference.toUint8Array() }
      },
      (done, total) => log(`  blocks ${done}/${total}`),
    )

    const insertAccount = this.db.prepare(
      'INSERT OR REPLACE INTO accounts (address, swarm_ref) VALUES (?, ?)',
    )
    const insertBalanceBlock = this.db.prepare(
      'INSERT OR REPLACE INTO balance_blocks (block_number, swarm_ref) VALUES (?, ?)',
    )
    this.runInTransaction(() => {
      for (const { key, ref } of accountRefs) {
        insertAccount.run(key, ref)
      }
      for (const { key, ref } of blockRefs) {
        insertBalanceBlock.run(key, ref)
      }
    })

    return { addressCount: byAddr.size, blockCount: byBlock.size, eventCount }
  }

  /**
   * Compute aggregate counts from the DB and persist them in the `meta`
   * table. The DB is self-describing — no separate Swarm meta chunk is
   * needed, so a single `dbRef` carries everything the explorer reads.
   *
   * `eventCountDelta` is the number of balance events added in the current
   * run. It's accumulated on top of whatever is already in the meta row,
   * mirroring `addBalanceEventsToPot`'s counter behaviour — individual
   * events live in JSON chunks on Swarm, so their total can't be recovered
   * from SQL alone. Everything else (first/last block, block / tx / account
   * counts) is authoritative from the DB tables themselves.
   *
   * Safe to call multiple times: later calls overwrite earlier ones with
   * the latest DB state plus the supplied delta. For extension uploads
   * (era 7 on top of 0..6), pass only the new run's event count.
   */
  writeMeta(eventCountDelta: number): SqliteMeta {
    const blockRange = this.db
      .prepare('SELECT MIN(number) as first, MAX(number) as last, COUNT(*) as count FROM blocks')
      .get() as { first: number | null; last: number | null; count: number }
    const txCount = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as {
      count: number
    }
    const accountCount = this.db.prepare('SELECT COUNT(*) as count FROM accounts').get() as {
      count: number
    }

    const prior = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('eventCount') as
      | { value: string }
      | undefined
    const totalEventCount = (prior ? Number(prior.value) : 0) + eventCountDelta

    const meta: SqliteMeta = {
      firstBlock: blockRange.first !== null ? String(blockRange.first) : '0',
      lastBlock: blockRange.last !== null ? String(blockRange.last) : '0',
      blockCount: String(blockRange.count),
      txCount: String(txCount.count),
      addressCount: String(accountCount.count),
      eventCount: String(totalEventCount),
    }

    const insert = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    this.runInTransaction(() => {
      for (const [key, value] of Object.entries(meta)) {
        insert.run(key, value)
      }
    })

    return meta
  }

  /**
   * Sync SQLite database to Swarm with proper Merkle tree structure.
   *
   * Builds a content-addressed Merkle tree where:
   * - Leaf chunks: 4KB database pages with proper span
   * - Intermediate chunks: contain 32-byte refs with cumulative spans
   * - Root reference: enables Swarm Range requests for any byte offset
   *
   * This replaces the JSON page table approach which didn't support Range requests.
   */
  async sync(bee: Bee, options: SyncOptions): Promise<SyncResult> {
    const log = options.onProgress ?? this.log

    // Force SQLite to flush any WAL to main file
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

    // Read entire database file
    const dbBuffer = await readFile(this.dbPath)
    const totalPages = Math.ceil(dbBuffer.length / PAGE_SIZE)
    log(`uploading ${totalPages} pages (${(dbBuffer.length / 1024 / 1024).toFixed(2)} MB)...`)

    // Create a tag for chunk uploads (required to avoid hanging on nodes
    // without peers). Gateways typically don't expose /tags — if createTag
    // fails, fall back to uploading with `deferred=false` and no tag header.
    let tagUid: number | null = null
    try {
      const tag = await bee.createTag()
      tagUid = tag.uid
      log(`created tag ${tagUid}`)
    } catch (err) {
      log(
        `createTag failed (${(err as Error).message}); uploading with deferred=false and no tag header`,
      )
    }

    // Split into 4KB chunks and create content-addressed chunks
    const leafChunks: ChunkWithSpan[] = []
    for (let i = 0; i < dbBuffer.length; i += PAGE_SIZE) {
      const pageData = dbBuffer.subarray(i, Math.min(i + PAGE_SIZE, dbBuffer.length))
      const chunk = this.makeContentAddressedChunkWithSpan(pageData)
      leafChunks.push(chunk)
    }

    // Upload all leaf chunks using bee-js
    log(`uploading ${leafChunks.length} leaf chunks...`)
    for (let i = 0; i < leafChunks.length; i++) {
      const chunk = leafChunks[i]
      await withTimeout(
        bee.uploadChunk(options.batchId, chunk.data, chunkUploadOptions(tagUid)),
        30_000,
        `page ${i}`,
      )

      // Progress every 100 pages
      if ((i + 1) % 100 === 0 || i + 1 === leafChunks.length) {
        log(`uploaded ${i + 1}/${leafChunks.length} pages`)
      }
    }

    // Build Merkle tree with intermediate chunks
    log('building Merkle tree...')
    const rootRef = await this.buildMerkleTree(bee, options.batchId, leafChunks, log, tagUid)

    log(`upload complete: ${rootRef}`)

    return {
      dbRef: rootRef,
      totalPages,
      pagesUploaded: totalPages,
      pagesSkipped: 0,
      tagUid,
    }
  }

  /**
   * Get statistics about the current index.
   */
  getStats(): {
    blockCount: number
    txCount: number
    accountCount: number
    balanceBlockCount: number
    dbSizeBytes: number
  } {
    const blockCount = this.db.prepare('SELECT COUNT(*) as count FROM blocks').get() as {
      count: number
    }
    const txCount = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as {
      count: number
    }
    const accountCount = this.db.prepare('SELECT COUNT(*) as count FROM accounts').get() as {
      count: number
    }
    const balanceBlockCount = this.db
      .prepare('SELECT COUNT(*) as count FROM balance_blocks')
      .get() as {
      count: number
    }

    // Get file size
    const { page_count: pageCount } = this.db.prepare('PRAGMA page_count').get() as {
      page_count: number
    }
    const { page_size: pageSize } = this.db.prepare('PRAGMA page_size').get() as {
      page_size: number
    }

    return {
      blockCount: blockCount.count,
      txCount: txCount.count,
      accountCount: accountCount.count,
      balanceBlockCount: balanceBlockCount.count,
      dbSizeBytes: pageCount * pageSize,
    }
  }

  /**
   * Compact the database (VACUUM).
   */
  vacuum(): void {
    this.db.exec('VACUUM')
  }

  /**
   * Close the database connections.
   */
  close(): void {
    this.db.close()
  }
}

// ---------- Upload Options Helper ----------

/**
 * Build bee-js chunk upload options from an optional tag uid. When no tag is
 * available (gateway without /tags), force `deferred=false` so Bee pushes the
 * chunk synchronously instead of queueing it under an untracked tag.
 */
function chunkUploadOptions(tagUid: number | null): { tag: number } | { deferred: false } {
  return tagUid === null ? { deferred: false } : { tag: tagUid }
}

// ---------- Timeout Helper ----------

/**
 * Wrap a promise with a timeout. Rejects if the promise doesn't resolve within ms.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${msg}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId!))
}

// ---------- Convenience Function ----------

/**
 * Create and open a SQLite indexer.
 */
export function openSqliteIndexer(options: SqliteIndexerOptions): SqliteIndexer {
  return new SqliteIndexer(options)
}

// ---------- Balance-events types + readers ----------

const textEncoder = new TextEncoder()

interface BalanceEvent {
  block: string
  addr: string
  pre: string
  post: string
}

interface AccountRecord {
  addr: string
  balance: string
  eventCount: number
  events: { block: string; pre: string; post: string }[]
}

interface BlockEventsRecord {
  block: string
  events: { addr: string; pre: string; post: string }[]
}

async function* readBalanceEventsNdjson(path: string): AsyncGenerator<BalanceEvent> {
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as BalanceEvent
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let nextIndex = 0
  let done = 0
  const total = items.length

  const runOne = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= total) return
      await worker(items[i], i)
      done++
      if (onProgress && done % 500 === 0) onProgress(done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runOne))
  if (onProgress) onProgress(done, total)
}
