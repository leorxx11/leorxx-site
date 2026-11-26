// 图片和文件：上传、列表、废纸篓、出图、从 R2 重建索引

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { db, tx } from './db.js';
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

// 图片以外的文件按扩展名定出图类型，不信任客户端给的 Content-Type。
// 文本一律当 text/plain 出（HTML、SVG、JS 也是），浏览器不会执行；认不出的一律下载
const TEXT_EXTS = new Set(`txt md markdown mdx csv tsv json jsonl ndjson yaml yml toml ini conf cfg env log xml html htm svg
  css scss less js mjs cjs ts tsx jsx vue svelte py ipynb rb go rs java kt kts swift c h cc cpp hpp cs m php pl sh bash zsh fish ps1 bat
  sql graphql proto r jl lua dart scala ex exs erl hs clj tex bib srt vtt diff patch rst adoc org`.split(/\s+/));
const MEDIA_TYPES = {
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const extOf = (name) => (name.match(/\.([a-z0-9]{1,10})$/i)?.[1] || '').toLowerCase();

function classify(name, buf) {
  const img = sniff(buf);
  if (img) return img;
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) return { type: 'text/plain', ext };
  if (MEDIA_TYPES[ext]) return { type: MEDIA_TYPES[ext], ext };
  return { type: 'application/octet-stream', ext: ext || 'bin' };
}

export function kindOf(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'text/plain') return 'text';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

const thumbKeyFor = (key) => `thumbs/${key.replace(/\.[^./]+$/, '')}.webp`;
const validKey = (key) => /^[\w\-./]{1,200}$/.test(key) && !key.includes('..') && !key.startsWith('/');
const intOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const floatOrNull = (v, min = -1e5, max = 1e5) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

function nextDeskSpot() {
  const { cnt, maxZ } = db.prepare(
    'SELECT COUNT(*) AS cnt, COALESCE(MAX(z), 0) AS maxZ FROM images WHERE deleted_at IS NULL',
  ).get();
  const angle = cnt * 2.39996 + (Math.random() - 0.5) * 0.25;
  const radius = cnt === 0 ? 0 : 142 * Math.sqrt(cnt);
  return {
    x: Math.round(Math.cos(angle) * radius * 1.18),
    y: Math.round(Math.sin(angle) * radius * 0.86),
    rot: Number(((Math.random() - 0.5) * 3.4).toFixed(2)),
    z: maxZ + 1,
  };
}

function toApi(row) {
  const kind = kindOf(row.mime);
  return {
    id: row.id,
    kind,
    url: `${config.imageOrigin}/i/${row.key}`,
    thumb: kind === 'image' ? `${config.imageOrigin}/i/${row.thumb_key || row.key}` : null,
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
    x: row.x ?? 0,
    y: row.y ?? 0,
    w: row.w ?? null,
    rot: row.rot ?? 0,
    z: row.z ?? 0,
  };
}

// 画布和列表是同一批文件：没进回收站的都摆在桌上
export function listDeskFiles() {
  return db.prepare(`${SELECT} WHERE deleted_at IS NULL ORDER BY z ASC, id ASC LIMIT 2000`)
    .all()
    .map(toApi);
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
  return ingest(req, res);
}

// 给后端程序用：请求体是文件原始字节，服务器自己算哈希查重
export async function handleApiUpload(req, res) {
  return ingest(req, res, { hashBody: true });
}

async function ingest(req, res, { hashBody = false } = {}) {
  const deskX = floatOrNull(req.headers['x-desk-x']);
  const deskY = floatOrNull(req.headers['x-desk-y']);
  const deskRot = floatOrNull(req.headers['x-desk-rot'], -45, 45);
  let sourceHash = /^[0-9a-f]{64}$/.test(req.headers['x-source-hash'] || '') ? req.headers['x-source-hash'] : null;
  if (sourceHash) {
    const dup = getActiveByHash(sourceHash);
    if (dup) {
      req.resume();
      return send(res, 200, { image: toApi(moveOnDesk(dup, deskX, deskY, deskRot)), duplicate: true });
    }
  }

  const buf = await readBody(req, Math.max(config.maxBytes, config.maxFileBytes));
  const rawName = String(req.headers['x-filename'] || '');
  let name;
  try { name = decodeURIComponent(rawName); } catch { name = rawName; }
  if (hashBody && !sourceHash) sourceHash = createHash('sha256').update(buf).digest('hex');
  send(res, 200, await storeFile(buf, {
    name,
    sourceHash,
    width: intOrNull(req.headers['x-width']),
    height: intOrNull(req.headers['x-height']),
    originalSize: intOrNull(req.headers['x-original-size']),
    deskX,
    deskY,
    deskRot,
  }));
}

