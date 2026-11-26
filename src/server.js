// leorxx.xyz 整站：主页（/）+ 桌面 Desk（/desk，无限画布与文件中转站）
// 文件存 Cloudflare R2，元信息与画布布局存 SQLite；Caddy 只负责 HTTPS 和压缩，请求全部转到这里

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError, send } from './http.js';
import * as auth from './auth.js';
import * as images from './images.js';
import * as desk from './desk.js';
import { handleMcp } from './mcp.js';

// ---------- 静态文件：web/ 目录和网址一一对应 ----------
const WEB_DIR = new URL('../web/', import.meta.url);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const COMMON_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
const csp = (rules) => ({ ...COMMON_HEADERS, 'content-security-policy': rules.join('; ') });

// 桌面：只允许同源脚本
const DESK_PAGE_HEADERS = csp([
  "default-src 'self'",
  `img-src 'self' ${config.imageOrigin} data: blob:`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  `connect-src 'self' ${config.imageOrigin}`,
  `frame-src ${config.imageOrigin}`,
  `media-src 'self' ${config.imageOrigin} blob:`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
]);
// 主页是单个 HTML 文件，脚本和样式写在页面里
const HOME_PAGE_HEADERS = csp([
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
]);

// web/ 里能直接访问的文件：桌面的脚本和样式（assets/）、字体（fonts/）、图标、头像、PWA 配置
// 两个页面只能从 / 和 /desk 打开，.html 不直接对外
const WEB_FILE = /^\/((?:assets\/|fonts\/)?[\w-]+(?:\.[\w-]+)*\.(?:css|js|json|png|svg|webp|ico|woff2))$/;

// 字体和图片可以缓存久一点；页面、脚本、PWA 配置每次都先问一下有没有更新（没变就回 304）
function cacheFor(file) {
  if (file.endsWith('.woff2')) return 'public, max-age=2592000';
  if (/\.(png|svg|webp|ico)$/.test(file)) return 'public, max-age=86400';
  return 'no-cache';
}

async function serveFile(req, res, dir, file, headers = COMMON_HEADERS) {
  const url = new URL(file, dir);
  let st;
  try { st = await stat(url); } catch { st = null; }
  if (!st?.isFile()) return send(res, 404, 'Not found');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const head = {
    ...headers,
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'cache-control': cacheFor(file),
    etag,
    'last-modified': st.mtime.toUTCString(),
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, head);
    return res.end();
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...head, 'content-length': st.size });
    return res.end();
  }
  send(res, 200, await readFile(url), head);
}

