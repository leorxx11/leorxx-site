// 请求 / 响应的小工具

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `文件超过 ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req, 256 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, '请求格式不对'); }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

// 同一个响应可能要设多个 Cookie，不能用 setHeader 互相覆盖
export function addCookie(res, value) {
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', prev ? [].concat(prev, value) : [value]);
}

// 只有 Caddy 能连到本服务（本机或同一个 Docker 网络），这些来源的 X-Forwarded-For 才可信
export function clientIp(req) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fromProxy = remote === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remote);
  const forwarded = req.headers['x-forwarded-for'];
  return fromProxy && forwarded ? forwarded.split(',')[0].trim() : remote;
}

// 简单的计数限流：window 毫秒内记满 max 次就拒绝
// check 只检查不计数，add 计一次；hit = check + add
export function rateLimiter({ max, window }) {
  const counts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of counts) if (v.reset <= now) counts.delete(k);
  }, window).unref();
  const live = (key) => {
    const v = counts.get(key);
    return v && v.reset > Date.now() ? v : null;
  };
  const limiter = {
    check(key) {
      const v = live(key);
      if (v && v.n >= max) throw new HttpError(429, `太频繁了，${Math.ceil((v.reset - Date.now()) / 60000)} 分钟后再试`);
    },
    add(key) {
      const v = live(key);
      if (v) v.n++;
      else counts.set(key, { n: 1, reset: Date.now() + window });
    },
    hit(key) { limiter.check(key); limiter.add(key); },
    clear(key) { counts.delete(key); },
  };
  return limiter;
}
