// SQLite 索引。文件本体在 R2，这里存元信息、画布布局、通行密钥、会话和 API 令牌
// 丢了可以用 src/cli.js reindex 从 R2 重建文件部分

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
    deleted_at    INTEGER,
    x             REAL,
    y             REAL,
    w             REAL,
    rot           REAL NOT NULL DEFAULT 0,
    z             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS images_by_time ON images (created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS images_by_thumb ON images (thumb_key);
  CREATE UNIQUE INDEX IF NOT EXISTS images_by_hash ON images (source_hash)
    WHERE source_hash IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  );

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

  -- scopes：upload / read，逗号分隔
  CREATE TABLE IF NOT EXISTS api_tokens (
    token_hash   TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT 'upload',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );
`);

// 老库补列：令牌权限
if (!db.prepare('PRAGMA table_info(api_tokens)').all().some((c) => c.name === 'scopes')) {
  db.exec("ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'upload'");
}

// 老库补列：桌面画布坐标、宽度、倾角、层级
// （早期版本的 on_desk 列如果还在，已经不再使用：没进回收站的文件都在画布上）
const imageCols = new Set(db.prepare('PRAGMA table_info(images)').all().map((c) => c.name));
for (const [col, def] of [
  ['x', 'REAL'],
  ['y', 'REAL'],
  ['w', 'REAL'],
  ['rot', 'REAL NOT NULL DEFAULT 0'],
  ['z', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!imageCols.has(col)) db.exec(`ALTER TABLE images ADD COLUMN ${col} ${def}`);
}

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
