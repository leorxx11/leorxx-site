// 各个页面共用的小工具

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// 访客：没登录也能看画布和列表，但不能改（main.js 给 body 加 guest）
export const isGuest = () => document.body.classList.contains('guest');

export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 请求 ----------
// 登录过期（接口回 401）时交给 main.js 处理：提示一句，退回访客
// 之后两秒内各处跟着报的「请先登录」不再弹出，免得盖掉那句提示
let onUnauthorized = () => {};
let muteErrorsUntil = 0;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export function unauthorized() {
  onUnauthorized();
  muteErrorsUntil = Date.now() + 2000;
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const isJson = body !== undefined && !(body instanceof Blob);
  const r = await fetch(path, {
    method,
    headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith('/api/auth/')) unauthorized();
  if (!r.ok) throw new Error(data?.error || `出错了（${r.status}）`);
  return data;
}

// ---------- 过渡 ----------
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// 用 View Transition 做切换；浏览器不支持、用户关了动效、页面在后台时直接切
export function transition(update) {
  if (!document.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') {
    update();
    return Promise.resolve();
  }
  const t = document.startViewTransition(update);
  t.ready.catch(() => {});
  return t.finished.catch(() => {});
}

// 让一块内容的入场动画重新播一遍
export function replay(el) {
  if (!el?.classList.contains('rise')) return;
  el.classList.remove('rise');
  void el.offsetWidth;
  el.classList.add('rise');
}

// ---------- 提示与复制 ----------
export const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

// ok 为 true 时前面带个绿色的勾，出错时不带
let toastTimer;
export function toast(msg, ok = false) {
  if (!ok && Date.now() < muteErrorsUntil) return;
  const el = $('#toast');
  el.textContent = msg;
  if (ok) el.insertAdjacentHTML('afterbegin', CHECK);
  el.classList.toggle('ok', ok);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ok ? 1800 : 3200);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

// 复制按钮：点完短暂变成「✓ 已复制」
export function copyButton(getText, { label = '复制', className = 'btn' } = {}) {
  const btn = Object.assign(document.createElement('button'), { type: 'button', className, textContent: label });
  let timer;
  btn.flash = () => {
    btn.innerHTML = CHECK + '已复制';
    btn.classList.add('done');
    clearTimeout(timer);
    timer = setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1600);
  };
  btn.addEventListener('click', async () => { await copy(getText()); btn.flash(); });
  return btn;
}

// ---------- 格式化 ----------
export const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
export const fmtBig = (b) => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : fmtSize(b);
export const fmtTime = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const fmtMonth = (m) => { const [y, mm] = m.split('-'); return `${y} 年 ${Number(mm)} 月`; };
// 卡片上的日期：今年的只写月日
export const fmtDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()} 年 `}${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};
export const fmtLong = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const isToday = (t) => new Date(t).toDateString() === new Date().toDateString();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const abs = (u) => new URL(u, location.origin).href;
const stem = (n) => (n || 'image').replace(/\.[^.]+$/, '');
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 复制格式（全站共享，切换时通知各处刷新）----------
const FORMATS = [['url', '链接'], ['md', 'Markdown'], ['html', 'HTML']];
let fmt = store.get('darkroom-fmt') || 'md';
const fmtListeners = new Set();

export const getFmt = () => fmt;
export const fmtLabel = () => Object.fromEntries(FORMATS)[fmt];
export function onFmtChange(fn) { fmtListeners.add(fn); return () => fmtListeners.delete(fn); }
export function setFmt(f) {
  fmt = f;
  store.set('darkroom-fmt', f);
  fmtListeners.forEach((fn) => fn(f));
}
// 图片出 ![]() / <img>，其他文件出 []() / <a>
export function formatLink({ url, name, kind = 'image' }, f = fmt) {
  url = abs(url);
  if (kind !== 'image') {
    if (f === 'md') return `[${(name || 'file').replace(/[[\]]/g, '')}](${url})`;
    if (f === 'html') return `<a href="${url}">${escAttr(name || 'file')}</a>`;
    return url;
  }
  if (f === 'md') return `![${stem(name)}](${url})`;
  if (f === 'html') return `<img src="${url}" alt="${escAttr(stem(name))}">`;
  return url;
}

// 文件的扩展名，用作没有缩略图时的标签
export const extLabel = (name) => (String(name || '').match(/\.([a-z0-9]{1,6})$/i)?.[1] || 'file').toUpperCase();

// 一组「链接 / Markdown / HTML」切换按钮，返回取消监听的函数
export function fmtSwitch(container) {
  container.innerHTML = '';
  for (const [f, label] of FORMATS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
    b.dataset.fmt = f;
    b.addEventListener('click', () => setFmt(f));
    container.append(b);
  }
  const sync = () => container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fmt === fmt));
  sync();
  return onFmtChange(sync);
}
