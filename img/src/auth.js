// 登录：通行密钥 + Cookie 会话；首次绑定或恢复用一次性初始化码

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { HttpError, addCookie, clientIp, cookie, parseCookies, rateLimiter, readJson, send } from './http.js';

const DAY = 864e5;
const SESSION_COOKIE = 'dr_session';
const CHALLENGE_COOKIE = 'dr_chal';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------- 用户标识（WebAuthn 要求有一个稳定的 user id）----------
function userId() {
  let id = getMeta('webauthn_user_id');
  if (!id) { id = b64url(randomBytes(16)); setMeta('webauthn_user_id', id); }
  return new Uint8Array(Buffer.from(id, 'base64url'));
}

const passkeyCount = () => db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n;

// ---------- 初始化码 ----------
// 32 个不易混淆的字符取 8 位，约 1.1 万亿种组合；再加上限流和全局失败上限，没法爆破
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SETUP_TTL = 30 * 60e3;
const SETUP_MAX_FAILS = 10;
const setupLimiter = rateLimiter({ max: 5, window: 10 * 60e3 });
const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createSetupCode() {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  setMeta('setup_hash', sha256(raw));
  setMeta('setup_expires', Date.now() + SETUP_TTL);
  setMeta('setup_fails', 0);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function clearSetupCode() {
  setMeta('setup_hash', null);
  setMeta('setup_expires', null);
  setMeta('setup_fails', null);
}

function currentSetupHash() {
  const hash = getMeta('setup_hash');
  if (!hash) return null;
  if (Number(getMeta('setup_expires')) < Date.now()) { clearSetupCode(); return null; }
  return hash;
}

// 校验通过返回该码的哈希，失败抛错
function verifySetupCode(code, ip) {
  setupLimiter.check(ip);
  const want = currentSetupHash();
  const got = sha256(normalizeCode(code));
  if (want && timingSafeEqual(Buffer.from(got), Buffer.from(want))) return want;

  setupLimiter.add(ip);
  if (want) {
    const fails = Number(getMeta('setup_fails') || 0) + 1;
    if (fails >= SETUP_MAX_FAILS) clearSetupCode();
    else setMeta('setup_fails', fails);
  }
  throw new HttpError(401, '初始化码不对或已过期');
}

// 还没有任何通行密钥时，启动就生成一个初始化码打到日志里
export function announceSetupCodeIfNeeded() {
  if (passkeyCount() > 0) return;
  const code = createSetupCode();
  console.log(`\n  还没有绑定通行密钥。初始化码：${code}（30 分钟内有效）\n  过期了就重启服务，或执行 node cli.js setup-code\n`);
}

// ---------- 会话 ----------
function setSessionCookie(res, token) {
  addCookie(res, cookie(SESSION_COOKIE, token, { maxAge: config.sessionDays * DAY / 1000, secure: config.secureCookie }));
}

function createSession(req, res) {
  const token = b64url(randomBytes(32));
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(sha256(token), now, now + config.sessionDays * DAY, String(req.headers['user-agent'] || '').slice(0, 300));
  setSessionCookie(res, token);
}

// 有效会话返回 { tokenHash }，没有返回 null；离到期不足 29 天时顺手续期
export function authenticate(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash);
  const now = Date.now();
  if (!row || row.expires_at <= now) return null;
  if (row.expires_at - now < (config.sessionDays - 1) * DAY) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + config.sessionDays * DAY, tokenHash);
    setSessionCookie(res, token);
  }
  return { tokenHash };
}

export function requireSession(req, res) {
  const s = authenticate(req, res);
  if (!s) throw new HttpError(401, '请先登录');
  return s;
}

// ---------- 挑战（注册 / 登录过程中的一次性随机数）----------
const challenges = new Map(); // id -> { challenge, kind, expires, setupHash }

function saveChallenge(res, data) {
  const id = b64url(randomBytes(16));
  challenges.set(id, { ...data, expires: Date.now() + 5 * 60e3 });
  addCookie(res, cookie(CHALLENGE_COOKIE, id, { maxAge: 300, secure: config.secureCookie }));
}

