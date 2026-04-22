// Hybrid SQLite + Swarm indexer with page-level deduplication.
//
// Instead of Mantaray manifests, stores block indexes in a SQLite database.
// The database is kept on local disk, but synced to Swarm with incremental
// page-level uploads - only changed 4KB pages are uploaded.
//
// Schema:
//   blocks(number INTEGER PRIMARY KEY, hash BLOB, swarm_ref BLOB)
//   transactions(tx_hash BLOB PRIMARY KEY, block_number INTEGER)
//
// Lookup flow (client):
//   1. Fetch page table from Swarm (small JSON mapping page# → ref)
//   2. Use sql.js-httpvfs with Swarm range requests to query SQLite
//   3. Get swarm_ref for block, fetch block bundle directly

import * as crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'
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
  concurrency?: number
  onProgress?: (msg: string) => void
}

export interface SyncResult {
  pageTableRef: string // Swarm reference to the page table
  totalPages: number
  pagesUploaded: number
  pagesSkipped: number
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

// Page table entry: maps page number to Swarm reference
export interface PageTableEntry {
  page: number
  ref: string // hex-encoded 32-byte BMT hash
}

// ---------- BMT Hash Implementation ----------

// Compute BMT hash for a 4KB chunk (matching Swarm's algorithm)
function computeBmtHash(data: Uint8Array): Uint8Array {
  // Pad to 4096 bytes if needed
  const padded = new Uint8Array(PAGE_SIZE)
  padded.set(data.slice(0, Math.min(data.length, PAGE_SIZE)))

  // Build BMT by hashing pairs of 32-byte segments
  let currentLevel = partition(padded, SEGMENT_SIZE)

  while (currentLevel.length > 1) {
    const nextLevel: Uint8Array[] = []
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]
      const right = currentLevel[i + 1]
      const combined = concatBytes(left, right)
      nextLevel.push(keccak256(combined))
    }
    currentLevel = nextLevel
  }

  // Final hash: span (8 bytes) + root hash
  const span = new Uint8Array(8)
  const dataView = new DataView(span.buffer)
  dataView.setBigUint64(0, BigInt(data.length), true) // little-endian

  return keccak256(concatBytes(span, currentLevel[0]))
}

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
  private db: Database.Database
  private bmtCacheDb: Database.Database
  private dbPath: string
  private log: (msg: string) => void

  // Cached prepared statements for BMT cache operations
  private bmtCacheLookupStmt!: Database.Statement
  private bmtCacheStoreStmt!: Database.Statement

  // Track which pages have been uploaded (by BMT hash)
  // Map: bmtHashHex → swarmRef (hex)
  private uploadedPages = new Map<string, string>()

  // Track last synced content hash for each page (for fast change detection)
  // Map: pageNumber → SHA256 content hash (32 bytes as Buffer)
  private lastSyncedContentHashes = new Map<number, Buffer>()

  constructor(options: SqliteIndexerOptions) {
    this.dbPath = options.dbPath
    this.log = options.onProgress ?? console.log
    this.db = new Database(this.dbPath)
    this.initSchema()

    // Open BMT cache database (stores content hash → BMT hash mappings)
    const cachePath = this.dbPath.replace(/\.sqlite$/, '.bmt-cache.sqlite')
    this.bmtCacheDb = new Database(cachePath)
    this.initBmtCache()
  }

  private initSchema(): void {
    // Set page size to 4096 (must be done before creating tables)
    this.db.pragma('page_size = 4096')
    // WAL mode for better write performance with frequent commits
    this.db.pragma('journal_mode = WAL')

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
    `)
  }

  private initBmtCache(): void {
    // WAL mode for faster writes and fast close (avoids journal flush)
    this.bmtCacheDb.pragma('journal_mode = WAL')
    this.bmtCacheDb.exec(`
      CREATE TABLE IF NOT EXISTS bmt_cache (
        content_hash BLOB PRIMARY KEY,
        bmt_hash BLOB NOT NULL
      );

      -- Track uploaded pages: BMT hash → Swarm reference
      CREATE TABLE IF NOT EXISTS uploaded_pages (
        bmt_hash BLOB PRIMARY KEY,
        swarm_ref TEXT NOT NULL
      );

      -- Track last synced content hash per page number
      CREATE TABLE IF NOT EXISTS synced_pages (
        page_num INTEGER PRIMARY KEY,
        content_hash BLOB NOT NULL
      );
    `)
    // Cache prepared statements (avoids SQL parsing on each lookup/store)
    this.bmtCacheLookupStmt = this.bmtCacheDb.prepare(
      'SELECT bmt_hash FROM bmt_cache WHERE content_hash = ?',
    )
    this.bmtCacheStoreStmt = this.bmtCacheDb.prepare(
      'INSERT OR IGNORE INTO bmt_cache (content_hash, bmt_hash) VALUES (?, ?)',
    )

    // Load existing uploaded pages into memory map
    const uploadedRows = this.bmtCacheDb
      .prepare('SELECT bmt_hash, swarm_ref FROM uploaded_pages')
      .all() as Array<{ bmt_hash: Buffer; swarm_ref: string }>
    for (const row of uploadedRows) {
      this.uploadedPages.set(bytesToHex(new Uint8Array(row.bmt_hash)), row.swarm_ref)
    }

    // Load existing synced page hashes into memory map
    const syncedRows = this.bmtCacheDb
      .prepare('SELECT page_num, content_hash FROM synced_pages')
      .all() as Array<{ page_num: number; content_hash: Buffer }>
    for (const row of syncedRows) {
      this.lastSyncedContentHashes.set(row.page_num, row.content_hash)
    }

    if (this.uploadedPages.size > 0 || this.lastSyncedContentHashes.size > 0) {
      this.log(
        `loaded state: ${this.uploadedPages.size} uploaded pages, ${this.lastSyncedContentHashes.size} synced pages`,
      )
    }
  }

  /**
   * Lookup BMT hash in cache by content hash.
   */
  private lookupBmtHash(contentHash: Buffer): Uint8Array | null {
    const row = this.bmtCacheLookupStmt.get(contentHash) as { bmt_hash: Buffer } | undefined
    return row ? new Uint8Array(row.bmt_hash) : null
  }

  /**
   * Store BMT hash in cache keyed by content hash.
   */
  private storeBmtHash(contentHash: Buffer, bmtHash: Uint8Array): void {
    this.bmtCacheStoreStmt.run(contentHash, bmtHash)
  }

  /**
   * Compute fast SHA256 hash for change detection.
   */
  private computeContentHash(data: Uint8Array): Buffer {
    return crypto.createHash('sha256').update(data).digest()
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

    this.db.transaction(() => {
      insertBlock.run(blockNumber, blockHash, swarmRef)
      for (const txHash of txHashes) {
        insertTx.run(txHash, blockNumber)
      }
    })()
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
      const uploadResult = await bee.uploadData(options.batchId, bundleBytes)
      const swarmRef = hexToBytes(uploadResult.reference)

      // Add to SQLite index (committed immediately for crash recovery)
      const blockHash = hexToBytes(block.hash)
      const txHashes = block.txHashes.map(hexToBytes)

      this.db.transaction(() => {
        insertBlock.run(blockNumber, blockHash, swarmRef)
        for (const txHash of txHashes) {
          insertTx.run(txHash, blockNumber)
        }
        txHashesAdded += txHashes.length
      })()

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
    const uploadResult = await bee.uploadData(batchId, bundleBytes)
    const swarmRef = hexToBytes(uploadResult.reference)

    // Add to SQLite index
    const blockHash = hexToBytes(block.hash)
    const txHashes = block.txHashes.map(hexToBytes)

    const insertBlock = this.db.prepare(
      'INSERT OR REPLACE INTO blocks (number, hash, swarm_ref) VALUES (?, ?, ?)',
    )
    const insertTx = this.db.prepare(
      'INSERT OR REPLACE INTO transactions (tx_hash, block_number) VALUES (?, ?)',
    )

    this.db.transaction(() => {
      insertBlock.run(blockNumber, blockHash, swarmRef)
      for (const txHash of txHashes) {
        insertTx.run(txHash, blockNumber)
      }
    })()

    return { blockNumber, skipped: false, txHashesAdded: txHashes.length }
  }

  /**
   * Sync SQLite database to Swarm, uploading only changed pages.
   *
   * Returns a reference to the page table, which maps page numbers to
   * Swarm chunk references. Clients can use this to fetch specific pages
   * via range requests.
   */
  async sync(bee: Bee, options: SyncOptions): Promise<SyncResult> {
    const log = options.onProgress ?? this.log
    const concurrency = options.concurrency ?? 32

    // Force SQLite to flush any WAL to main file
    this.db.pragma('wal_checkpoint(TRUNCATE)')

    // Read database file page by page
    const fd = await open(this.dbPath, 'r')
    const stats = await fd.stat()
    const totalPages = Math.ceil(stats.size / PAGE_SIZE)

    log(`scanning ${totalPages} pages for changes...`)

    // Collect pages that need uploading
    const pagesToUpload: Array<{
      pageNum: number
      data: Buffer
      contentHash: Buffer
      bmtHash: Uint8Array
    }> = []
    const newPageTable: PageTableEntry[] = []

    // Allocate buffer once outside loop to avoid GC pressure
    const buffer = Buffer.alloc(PAGE_SIZE)

    // Diagnostic counters
    let unchangedPages = 0
    let changedPages = 0
    let bmtCacheHits = 0
    let bmtCacheMisses = 0

    for (let pageNum = 0; pageNum < totalPages; pageNum++) {
      // Progress every 5000 pages
      if (pageNum > 0 && pageNum % 5000 === 0) {
        log(`  scanned ${pageNum}/${totalPages}...`)
      }
      const { bytesRead } = await fd.read(buffer, 0, PAGE_SIZE, pageNum * PAGE_SIZE)

      // Handle last page which might be smaller (subarray avoids copy)
      const pageData = buffer.subarray(0, bytesRead)

      // Fast content hash (single SHA256) for change detection
      const contentHash = this.computeContentHash(pageData)

      // Check if page changed since last sync
      const lastContentHash = this.lastSyncedContentHashes.get(pageNum)

      if (lastContentHash && contentHash.equals(lastContentHash)) {
        // Page unchanged - use existing reference from uploadedPages
        // We need to lookup by BMT hash, which we can get from cache
        const cachedBmtHash = this.lookupBmtHash(contentHash)
        if (cachedBmtHash) {
          bmtCacheHits++
          const bmtHashHex = bytesToHex(cachedBmtHash)
          const existingRef = this.uploadedPages.get(bmtHashHex)
          if (existingRef) {
            unchangedPages++
            newPageTable.push({ page: pageNum, ref: existingRef })
            continue
          }
        }
        // Fallthrough: if we somehow lost the mapping, recompute
      }

      // Page is new or changed - get or compute BMT hash
      changedPages++
      let bmtHash = this.lookupBmtHash(contentHash)
      if (bmtHash) {
        bmtCacheHits++
      } else {
        // Not in cache - compute BMT hash (expensive)
        bmtCacheMisses++
        bmtHash = computeBmtHash(pageData)
        this.storeBmtHash(contentHash, bmtHash)
      }
      const bmtHashHex = bytesToHex(bmtHash)

      // Check if this content was already uploaded (deduplication)
      const existingRef = this.uploadedPages.get(bmtHashHex)
      if (existingRef) {
        // Content already uploaded, just update table and tracking
        newPageTable.push({ page: pageNum, ref: existingRef })
        this.lastSyncedContentHashes.set(pageNum, contentHash)
        // Persist synced page to SQLite
        this.bmtCacheDb
          .prepare('INSERT OR REPLACE INTO synced_pages (page_num, content_hash) VALUES (?, ?)')
          .run(pageNum, contentHash)
      } else {
        // Need to upload this page (copy data since buffer is reused)
        pagesToUpload.push({
          pageNum,
          data: Buffer.from(pageData),
          contentHash,
          bmtHash,
        })
      }
    }

    await fd.close()

    log(`scan complete: ${unchangedPages} unchanged, ${changedPages} changed`)
    log(`BMT cache: ${bmtCacheHits} hits, ${bmtCacheMisses} misses`)

    log(
      `uploading ${pagesToUpload.length} changed pages (${totalPages - pagesToUpload.length} unchanged)...`,
    )

    // Upload changed pages with concurrency control
    let pagesUploaded = 0
    const uploadQueue = createUploadQueue(concurrency, pagesToUpload.length, log)

    // Prepare statements for persisting state (outside the concurrent uploads)
    const insertUploadedPage = this.bmtCacheDb.prepare(
      'INSERT OR REPLACE INTO uploaded_pages (bmt_hash, swarm_ref) VALUES (?, ?)',
    )
    const insertSyncedPage = this.bmtCacheDb.prepare(
      'INSERT OR REPLACE INTO synced_pages (page_num, content_hash) VALUES (?, ?)',
    )

    await uploadQueue(pagesToUpload, async (page) => {
      // Build chunk data: span (8 bytes) + payload
      const span = new Uint8Array(8)
      const dataView = new DataView(span.buffer)
      dataView.setBigUint64(0, BigInt(page.data.length), true)
      const chunkData = concatBytes(span, page.data)

      // Upload via chunks endpoint
      const result = await bee.uploadData(options.batchId, chunkData)
      const swarmRef = result.reference

      // Track upload by BMT hash (for deduplication)
      const bmtHashHex = bytesToHex(page.bmtHash)
      this.uploadedPages.set(bmtHashHex, swarmRef)
      // Track content hash for fast change detection
      this.lastSyncedContentHashes.set(page.pageNum, page.contentHash)
      newPageTable.push({ page: page.pageNum, ref: swarmRef })

      // Persist to SQLite
      insertUploadedPage.run(page.bmtHash, swarmRef)
      insertSyncedPage.run(page.pageNum, page.contentHash)

      pagesUploaded++
    })

    // Sort page table by page number
    newPageTable.sort((a, b) => a.page - b.page)

    // Upload page table as JSON
    log(`uploading page table (${newPageTable.length} entries)...`)
    const pageTableJson = JSON.stringify(newPageTable)
    const pageTableResult = await bee.uploadData(
      options.batchId,
      new TextEncoder().encode(pageTableJson),
    )

    log(`sync complete: ${pagesUploaded} pages uploaded, ${totalPages - pagesUploaded} skipped`)

    return {
      pageTableRef: pageTableResult.reference,
      totalPages,
      pagesUploaded,
      pagesSkipped: totalPages - pagesUploaded,
    }
  }

  /**
   * Get statistics about the current index.
   */
  getStats(): { blockCount: number; txCount: number; dbSizeBytes: number } {
    const blockCount = this.db.prepare('SELECT COUNT(*) as count FROM blocks').get() as {
      count: number
    }
    const txCount = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as {
      count: number
    }

    // Get file size
    const pageCountResult = this.db.pragma('page_count') as Array<{ page_count: number }>
    const pageSizeResult = this.db.pragma('page_size') as Array<{ page_size: number }>
    const pageCount = pageCountResult[0].page_count
    const pageSize = pageSizeResult[0].page_size

    return {
      blockCount: blockCount.count,
      txCount: txCount.count,
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
    this.bmtCacheDb.close()
  }
}

// ---------- Upload Queue ----------

function createUploadQueue(
  maxConcurrent: number,
  total: number,
  log: (msg: string) => void,
): <T>(items: T[], process: (item: T) => Promise<void>) => Promise<void> {
  return async <T>(items: T[], process: (item: T) => Promise<void>): Promise<void> => {
    let inFlight = 0
    let completed = 0
    const waiting: Array<{ resolve: () => void }> = []

    const processItem = async (item: T): Promise<void> => {
      while (inFlight >= maxConcurrent) {
        await new Promise<void>((resolve) => waiting.push({ resolve }))
      }

      inFlight++
      try {
        await process(item)
        completed++
        if (completed % 100 === 0 || completed === total) {
          log(`pages: ${completed}/${total}`)
        }
      } finally {
        inFlight--
        const next = waiting.shift()
        if (next) next.resolve()
      }
    }

    await Promise.all(items.map(processItem))
  }
}

// ---------- Convenience Function ----------

/**
 * Create and open a SQLite indexer.
 */
export function openSqliteIndexer(options: SqliteIndexerOptions): SqliteIndexer {
  return new SqliteIndexer(options)
}