// 重复上传时如果带了落点，就把原来那张挪到落点、放到最上层
function moveOnDesk(row, deskX, deskY, deskRot) {
  if (deskX === null || deskY === null) return row;
  const { z } = nextDeskSpot();
  db.prepare('UPDATE images SET x = ?, y = ?, rot = ?, z = ? WHERE id = ?').run(deskX, deskY, deskRot ?? row.rot ?? 0, z, row.id);
  return getById(row.id);
}

// 存一个文件：查重、写 R2、记索引。网页、/api/v1/upload 和 MCP 共用
export async function storeFile(buf, {
  name = '', sourceHash = null, width = null, height = null, originalSize = null,
  deskX = null, deskY = null, deskRot = null,
}) {
  name = String(name).slice(0, 200);
  const kind = classify(name, buf);
  const isImage = kind.type.startsWith('image/');
  const limit = isImage ? config.maxBytes : config.maxFileBytes;
  if (buf.length > limit) throw new HttpError(413, `${isImage ? '图片' : '文件'}超过 ${Math.round(limit / 1024 / 1024)} MB`);
  if (!buf.length) throw new HttpError(400, '文件是空的');
  if (sourceHash) {
    const dup = getActiveByHash(sourceHash);
    if (dup) return { image: toApi(moveOnDesk(dup, deskX, deskY, deskRot)), duplicate: true };
  }

  const now = Date.now();
  const d = new Date(now + 8 * 3600e3); // 北京时间的年月
  // 文件的链接就是访问凭证，用 128 位随机串，猜不到
  const id = isImage ? now.toString(36) + randomBytes(3).toString('hex') : randomBytes(16).toString('base64url');
  const key = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${id}.${kind.ext}`;
  const spot = nextDeskSpot();
  const x = deskX ?? spot.x;
  const y = deskY ?? spot.y;
  const rot = deskRot ?? spot.rot;

  await putObject(key, buf, kind.type, {
    name, width, height, 'original-size': originalSize, 'source-hash': sourceHash, created: now,
  });
  try {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO images (key, name, mime, size, original_size, width, height, source_hash, created_at, x, y, rot, z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, name, kind.type, buf.length, originalSize, width, height, sourceHash, now, x, y, rot, spot.z);
    return { image: toApi(getById(Number(lastInsertRowid))) };
  } catch (err) {
    // 同一张图几乎同时传了两次：保留先到的，删掉刚写进 R2 的这份
    const dup = sourceHash && getActiveByHash(sourceHash);
    if (!dup) throw err;
    await deleteObject(key).catch(() => {});
    return { image: toApi(dup), duplicate: true };
  }
}

export async function handleThumb(req, res, id) {
  const row = getById(id);
  if (!row || row.deleted_at) throw new HttpError(404, '没有这张图');
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (sniff(buf)?.type !== 'image/webp') throw new HttpError(415, '缩略图要是 WebP');
  const thumbKey = thumbKeyFor(row.key);
  await putObject(thumbKey, buf, 'image/webp');
  db.prepare('UPDATE images SET thumb_key = ? WHERE id = ?').run(thumbKey, id);
  send(res, 200, { image: toApi(getById(id)) });
}

// ---------- 文件列表 ----------
export function handleList(req, res, url) {
  send(res, 200, listPage(url));
}

// 底片库和 /api/v1/files 共用：q 搜原文件名（空格分开的词都要命中），kind 是 image / file 或具体类型
export function listPage(url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const where = ['deleted_at IS NULL'];
  const args = [];
  for (const word of (url.searchParams.get('q') || '').trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    where.push(`name LIKE ? ESCAPE '\\'`); args.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const kind = url.searchParams.get('kind') || '';
  if (kind === 'image') where.push(`mime LIKE 'image/%'`);
  else if (kind === 'file') where.push(`mime NOT LIKE 'image/%'`);
  else if (kind === 'text') where.push(`mime = 'text/plain'`);
  else if (kind === 'pdf') where.push(`mime = 'application/pdf'`);
  else if (kind === 'audio' || kind === 'video') { where.push('mime LIKE ?'); args.push(`${kind}/%`); }
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
  return { items, nextCursor: more && last ? `${last.createdAt}-${last.id}` : null };
}

// ---------- 给 AI / 程序读：带 read 权限的令牌 ----------
export const forAi = ({ id, kind, url, name, mime, size, width, height, createdAt }) =>
  ({ id, kind, name, url, mime, size, width, height, createdAt: new Date(createdAt).toISOString() });

export function handleApiList(req, res, url) {
  const page = listPage(url);
  send(res, 200, { items: page.items.map(forAi), nextCursor: page.nextCursor });
}

export function handleApiGet(req, res, id) {
  send(res, 200, forAi(activeFile(id)));
}

// 没进回收站的文件，带上 R2 里的 key
export function activeFile(id) {
  const row = getById(id);
  if (!row || row.deleted_at) throw new HttpError(404, '没有这个文件');
  return { ...toApi(row), key: row.key };
}

export function handleMonths(req, res) {
  const rows = db.prepare(`
    SELECT ${MONTH_SQL} AS month, COUNT(*) AS count FROM images
    WHERE deleted_at IS NULL GROUP BY month ORDER BY month DESC`).all();
  send(res, 200, { months: rows });
}

export function handleByHash(req, res, hash) {
  const row = /^[0-9a-f]{64}$/.test(hash) ? getActiveByHash(hash) : null;
  send(res, 200, { image: row ? toApi(row) : null });
}

export function handleStats(req, res) {
  const active = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM images WHERE deleted_at IS NULL').get();
  const trash = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM images WHERE deleted_at IS NOT NULL').get();
  send(res, 200, { count: active.count, bytes: active.bytes, trashCount: trash.count, trashBytes: trash.bytes, trashDays: config.trashDays, quotaBytes: config.storageBytes });
}

// ---------- 回收站 ----------
export async function handleMoveToTrash(req, res) {
  const ids = parseIds(await readJson(req));
  const now = Date.now();
  const stmt = db.prepare('UPDATE images SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL');
  const moved = tx(() => ids.reduce((n, id) => n + Number(stmt.run(now, id).changes), 0));
  send(res, 200, { moved });
}

export function handleTrashList(req, res) {
  const rows = db.prepare(`${SELECT} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`).all();
  send(res, 200, { items: rows.map(toApi), trashDays: config.trashDays });
}

export async function handleRestore(req, res) {
  const ids = parseIds(await readJson(req));
  let restored = 0;
  const conflicts = [];
  for (const id of ids) {
    try {
      restored += Number(db.prepare('UPDATE images SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes);
    } catch {
      conflicts.push(id);
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
  const row = validKey(key) && db.prepare(
    'SELECT key, name, mime FROM images WHERE (key = ? OR thumb_key = ?) AND deleted_at IS NULL LIMIT 1').get(key, key);
  if (!row) return send(res, 404, 'Not found');

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
  if (row.key === key && !row.mime.startsWith('image/')) {
    // 类型以库里为准；文本统一按 UTF-8 纯文本出，认不出的强制下载
    const kind = kindOf(row.mime);
    headers['content-type'] = kind === 'text' ? 'text/plain; charset=utf-8' : row.mime;
    const fallback = row.name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'file';
    headers['content-disposition'] = `${kind === 'other' ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(row.name || 'file')}`;
    // Chrome 的 PDF 阅读器在 sandbox 里打不开；PDF 单独一个源、不带登录态，放开也无妨
    if (kind === 'pdf') delete headers['content-security-policy'];
  }
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
