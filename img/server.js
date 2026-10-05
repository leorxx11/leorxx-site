// 暗房 Darkroom —— 一个只给自己用的图床
// 上传写进 Cloudflare R2，出图由本服务从 R2 读出来再转发（也可以改用 R2 自定义域直出）

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual, webcrypto } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

// aws4fetch 用全局 crypto.subtle，Node 18 默认没有挂到全局
globalThis.crypto ??= webcrypto;

const env = process.env;
const PORT = Number(env.PORT || 3100);
const HOST = env.HOST || '127.0.0.1';
const TOKEN = env.UPLOAD_TOKEN || '';
const BUCKET = env.R2_BUCKET || '';
const ENDPOINT = (env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/$/, '');
// 返回给前端的图片地址前缀：默认走本服务的 /i/，绑定了 R2 自定义域就改成 https://xxx
const PUBLIC_BASE = (env.PUBLIC_BASE || '/i').replace(/\/$/, '');
const MAX_BYTES = Number(env.MAX_MB || 20) * 1024 * 1024;

const missing = ['UPLOAD_TOKEN', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
if (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID');
if (missing.length) {
  console.error(`缺少环境变量：${missing.join(', ')}`);
  process.exit(1);
}
if (TOKEN.length < 12) {
  console.error('UPLOAD_TOKEN 至少 12 位');
  process.exit(1);
}

const r2 = new AwsClient({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
});
const bucketUrl = `${ENDPOINT}/${BUCKET}`;
const objectUrl = (key) => `${bucketUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
const publicUrl = (key) => `${PUBLIC_BASE}/${key}`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- 鉴权：单口令 + 失败锁定 ----------
const failures = new Map(); // ip -> { count, until }

function clientIp(req) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // 只有 Caddy 能连到本服务（本机或同一个 Docker 网络），这些来源的 X-Forwarded-For 才可信
  const fromProxy = remote === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remote);
  const forwarded = req.headers['x-forwarded-for'];
  return fromProxy && forwarded ? forwarded.split(',')[0].trim() : remote;
}

function requireAuth(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const f = failures.get(ip);
  if (f?.until > now) throw new HttpError(429, '试错太多次了，10 分钟后再来');
  if (f?.until && f.until <= now) failures.delete(ip);

  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  if (got.length === want.length && timingSafeEqual(got, want)) {
    failures.delete(ip);
    return;
  }
  const count = (failures.get(ip)?.count || 0) + 1;
  failures.set(ip, { count, until: count >= 10 ? now + 10 * 60e3 : 0 });
  throw new HttpError(401, '口令不对');
}

// ---------- 工具 ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new HttpError(413, `文件超过 ${MAX_BYTES / 1024 / 1024} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

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

function newKey(ext) {
  const d = new Date();
  const id = d.getTime().toString(36) + randomBytes(3).toString('hex');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${id}.${ext}`;
}

const validKey = (key) => /^[\w\-./]{1,200}$/.test(key) && !key.includes('..') && !key.startsWith('/');

const unxml = (s = '') => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e]));

// ---------- R2 列表（带 30 秒缓存）----------
let listCache = null;

async function listAll() {
  if (listCache && Date.now() - listCache.at < 30e3) return listCache.items;
  const items = [];
  let token = null;
  do {
    const u = new URL(bucketUrl);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);
    const r = await r2.fetch(u.toString());
    if (!r.ok) throw new HttpError(502, `读取 R2 列表失败（${r.status}）`);
    const xml = await r.text();
    for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (name) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
      items.push({ key: unxml(tag('Key')), size: Number(tag('Size')), time: tag('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unxml(xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1])
      : null;
  } while (token);
  items.sort((a, b) => b.time.localeCompare(a.time));
  listCache = { at: Date.now(), items };
  return items;
}

// ---------- 主页用的在线检测（只回报通不通，不转发内容）----------
const STATUS_TARGETS = (env.STATUS_TARGETS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]);
let statusCache = null;

async function checkAll() {
  if (statusCache && Date.now() - statusCache.at < 30e3) return statusCache.data;
  const data = { img: { up: true, ms: 0 } };
  await Promise.all(STATUS_TARGETS.map(async ([name, target]) => {
    const t0 = performance.now();
    try {
      const r = await fetch(target, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(6000) });
      data[name] = { up: r.status < 500, ms: Math.round(performance.now() - t0) };
    } catch {
      data[name] = { up: false };
    }
  }));
  statusCache = { at: Date.now(), data };
  return data;
}

// ---------- 路由 ----------
async function handleUpload(req, res) {
  requireAuth(req);
  const buf = await readBody(req);
  const kind = sniff(buf);
  if (!kind) throw new HttpError(415, '只收 PNG、JPEG、GIF、WebP、AVIF');
  let name = '';
  try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch {}
  name = name.slice(0, 200);

  const key = newKey(kind.ext);
  const r = await r2.fetch(objectUrl(key), {
    method: 'PUT',
    body: buf,
    headers: {
      'content-type': kind.type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-amz-meta-name': encodeURIComponent(name),
    },
  });
  if (!r.ok) throw new HttpError(502, `写入 R2 失败（${r.status}）`);
  listCache = null;
  send(res, 200, { key, url: publicUrl(key), size: buf.length, type: kind.type, name });
}

async function handleList(req, res, url) {
  requireAuth(req);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const all = await listAll();
  const items = all.slice(offset, offset + limit).map((it) => ({ ...it, url: publicUrl(it.key) }));
  send(res, 200, { total: all.length, offset, items });
}

async function handleDelete(req, res, url) {
  requireAuth(req);
  const key = url.searchParams.get('key') || '';
  if (!validKey(key)) throw new HttpError(400, '文件名不合法');
  const r = await r2.fetch(objectUrl(key), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new HttpError(502, `删除失败（${r.status}）`);
  listCache = null;
  send(res, 200, { ok: true });
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];

async function handleImage(req, res, path) {
  let key;
  try { key = decodeURIComponent(path.slice(3)); } catch { key = ''; }
  if (!validKey(key)) return send(res, 404, 'Not found');

  const fwd = {};
  for (const h of ['range', 'if-none-match', 'if-modified-since']) if (req.headers[h]) fwd[h] = req.headers[h];
  const r = await r2.fetch(objectUrl(key), { method: req.method, headers: fwd });
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

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' https: data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');
const pagePath = new URL('./public/index.html', import.meta.url);

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const m = req.method;

  if ((m === 'GET' || m === 'HEAD') && path.startsWith('/i/')) return handleImage(req, res, path);
  if (m === 'GET' && path === '/api/health') return send(res, 200, { ok: true });
  if (m === 'GET' && path === '/api/status') return send(res, 200, await checkAll());
  if (m === 'GET' && path === '/api/ping') { requireAuth(req); return send(res, 200, { ok: true, publicBase: PUBLIC_BASE }); }
  if (m === 'POST' && path === '/api/upload') return handleUpload(req, res);
  if (m === 'GET' && path === '/api/list') return handleList(req, res, url);
  if (m === 'DELETE' && path === '/api/object') return handleDelete(req, res, url);
  if (m === 'GET' && (path === '/' || path === '/index.html')) {
    const html = await readFile(pagePath);
    return send(res, 200, html, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
  }
  send(res, 404, 'Not found');
}

http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    send(res, status, { error: status === 500 ? '服务器出错了' : err.message }, status === 413 ? { connection: 'close' } : {});
  }
}).listen(PORT, HOST, () => {
  console.log(`暗房已开张：http://${HOST}:${PORT}  →  R2 桶 ${BUCKET}`);
});
