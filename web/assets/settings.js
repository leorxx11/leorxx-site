// 设置：上传压缩选项、通行密钥与登录、API 令牌、用量

import { $, $$, api, copyButton, fmtBig, fmtDay, fmtSwitch, toast } from './lib.js';
import { getUploadPrefs, setUploadPref } from './uploader.js';
import { createPasskey, explain } from './webauthn.js';

const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15.5" r="4.5"/><path d="m11.2 12.3 8.3-8.3M17 6.5l2.5 2.5M14.5 9l2 2"/></svg>';
const TOKEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/></svg>';
const SCOPE_NAMES = { upload: '上传', read: '读取' };

export function init() {
  const prefs = getUploadPrefs();
  const optWebp = $('#opt-webp');
  const optQuality = $('#opt-quality');
  const optWidth = $('#opt-width');
  optWebp.checked = prefs.webp;
  optQuality.value = prefs.quality;
  optWidth.value = String(prefs.maxWidth);
  $('#opt-quality-out').textContent = optQuality.value;
  optWebp.addEventListener('change', () => setUploadPref('darkroom-webp', optWebp.checked ? '1' : '0'));
  optQuality.addEventListener('input', () => {
    $('#opt-quality-out').textContent = optQuality.value;
    setUploadPref('darkroom-q', optQuality.value);
  });
  optWidth.addEventListener('change', () => setUploadPref('darkroom-maxw', optWidth.value));
  fmtSwitch($('[data-fmt-switch]'));

  $('#api-origin').textContent = location.origin;
  $('#api-upload-url').textContent = `${location.origin}/api/v1/upload`;
  $('#api-files-url').textContent = `${location.origin}/api/v1/files`;
  $('#api-mcp-url').textContent = `${location.origin}/api/mcp`;

  for (const slot of $$('[data-copy]')) {
    slot.replaceWith(copyButton(() => $('#' + slot.dataset.copy).textContent, { className: 'btn small' }));
  }

  // ---------- 通行密钥与登录 ----------
  $('#add-passkey').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const options = await api('/api/auth/register/options', { method: 'POST', body: {} });
      const response = await createPasskey(options);
      await api('/api/auth/register/verify', { method: 'POST', body: { response } });
      toast('通行密钥已添加', true);
      loadAuth();
    } catch (err) {
      toast(explain(err));
    } finally {
      btn.disabled = false;
    }
  });
  $('#passkeys').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-delete]');
    if (!b || !confirm(`删掉「${b.dataset.name}」这把通行密钥？那台设备就不能再登录了。`)) return;
    try {
      await api(`/api/passkeys/${encodeURIComponent(b.dataset.delete)}`, { method: 'DELETE' });
      toast('已删除', true);
      loadAuth();
    } catch (err) { toast(err.message); }
  });
  $('#logout-others').addEventListener('click', async () => {
    try {
      const r = await api('/api/auth/logout', { method: 'POST', body: { others: true } });
      toast(r.removed ? `已让其他 ${r.removed} 处登录退出` : '没有其他地方登录着', true);
      loadAuth();
    } catch (err) { toast(err.message); }
  });
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
    window.dispatchEvent(new Event('darkroom:logout'));
  });

  // ---------- API 令牌 ----------
  $('#token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#token-name').value.trim();
    if (!name) { $('#token-name').focus(); return toast('给令牌起个名字'); }
    const scopes = $$('#token-form [name=scope]:checked').map((c) => c.value);
    if (!scopes.length) return toast('至少选一项权限');
    try {
      const { token } = await api('/api/tokens', { method: 'POST', body: { name, scopes } });
      $('#token-name').value = '';
      $('#token-value').textContent = token;
      $('#token-mcp').textContent = `${location.origin}/api/mcp/${token}`;
      $('#token-new').hidden = false;
      loadTokens();
    } catch (err) { toast(err.message); }
  });
  $('#tokens').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-delete]');
    if (!b || !confirm(`吊销令牌「${b.dataset.name}」？用它的程序和 AI 会立刻失去访问权限。`)) return;
    try {
      await api(`/api/tokens/${encodeURIComponent(b.dataset.delete)}`, { method: 'DELETE' });
      toast('已吊销', true);
      loadTokens();
    } catch (err) { toast(err.message); }
  });
}

