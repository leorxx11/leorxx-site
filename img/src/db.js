// SQLite 索引。图片本体在 R2，这里只存元信息、通行密钥和会话
// 丢了可以用 cli.js reindex 从 R2 重建图片部分

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;

  CREATE TABLE IF NOT EXISTS images (
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL UNIQUE,
    thumb_key     TEXT,
    name          TEXT NOT NULL DEFAULT '',
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    original_size INTEGER,
    width         INTEGER,
    height        INTEGER,
    source_hash   TEXT,
    created_at    INTEGER NOT NULL,
    deleted_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS images_by_time ON images (created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS images_by_thumb ON images (thumb_key);
  CREATE UNIQUE INDEX IF NOT EXISTS images_by_hash ON images (source_hash)
    WHERE source_hash IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS passkeys (
    id           TEXT PRIMARY KEY,
    public_key   BLOB NOT NULL,
    counter      INTEGER NOT NULL,
    transports   TEXT,
    name         TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  );
`);

export function getMeta(k) {
  return db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
}

export function setMeta(k, v) {
  if (v === null) db.prepare('DELETE FROM meta WHERE k = ?').run(k);
  else db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
