// SQLite-backed upload-response cache.
//
// Bee uploads are content-addressed — POSTing the same bytes with the same
// batch returns the same Swarm reference every time. We key cached responses
// by (sha256(body), batch_id, path) so repeated uploads during development
// short-circuit without hitting the upstream node.
//
// Only 2xx responses are stored. Non-success responses are surfaced as-is so
// the caller can fix the underlying problem and retry.
//
// Uses the built-in `node:sqlite` module (Node 22+ experimental, 24+ stable)
// so there is no native-module compile step.

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

const SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'date',
  'content-length',
])

export interface CachedResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export class UploadCache {
  private readonly db: DatabaseSync
  private readonly lookupStmt: StatementSync
  private readonly insertStmt: StatementSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upload_cache (
        body_hash   BLOB    NOT NULL,
        batch_id    TEXT    NOT NULL,
        path        TEXT    NOT NULL,
        status      INTEGER NOT NULL,
        headers     TEXT    NOT NULL,
        body        BLOB    NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (body_hash, batch_id, path)
      )
    `)
    this.lookupStmt = this.db.prepare(
      'SELECT status, headers, body FROM upload_cache WHERE body_hash=? AND batch_id=? AND path=?',
    )
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO upload_cache
         (body_hash, batch_id, path, status, headers, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
  }

  static hashBody(body: Buffer): Buffer {
    return createHash('sha256').update(body).digest()
  }

  /**
   * Keep only headers that are safe to replay. Drops hop-by-hop headers
   * (Connection, Keep-Alive, Transfer-Encoding), Date (stale), and
   * Content-Length (we recompute from the stored body).
   */
  static filterHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue
      if (SKIP_HEADERS.has(k.toLowerCase())) continue
      out[k] = Array.isArray(v) ? v.join(', ') : v
    }
    return out
  }

  lookup(hash: Buffer, batchId: string, path: string): CachedResponse | null {
    const row = this.lookupStmt.get(hash, batchId, path) as
      | { status: number; headers: string; body: Uint8Array }
      | undefined
    if (!row) return null
    return {
      status: row.status,
      headers: JSON.parse(row.headers) as Record<string, string>,
      body: Buffer.from(row.body),
    }
  }

  store(hash: Buffer, batchId: string, path: string, resp: CachedResponse): void {
    this.insertStmt.run(
      hash,
      batchId,
      path,
      resp.status,
      JSON.stringify(resp.headers),
      resp.body,
      Date.now(),
    )
  }

  close(): void {
    this.db.close()
  }
}

// Caches GET responses for content-addressed endpoints (/bytes/{ref},
// /chunks/{ref}). Keyed by path only — same ref always returns same bytes.
export class DownloadCache {
  private readonly db: DatabaseSync
  private readonly lookupStmt: StatementSync
  private readonly insertStmt: StatementSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_cache (
        path        TEXT    NOT NULL PRIMARY KEY,
        status      INTEGER NOT NULL,
        headers     TEXT    NOT NULL,
        body        BLOB    NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `)
    this.lookupStmt = this.db.prepare(
      'SELECT status, headers, body FROM download_cache WHERE path=?',
    )
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO download_cache
         (path, status, headers, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
  }

  lookup(path: string): CachedResponse | null {
    const row = this.lookupStmt.get(path) as
      | { status: number; headers: string; body: Uint8Array }
      | undefined
    if (!row) return null
    return {
      status: row.status,
      headers: JSON.parse(row.headers) as Record<string, string>,
      body: Buffer.from(row.body),
    }
  }

  store(path: string, resp: CachedResponse): void {
    this.insertStmt.run(path, resp.status, JSON.stringify(resp.headers), resp.body, Date.now())
  }

  close(): void {
    this.db.close()
  }
}
