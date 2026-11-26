/**
 * SQLite storage. One account, one session: the schema is deliberately small.
 *
 * `enc_session` and `enc_key` are AES-256-GCM blobs (see `crypto.ts`), never
 * the plaintext session string or LLM key.
 *
 * `pending` mirrors the in-memory login attempt. It is written for TTL and
 * bookkeeping, and dropped on boot: a pending login only works on the client
 * instance that owns the auth key, so a restarted backend cannot continue it.
 *
 * `future_token` outlives `session` on purpose: the whole point of a future
 * auth token is logging in again without the code after a logout.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SettingsPayload } from './contract.js'

export interface SessionRow {
  id: string
  user_id: string
  first_name: string
  username: string
  enc_session: string
  test_dc: number
  created_at: number
}

export interface PendingRow {
  id: string
  phone: string
  phone_code_hash: string | null
  step: string
  resend_at: number
  expires_at: number
  created_at: number
}

export interface SettingsRow {
  lang: string
  quick_reply: string
  tone: string
  selected_chats: string | null
  llm_model: string
}

export interface CachedReply {
  summary: string
  replies: string[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  enc_session TEXT NOT NULL,
  test_dc INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_token (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_token_session ON auth_token(session_id);

CREATE TABLE IF NOT EXISTS settings (
  session_id TEXT PRIMARY KEY,
  lang TEXT NOT NULL DEFAULT 'en',
  quick_reply TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  selected_chats TEXT,
  llm_model TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enc_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS future_token (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL DEFAULT '',
  phone_code_hash TEXT,
  step TEXT NOT NULL,
  resend_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  replies TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export class Db {
  private readonly db: DatabaseSync
  private closed = false

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true })
    }
    this.db = new DatabaseSync(filename)
    if (filename !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
    }
    this.db.exec(SCHEMA)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // ---- session -----------------------------------------------------------

  /** Single account: saving a session replaces any previous one. */
  saveSession(row: SessionRow): void {
    this.transaction(() => {
      const others = this.db.prepare('SELECT id FROM session WHERE id <> ?').all(row.id) as Array<{
        id: string
      }>
      for (const other of others) {
        this.db.prepare('DELETE FROM auth_token WHERE session_id = ?').run(other.id)
      }
      this.db.prepare('DELETE FROM session WHERE id <> ?').run(row.id)
      if (others.length > 0) {
        // Replacing the account must not leave another login's message text in
        // the LLM cache; `deleteSession` makes the same promise.
        this.db.exec('DELETE FROM llm_cache')
      }
      this.db
        .prepare(
          `INSERT INTO session (id, user_id, first_name, username, enc_session, test_dc, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = excluded.user_id,
             first_name = excluded.first_name,
             username = excluded.username,
             enc_session = excluded.enc_session,
             test_dc = excluded.test_dc`,
        )
        .run(
          row.id,
          row.user_id,
          row.first_name,
          row.username,
          row.enc_session,
          row.test_dc,
          row.created_at,
        )
    })
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id)
    return (row as unknown as SessionRow | undefined) ?? null
  }

  deleteSession(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM auth_token WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM settings WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM session WHERE id = ?').run(id)
      // The cache holds message-derived text; it must not outlive the account
      // and be served to a different login.
      this.db.exec('DELETE FROM llm_cache')
    })
  }

  // ---- bearer tokens -----------------------------------------------------

  putAuthToken(tokenHash: string, sessionId: string, now: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO auth_token (token_hash, session_id, created_at) VALUES (?, ?, ?)')
      .run(tokenHash, sessionId, now)
  }

  /** The session a bearer token belongs to, or null for an unknown token. */
  sessionIdByTokenHash(tokenHash: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM auth_token WHERE token_hash = ?')
      .get(tokenHash) as unknown as { session_id: string } | undefined
    return row?.session_id ?? null
  }

  deleteAuthToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_token WHERE token_hash = ?').run(tokenHash)
  }

  // ---- pending login -----------------------------------------------------

  putPending(row: PendingRow): void {
    this.db
      .prepare(
        `INSERT INTO pending (id, phone, phone_code_hash, step, resend_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           phone = excluded.phone,
           phone_code_hash = excluded.phone_code_hash,
           step = excluded.step,
           resend_at = excluded.resend_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        row.id,
        row.phone,
        row.phone_code_hash,
        row.step,
        row.resend_at,
        row.expires_at,
        row.created_at,
      )
  }

  getPending(id: string): PendingRow | null {
    const row = this.db.prepare('SELECT * FROM pending WHERE id = ?').get(id)
    return (row as unknown as PendingRow | undefined) ?? null
  }

  deletePending(id: string): void {
    this.db.prepare('DELETE FROM pending WHERE id = ?').run(id)
  }

  deleteAllPending(): void {
    this.db.prepare('DELETE FROM pending').run()
  }

  countPending(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pending').get() as unknown as {
      n: number
    }
    return Number(row.n)
  }

  // ---- settings ----------------------------------------------------------

  putSettings(sessionId: string, payload: SettingsPayload, now: number): void {
    this.db
      .prepare(
        `INSERT INTO settings (session_id, lang, quick_reply, tone, selected_chats, llm_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           lang = excluded.lang,
           quick_reply = excluded.quick_reply,
           tone = excluded.tone,
           selected_chats = excluded.selected_chats,
           llm_model = excluded.llm_model,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionId,
        payload.lang,
        payload.quickReply,
        payload.tone,
        payload.selectedChats === null ? null : JSON.stringify(payload.selectedChats),
        payload.llmModel,
        now,
      )
  }

  /** Settings the LLM needs: tone, language fallback, model. */
  getSettings(sessionId: string): SettingsRow | null {
    const row = this.db
      .prepare('SELECT lang, quick_reply, tone, selected_chats, llm_model FROM settings WHERE session_id = ?')
      .get(sessionId)
    return (row as unknown as SettingsRow | undefined) ?? null
  }

  // ---- LLM key -----------------------------------------------------------

  putLlmKey(encrypted: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO llm_key (id, enc_key, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enc_key = excluded.enc_key, updated_at = excluded.updated_at`,
      )
      .run(encrypted, now)
  }

  /** The AES-GCM blob, never the plaintext key. */
  getLlmKey(): string | null {
    const row = this.db.prepare('SELECT enc_key FROM llm_key WHERE id = 1').get() as unknown as
      | { enc_key: string }
      | undefined
    return row?.enc_key ?? null
  }

  hasLlmKey(): boolean {
    const row = this.db.prepare('SELECT 1 AS one FROM llm_key WHERE id = 1').get()
    return row !== undefined
  }

  // ---- LLM reply cache ---------------------------------------------------

  getLlmCache(cacheKey: string, minCreatedAt: number): CachedReply | null {
    const row = this.db
      .prepare('SELECT summary, replies, created_at FROM llm_cache WHERE cache_key = ?')
      .get(cacheKey) as unknown as
      | { summary: string; replies: string; created_at: number }
      | undefined
    if (!row || row.created_at < minCreatedAt) return null
    try {
      const replies = JSON.parse(row.replies) as unknown
      if (!Array.isArray(replies) || replies.some((item) => typeof item !== 'string')) return null
      return { summary: row.summary, replies: replies as string[] }
    } catch {
      return null
    }
  }

  putLlmCache(cacheKey: string, summary: string, replies: string[], now: number): void {
    this.db
      .prepare(
        `INSERT INTO llm_cache (cache_key, summary, replies, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           summary = excluded.summary,
           replies = excluded.replies,
           created_at = excluded.created_at`,
      )
      .run(cacheKey, summary, JSON.stringify(replies), now)
  }

  deleteExpiredLlmCache(before: number): void {
    this.db.prepare('DELETE FROM llm_cache WHERE created_at < ?').run(before)
  }

  // ---- future auth tokens ------------------------------------------------

  addFutureToken(token: string, sessionId: string, now: number): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO future_token (token, session_id, created_at) VALUES (?, ?, ?)')
        .run(token, sessionId, now)
      // The server keeps at most 20; old ones are evicted.
      this.db
        .prepare(
          `DELETE FROM future_token WHERE token NOT IN (
             SELECT token FROM future_token ORDER BY created_at DESC, rowid DESC LIMIT 20
           )`,
        )
        .run()
    })
  }

  futureTokens(limit = 20): string[] {
    const rows = this.db
      .prepare('SELECT token FROM future_token ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as unknown as Array<{ token: string }>
    return rows.map((row) => row.token)
  }

  // ---- whole-database cleanup -------------------------------------------

  wipeAll(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM auth_token')
      this.db.exec('DELETE FROM settings')
      this.db.exec('DELETE FROM llm_key')
      this.db.exec('DELETE FROM llm_cache')
      this.db.exec('DELETE FROM future_token')
      this.db.exec('DELETE FROM pending')
      this.db.exec('DELETE FROM session')
    })
    // Rewrites the file so a deleted ciphertext is not left in free pages.
    this.db.exec('VACUUM')
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the transaction is already gone */
      }
      throw err
    }
  }
}