// 图片域名上以前单独装过一个 Service Worker，访问 img 域名的 /sw.js 时给它一个自我注销的脚本
const RETIRED_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
`;

function serveWorker(req, res) {
  if (req.headers.host === new URL(config.origin).host) return serveFile(req, res, WEB_DIR, 'sw.js');
  send(res, 200, RETIRED_WORKER, { 'content-type': 'text/javascript; charset=utf-8' });
}

// 页面和静态文件；不是这些就返回 false，交给后面的接口路由
function serveSite(req, res, path) {
  if (path === '/') return serveFile(req, res, WEB_DIR, 'home.html', HOME_PAGE_HEADERS);
  if (path === '/desk' || path === '/desk/') return serveFile(req, res, WEB_DIR, 'desk.html', DESK_PAGE_HEADERS);
  if (path === '/darkroom' || path === '/darkroom/') return send(res, 302, '', { location: `${config.origin}/desk` });
  if (path === '/sw.js') return serveWorker(req, res);
  const m = path.match(WEB_FILE);
  if (m) return serveFile(req, res, WEB_DIR, m[1]);
  return false;
}

// ---------- 主页用的在线检测 ----------
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
// 第四项是谁能访问：不写就是要登录（浏览器会话）；PUBLIC 谁都能访问；READ / UPLOAD 要带对应权限的 API 令牌
const PUBLIC = 'public';
// VIEW 谁都能看（画布、列表）；登录了的话 req.session 有值，接口可以多给一点
const VIEW = 'view';
const READ = 'token:read';
const UPLOAD = 'token:upload';

const routes = [
  ['GET', '/api/health', (req, res) => send(res, 200, { ok: true }), PUBLIC],
  ['GET', '/api/status', async (req, res) => send(res, 200, await checkAll()), PUBLIC],

  // 登录本身；注册新的通行密钥要么已登录、要么带初始化码，在 auth.js 里判断
  ['GET', '/api/auth/state', auth.handleState, PUBLIC],
  ['POST', '/api/auth/login/options', auth.handleLoginOptions, PUBLIC],
  ['POST', '/api/auth/login/verify', auth.handleLoginVerify, PUBLIC],
  ['POST', '/api/auth/register/options', auth.handleRegisterOptions, PUBLIC],
  ['POST', '/api/auth/register/verify', auth.handleRegisterVerify, PUBLIC],
  ['POST', '/api/auth/logout', auth.handleLogout],
  ['GET', '/api/passkeys', auth.handleListPasskeys],
  ['DELETE', /^\/api\/passkeys\/([\w-]+)$/, (req, res, m) => auth.handleDeletePasskey(req, res, m[1])],
  ['GET', '/api/tokens', auth.handleListTokens],
  ['POST', '/api/tokens', auth.handleCreateToken],
  ['DELETE', /^\/api\/tokens\/(\w+)$/, (req, res, m) => auth.handleDeleteToken(req, res, m[1])],

  // 给脚本和 AI 用
  ['POST', '/api/v1/upload', images.handleApiUpload, UPLOAD],
  ['GET', '/api/v1/files', images.handleApiList, READ],
  ['GET', /^\/api\/v1\/files\/(\d+)$/, (req, res, m) => images.handleApiGet(req, res, Number(m[1])), READ],

  // 看是公开的，改要登录：读画布、列表、用量谁都能调，其余写操作和回收站都要登录
  ['GET', '/api/desk', desk.handleGetDesk, VIEW],
  ['PATCH', '/api/desk', desk.handlePatchDesk],

  ['POST', '/api/images', images.handleUpload],
  ['GET', '/api/images', images.handleList, VIEW],
  ['GET', '/api/images/months', images.handleMonths, VIEW],
  ['GET', /^\/api\/images\/by-hash\/(\w+)$/, (req, res, m) => images.handleByHash(req, res, m[1])],
  ['PUT', /^\/api\/images\/(\d+)\/thumb$/, (req, res, m) => images.handleThumb(req, res, Number(m[1]))],
  ['POST', '/api/images/trash', images.handleMoveToTrash],
  ['GET', '/api/trash', images.handleTrashList],
  ['POST', '/api/trash/restore', images.handleRestore],
  ['POST', '/api/trash/purge', images.handlePurge],
  ['GET', '/api/stats', images.handleStats, VIEW],
];

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' || method === 'HEAD') {
    if (path.startsWith('/i/')) return images.handleImage(req, res, path);
    if (!path.startsWith('/api/')) {
      const served = serveSite(req, res, path);
      if (served !== false) return served;
      return send(res, 404, 'Not found');
    }
  }

  // MCP 自己校验令牌：令牌放 Authorization: Bearer，只能填地址的客户端用 /api/mcp/<令牌>
  const mcp = path.match(/^\/api\/mcp(?:\/([\w-]+))?\/?$/);
  if (mcp) return handleMcp(req, res, mcp[1]);

  // 浏览器端带 Origin 的写操作校验同源，防止第三方网页跨域调用
  if (!['GET', 'HEAD'].includes(method) && req.headers.origin && req.headers.origin !== config.origin) {
    throw new HttpError(403, '来源不对');
  }

  for (const [m, pattern, handler, access] of routes) {
    if (m !== method) continue;
    if (typeof pattern === 'string' ? pattern === path : pattern.test(path)) {
      if (access === READ || access === UPLOAD) auth.requireApiToken(req, access.slice(6));
      else if (access === VIEW) req.session = auth.authenticate(req, res);
      else if (access !== PUBLIC) req.session = auth.requireSession(req, res);
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
  console.log(`桌面已启动：http://${config.host}:${config.port}  →  R2 桶 ${config.r2.bucket}`);
  auth.announceSetupCodeIfNeeded();
});

if (db.prepare('SELECT COUNT(*) AS n FROM images').get().n === 0) {
  images.reindex().catch((err) => console.error('重建索引失败：', err.message));
}
images.purgeExpired().catch((err) => console.error('清理回收站失败：', err.message));
setInterval(() => images.purgeExpired().catch((err) => console.error('清理回收站失败：', err.message)), 3600e3).unref();