function takeChallenge(req, res, kind) {
  const id = parseCookies(req)[CHALLENGE_COOKIE];
  const c = id && challenges.get(id);
  if (id) challenges.delete(id);
  addCookie(res, cookie(CHALLENGE_COOKIE, '', { maxAge: 0, secure: config.secureCookie }));
  if (!c || c.kind !== kind || c.expires < Date.now()) throw new HttpError(400, '操作超时了，再试一次');
  return c;
}

// ---------- 设备名 ----------
function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '未知设备';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

// ---------- 接口 ----------
const loginLimiter = rateLimiter({ max: 30, window: 10 * 60e3 });

export function handleState(req, res) {
  send(res, 200, { authed: !!authenticate(req, res), hasPasskey: passkeyCount() > 0 });
}

export async function handleRegisterOptions(req, res) {
  const body = await readJson(req);
  const session = authenticate(req, res);
  const setupHash = session ? null : verifySetupCode(body.setupCode, clientIp(req));

  const existing = db.prepare('SELECT id, transports FROM passkeys').all();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: 'leo',
    userDisplayName: 'Leo',
    userID: userId(),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  saveChallenge(res, { challenge: options.challenge, kind: 'register', setupHash });
  send(res, 200, options);
}

export async function handleRegisterVerify(req, res) {
  const body = await readJson(req);
  const c = takeChallenge(req, res, 'register');
  const session = authenticate(req, res);
  if (c.setupHash) {
    if (currentSetupHash() !== c.setupHash) throw new HttpError(401, '初始化码已失效，重新获取一个');
  } else if (!session) {
    throw new HttpError(401, '请先登录');
  }

  let result;
  try {
    result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: c.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    throw new HttpError(400, `通行密钥校验失败：${err.message}`);
  }
  if (!result.verified) throw new HttpError(400, '通行密钥校验失败');

  const { credential } = result.registrationInfo;
  db.prepare('INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(credential.id, Buffer.from(credential.publicKey), credential.counter,
      JSON.stringify(credential.transports || []), deviceName(req.headers['user-agent']), Date.now());
  if (c.setupHash) clearSetupCode();
  if (!session) createSession(req, res);
  send(res, 200, { ok: true });
}

export async function handleLoginOptions(req, res) {
  loginLimiter.hit(clientIp(req));
  const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'preferred' });
  saveChallenge(res, { challenge: options.challenge, kind: 'login' });
  send(res, 200, options);
}

export async function handleLoginVerify(req, res) {
  const body = await readJson(req);
  const c = takeChallenge(req, res, 'login');
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(body.response?.id || ''));
  if (!row) throw new HttpError(401, '这把通行密钥不认识，可能已经删掉了');

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: c.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    throw new HttpError(401, `登录失败：${err.message}`);
  }
  if (!result.verified) throw new HttpError(401, '登录失败');

  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(result.authenticationInfo.newCounter, Date.now(), row.id);
  createSession(req, res);
  send(res, 200, { ok: true });
}

export async function handleLogout(req, res) {
  const body = await readJson(req);
  const s = requireSession(req, res);
  if (body.others) {
    const { changes } = db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(s.tokenHash);
    return send(res, 200, { ok: true, removed: Number(changes) });
  }
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.tokenHash);
  addCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0, secure: config.secureCookie }));
  send(res, 200, { ok: true });
}

export function handleListPasskeys(req, res) {
  requireSession(req, res);
  const rows = db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at').all();
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now()).n;
  send(res, 200, { passkeys: rows, sessions });
}

export function handleDeletePasskey(req, res, id) {
  requireSession(req, res);
  if (passkeyCount() <= 1) throw new HttpError(400, '至少要留一把通行密钥，不然就进不来了');
  db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
  send(res, 200, { ok: true });
}

// 定期清理过期会话和挑战
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  for (const [id, c] of challenges) if (c.expires < Date.now()) challenges.delete(id);
}, 3600e3).unref();
