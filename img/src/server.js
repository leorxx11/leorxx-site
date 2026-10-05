// 暗房 Darkroom —— 只给自己用的图床
// 图片存 Cloudflare R2，元信息存 SQLite，登录用通行密钥

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError, send } from './http.js';
import * as auth from './auth.js';
import * as images from './images.js';

// ---------- 静态页面 ----------
const PUBLIC_DIR = new URL('../public/', import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PAGE_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

async function serveStatic(res, file) {
  if (!/^[\w-]+\.(html|js|css|svg)$/.test(file)) return send(res, 404, 'Not found');
  let body;
  try { body = await readFile(new URL(file, PUBLIC_DIR)); } catch { return send(res, 404, 'Not found'); }
  send(res, 200, body, { ...PAGE_HEADERS, 'content-type': `${TYPES[extname(file)]}; charset=utf-8`, 'cache-control': 'no-cache' });
}

// ---------- 主页用的在线检测（只回报通不通，不转发内容）----------
let statusCache = null;

async function checkAll() {
  if (statusCache && Date.now() - statusCache.at < 30e3) return statusCache.data;
  const data = { img: { up: true, ms: 0 } };
  await Promise.all(config.statusTargets.map(async ([name, target]) => {
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
const routes = [
  ['GET', '/api/health', (req, res) => send(res, 200, { ok: true })],
  ['GET', '/api/status', async (req, res) => send(res, 200, await checkAll())],

  ['GET', '/api/auth/state', auth.handleState],
  ['POST', '/api/auth/register/options', auth.handleRegisterOptions],
  ['POST', '/api/auth/register/verify', auth.handleRegisterVerify],
  ['POST', '/api/auth/login/options', auth.handleLoginOptions],
  ['POST', '/api/auth/login/verify', auth.handleLoginVerify],
  ['POST', '/api/auth/logout', auth.handleLogout],
  ['GET', '/api/passkeys', auth.handleListPasskeys],
  ['DELETE', /^\/api\/passkeys\/([\w-]+)$/, (req, res, m) => auth.handleDeletePasskey(req, res, m[1])],

  ['POST', '/api/images', images.handleUpload],
  ['GET', '/api/images', images.handleList],
  ['GET', '/api/images/months', images.handleMonths],
  ['GET', /^\/api\/images\/by-hash\/(\w+)$/, (req, res, m) => images.handleByHash(req, res, m[1])],
  ['PUT', /^\/api\/images\/(\d+)\/thumb$/, (req, res, m) => images.handleThumb(req, res, Number(m[1]))],
  ['POST', '/api/images/trash', images.handleMoveToTrash],
  ['GET', '/api/trash', images.handleTrashList],
  ['POST', '/api/trash/restore', images.handleRestore],
  ['POST', '/api/trash/purge', images.handlePurge],
  ['GET', '/api/stats', images.handleStats],
];

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/i/')) return images.handleImage(req, res, path);
  if (method === 'GET' && path === '/') return serveStatic(res, 'index.html');
  if (method === 'GET' && path.startsWith('/assets/')) return serveStatic(res, path.slice(8));

  // 写操作必须来自本站页面，挡掉跨站请求
  if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== config.origin) {
    throw new HttpError(403, '来源不对');
  }

  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    if (typeof pattern === 'string' ? pattern === path : pattern.test(path)) {
      return handler(req, res, typeof pattern === 'string' ? url : path.match(pattern));
    }
  }
  send(res, 404, { error: '没有这个接口' });
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
}).listen(config.port, config.host, () => {
  console.log(`暗房已开张：http://${config.host}:${config.port}  →  R2 桶 ${config.r2.bucket}，通行密钥绑定 ${config.rpID}`);
  auth.announceSetupCodeIfNeeded();
});

// 库是空的就从 R2 补一次索引（比如第一次升级、或数据库丢了）
if (db.prepare('SELECT COUNT(*) AS n FROM images').get().n === 0) {
  images.reindex().catch((err) => console.error('重建索引失败：', err.message));
}
images.purgeExpired().catch((err) => console.error('清理废纸篓失败：', err.message));
setInterval(() => images.purgeExpired().catch((err) => console.error('清理废纸篓失败：', err.message)), 3600e3).unref();
