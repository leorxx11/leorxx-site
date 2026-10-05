// 各个页面共用的小工具

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 请求 ----------
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const isJson = body !== undefined && !(body instanceof Blob);
  const r = await fetch(path, {
    method,
    headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
  if (!r.ok) throw new Error(data?.error || `出错了（${r.status}）`);
  return data;
}

// ---------- 提示与复制 ----------
let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

// 复制按钮：点完短暂变成「已复制 ✓」
export function copyButton(getText, label = '复制') {
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: label });
  let timer;
  btn.flash = () => {
    btn.textContent = '已复制 ✓'; btn.classList.add('done');
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
export function formatLink(url, name, f = fmt) {
  url = abs(url);
  if (f === 'md') return `![${stem(name)}](${url})`;
  if (f === 'html') return `<img src="${url}" alt="${escAttr(stem(name))}">`;
  return url;
}

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