export function enter() {
  loadAuth();
  loadTokens();
  loadUsage();
}

export function leave() {
  // 新令牌只显示一次，离开设置页就收起来
  $('#token-new').hidden = true;
  $('#token-value').textContent = '';
  $('#token-mcp').textContent = '';
}

// 一行：图标、名字（可带权限小标签）、说明、右侧操作按钮
function row({ icon, name, chips = [], note, action }) {
  const li = document.createElement('li');
  li.className = 'row';
  li.innerHTML = `<span class="ri">${icon}</span><div><b></b><small></small></div>`;
  const b = li.querySelector('b');
  b.textContent = name;
  for (const c of chips) b.append(Object.assign(document.createElement('span'), { className: 'chip', textContent: c }));
  li.querySelector('small').textContent = note;
  if (action) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'textbtn danger', textContent: action.label });
    btn.dataset.delete = action.id;
    btn.dataset.name = name;
    li.append(btn);
  }
  return li;
}

const emptyRow = (text) => Object.assign(document.createElement('li'), { className: 'row none', textContent: text });
const used = (t) => (t ? `最近使用 ${fmtDay(t)}` : '从未使用');

async function loadAuth() {
  try {
    const { passkeys, sessions } = await api('/api/passkeys');
    $('#passkeys').replaceChildren(...passkeys.map((p) => row({
      icon: KEY_ICON,
      name: p.name || '通行密钥',
      note: `添加于 ${fmtDay(p.created_at)} · ${used(p.last_used_at)}`,
      action: passkeys.length > 1 ? { label: '删除', id: p.id } : null,
    })));
    $('#session-count').textContent = `${sessions} 处登录着`;
  } catch (err) { toast(err.message); }
}

async function loadTokens() {
  try {
    const { tokens } = await api('/api/tokens');
    $('#tokens').replaceChildren(...(tokens.length ? tokens.map((t) => row({
      icon: TOKEN_ICON,
      name: t.name,
      chips: t.scopes.split(',').map((s) => SCOPE_NAMES[s] || s),
      note: `创建于 ${fmtDay(t.created_at)} · ${used(t.last_used_at)}`,
      action: { label: '吊销', id: t.id },
    })) : [emptyRow('还没有令牌')]));
  } catch (err) { toast(err.message); }
}

const pctOf = (bytes, total) => Math.min(100, (bytes / total) * 100);
const fmtPct = (p) => (p === 0 ? '0%' : p < 0.1 ? '不到 0.1%' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);
const fmtQuota = (b) => (b % 1024 ** 3 === 0 ? `${b / 1024 ** 3} GB` : fmtBig(b));
// 用得很少时也留一小截（4px），不然进度条看着是空的
const barWidth = (bytes, pct) => (bytes ? `max(4px, ${pct}%)` : '0px');

async function loadUsage() {
  try {
    const st = await api('/api/stats');
    $('#usage').textContent = `${st.count} 个文件 · ${fmtBig(st.bytes)}${st.trashCount ? ` · 回收站 ${st.trashCount} 项 ${fmtBig(st.trashBytes)}` : ''}`;
    const used = pctOf(st.bytes, st.quotaBytes);
    const trash = pctOf(st.trashBytes, st.quotaBytes);
    $('#usage-cap').textContent = `${fmtPct(used + trash)} · 共 ${fmtQuota(st.quotaBytes)}`;
    const meter = $('#usage-meter');
    meter.setAttribute('aria-valuenow', (used + trash).toFixed(2));
    meter.querySelector('.m-used').style.width = barWidth(st.bytes, used);
    meter.querySelector('.m-trash').style.width = barWidth(st.trashBytes, trash);
  } catch (err) { toast(err.message); }
}
