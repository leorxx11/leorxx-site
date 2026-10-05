// 图片：上传、列表、废纸篓、出图、从 R2 重建索引

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { db, tx } from './db.js';
import { requireSession } from './auth.js';
import { HttpError, readBody, readJson, send } from './http.js';
import { deleteObject, getObject, headMeta, listAll, putObject } from './r2.js';

const DAY = 864e5;
// 按北京时间分月
const MONTH_SQL = `strftime('%Y-%m', created_at / 1000, 'unixepoch', '+8 hours')`;

// 按文件头判断类型，不信任客户端给的 Content-Type；SVG 可以带脚本，不收
function sniff(b) {
  if (b.length < 12) return null;
  const ascii = (s, e) => b.toString('latin1', s, e);
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { type: 'image/png', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (ascii(0, 4) === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return { type: 'image/avif', ext: 'avif' };
  return null;
}

const thumbKeyFor = (key) => `thumbs/${key.replace(/\.[^./]+$/, '')}.webp`;
const validKey = (key) => /^[\w\-./]{1,200}$/.test(key) && !key.includes('..') && !key.startsWith('/');
const intOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function toApi(row) {
  return {
    id: row.id,
    url: `/i/${row.key}`,
    thumb: `/i/${row.thumb_key || row.key}`,
    name: row.name,
    mime: row.mime,
    size: row.size,
    originalSize: row.original_size,
    width: row.width,
    height: row.height,
    month: row.month,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    purgeAt: row.deleted_at ? row.deleted_at + config.trashDays * DAY : null,
  };
}

const SELECT = `SELECT *, ${MONTH_SQL} AS month FROM images`;
const getById = (id) => db.prepare(`${SELECT} WHERE id = ?`).get(id);
const getActiveByHash = (hash) => db.prepare(`${SELECT} WHERE source_hash = ? AND deleted_at IS NULL`).get(hash);

function parseIds(body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length > 500) throw new HttpError(400, '一次最多 500 张');
  return ids;
}

// ---------- 上传 ----------
export async function handleUpload(req, res) {
  requireSession(req, res);
  const sourceHash = /^[0-9a-f]{64}$/.test(req.headers['x-source-hash'] || '') ? req.headers['x-source-hash'] : null;
  if (sourceHash) {
    const dup = getActiveByHash(sourceHash);
    if (dup) { req.resume(); return send(res, 200, { image: toApi(dup), duplicate: true }); }
  }

  const buf = await readBody(req, config.maxBytes);
  const kind = sniff(buf);
  if (!kind) throw new HttpError(415, '只收 PNG、JPEG、GIF、WebP、AVIF');
  const rawName = String(req.headers['x-filename'] || '');
  let name;
  try { name = decodeURIComponent(rawName); } catch { name = rawName; }
  name = name.slice(0, 200);

  const now = Date.now();
  const d = new Date(now + 8 * 3600e3); // 北京时间的年月
  const id = now.toString(36) + randomBytes(3).toString('hex');
  const key = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${id}.${kind.ext}`;
  const width = intOrNull(req.headers['x-width']);
  const height = intOrNull(req.headers['x-height']);
  const originalSize = intOrNull(req.headers['x-original-size']);

  await putObject(key, buf, kind.type, {
    name, width, height, 'original-size': originalSize, 'source-hash': sourceHash, created: now,
  });
  try {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO images (key, name, mime, size, original_size, width, height, source_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, name, kind.type, buf.length, originalSize, width, height, sourceHash, now);
    send(res, 200, { image: toApi(getById(Number(lastInsertRowid))) });
  } catch (err) {
    // 同一张图几乎同时传了两次：保留先到的，删掉刚写进 R2 的这份
    const dup = sourceHash && getActiveByHash(sourceHash);
    if (!dup) throw err;
    await deleteObject(key).catch(() => {});
    send(res, 200, { image: toApi(dup), duplicate: true });
  }
}

export async function handleThumb(req, res, id) {
  requireSession(req, res);
  const row = getById(id);
  if (!row || row.deleted_at) throw new HttpError(404, '没有这张图');
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (sniff(buf)?.type !== 'image/webp') throw new HttpError(415, '缩略图要是 WebP');
  const thumbKey = thumbKeyFor(row.key);
  await putObject(thumbKey, buf, 'image/webp');
  db.prepare('UPDATE images SET thumb_key = ? WHERE id = ?').run(thumbKey, id);
  send(res, 200, { image: toApi(getById(id)) });
}

// ---------- 底片库 ----------
export function handleList(req, res, url) {
  requireSession(req, res);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const where = ['deleted_at IS NULL'];
  const args = [];
  const q = (url.searchParams.get('q') || '').trim();
  if (q) { where.push(`name LIKE ? ESCAPE '\\'`); args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); }
  const month = url.searchParams.get('month') || '';
  if (/^\d{4}-\d{2}$/.test(month)) { where.push(`${MONTH_SQL} = ?`); args.push(month); }
  const cursor = (url.searchParams.get('cursor') || '').match(/^(\d+)-(\d+)$/);
  if (cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    args.push(Number(cursor[1]), Number(cursor[1]), Number(cursor[2]));
  }
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(toApi);
  const last = items.at(-1);
  send(res, 200, { items, nextCursor: more && last ? `${last.createdAt}-${last.id}` : null });
}

export function handleMonths(req, res) {
  requireSession(req, res);
  const rows = db.prepare(`
    SELECT ${MONTH_SQL} AS month, COUNT(*) AS count FROM images
    WHERE deleted_at IS NULL GROUP BY month ORDER BY month DESC`).all();
  send(res, 200, { months: rows });
}

export function handleByHash(req, res, hash) {
  requireSession(req, res);
  const row = /^[0-9a-f]{64}$/.test(hash) ? getActiveByHash(hash) : null;
  send(res, 200, { image: row ? toApi(row) : null });
}

export function handleStats(req, res) {
  requireSession(req, res);
  const active = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM images WHERE deleted_at IS NULL').get();
  const trash = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM images WHERE deleted_at IS NOT NULL').get();
  send(res, 200, { count: active.count, bytes: active.bytes, trashCount: trash.count, trashBytes: trash.bytes, trashDays: config.trashDays });
}

// ---------- 废纸篓 ----------
export async function handleMoveToTrash(req, res) {
  requireSession(req, res);
  const ids = parseIds(await readJson(req));
  const now = Date.now();
  const stmt = db.prepare('UPDATE images SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL');
  const moved = tx(() => ids.reduce((n, id) => n + Number(stmt.run(now, id).changes), 0));
  send(res, 200, { moved });
}

export function handleTrashList(req, res) {
  requireSession(req, res);
  const rows = db.prepare(`${SELECT} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`).all();
  send(res, 200, { items: rows.map(toApi), trashDays: config.trashDays });
}

export async function handleRestore(req, res) {
  requireSession(req, res);
  const ids = parseIds(await readJson(req));
  let restored = 0;
  const conflicts = [];
  for (const id of ids) {
    try {
      restored += Number(db.prepare('UPDATE images SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes);
    } catch {
      conflicts.push(id); // 同一张图后来又传过一次，恢复会重复
    }
  }
  send(res, 200, { restored, conflicts });
}

async function purgeRows(rows) {
  let purged = 0;
  for (const row of rows) {
    await deleteObject(row.key);
    if (row.thumb_key) await deleteObject(row.thumb_key);
    db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
    purged++;
  }
  return purged;
}

export async function handlePurge(req, res) {
  requireSession(req, res);
  const body = await readJson(req);
  const rows = Array.isArray(body.ids)
    ? parseIds(body).map(getById).filter((r) => r?.deleted_at)
    : db.prepare('SELECT * FROM images WHERE deleted_at IS NOT NULL').all();
  send(res, 200, { purged: await purgeRows(rows) });
}

export async function purgeExpired() {
  const rows = db.prepare('SELECT * FROM images WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .all(Date.now() - config.trashDays * DAY);
  if (!rows.length) return;
  const n = await purgeRows(rows);
  console.log(`废纸篓：清掉了 ${n} 张超过 ${config.trashDays} 天的图`);
}

// ---------- 出图 ----------
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];

export async function handleImage(req, res, path) {
  let key;
  try { key = decodeURIComponent(path.slice(3)); } catch { key = ''; }
  // 只对库里存在、且不在废纸篓里的图出图
  const known = validKey(key) && db.prepare(
    'SELECT 1 FROM images WHERE (key = ? OR thumb_key = ?) AND deleted_at IS NULL LIMIT 1').get(key, key);
  if (!known) return send(res, 404, 'Not found');

  const fwd = {};
  for (const h of ['range', 'if-none-match', 'if-modified-since']) if (req.headers[h]) fwd[h] = req.headers[h];
  const r = await getObject(key, { method: req.method, headers: fwd });
  if (r.status === 404) return send(res, 404, 'Not found');
  if (!r.ok && r.status !== 304 && r.status !== 206) throw new HttpError(502, `读取图片失败（${r.status}）`);

  const headers = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'access-control-allow-origin': '*',
  };
  for (const h of PASS_HEADERS) {
    const v = r.headers.get(h);
    if (v) headers[h] = v;
  }
  headers['cache-control'] ||= 'public, max-age=31536000, immutable';
  res.writeHead(r.status, headers);
  if (req.method === 'HEAD' || !r.body || r.status === 304) return res.end();
  Readable.fromWeb(r.body).pipe(res);
}

// ---------- 从 R2 重建索引 ----------
// 只补库里没有的图；元信息取自上传时写进 R2 的 metadata
export async function reindex({ log = console.log } = {}) {
  const objects = await listAll();
  const keys = new Set(objects.map((o) => o.key));
  const has = db.prepare('SELECT 1 FROM images WHERE key = ?');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO images (key, thumb_key, name, mime, size, original_size, width, height, source_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  for (const o of objects) {
    if (o.key.startsWith('thumbs/') || has.get(o.key)) continue;
    const info = await headMeta(o.key);
    if (!info) continue;
    const m = info.meta;
    const thumbKey = keys.has(thumbKeyFor(o.key)) ? thumbKeyFor(o.key) : null;
    const hash = /^[0-9a-f]{64}$/.test(m['source-hash'] || '') && !getActiveByHash(m['source-hash']) ? m['source-hash'] : null;
    insert.run(o.key, thumbKey, m.name || '', info.type || 'application/octet-stream', o.size,
      intOrNull(m['original-size']), intOrNull(m.width), intOrNull(m.height), hash, Number(m.created) || o.time);
    added++;
  }
  log(`重建索引：R2 里 ${objects.length} 个对象，新补 ${added} 张`);
  return added;
}
