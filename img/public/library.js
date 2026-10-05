// 底片库：按月分组的缩略图、详情面板、多选、废纸篓

import {
  $, api, copy, copyButton, fmtBig, fmtMonth, fmtSize, fmtSwitch, fmtTime, formatLink, getFmt, onFmtChange, toast,
} from './lib.js';

const DAY = 864e5;
const view = $('#view-library');
const detail = $('#detail');

let mode = 'sheet';          // sheet：底片；trash：废纸篓
let items = [];              // 当前已加载、按显示顺序排好的图片
let monthCounts = new Map(); // 月份 -> 张数
let cursor = null;
let loading = false;
let stale = true;            // 有新上传等变化，下次进来要重新加载
let currentId = null;
let multi = false;
const picked = new Set();
let stats = null;
let unsubDetailFmt = null;
let loadToken = 0;

export function init() {
  $('#lib-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
  });

  let qTimer;
  $('#lib-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(reload, 250); });
  $('#lib-month').addEventListener('change', reload);

  $('#lib-multi').addEventListener('click', () => setMulti(!multi));
  $('#sel-cancel').addEventListener('click', () => setMulti(false));
  $('#sel-copy').addEventListener('click', copyPicked);
  $('#sel-trash').addEventListener('click', () => moveToTrash([...picked]));
  $('#sel-restore').addEventListener('click', () => restore([...picked]));
  $('#sel-purge').addEventListener('click', () => purge([...picked]));
  $('#trash-empty').addEventListener('click', () => purge(null));

  $('#groups').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const id = Number(cell.dataset.id);
    if (multi) {
      picked.has(id) ? picked.delete(id) : picked.add(id);
      cell.setAttribute('aria-pressed', picked.has(id));
      $('#sel-count').textContent = picked.size;
    } else {
      select(id);
    }
  });

  // 滚到底自动加载下一页
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && mode === 'sheet' && cursor && !loading) loadPage();
  }, { rootMargin: '400px' }).observe($('#sentinel'));

  document.addEventListener('keydown', (e) => {
    if (view.hidden || (e.target instanceof Element && e.target.closest('input, select, textarea'))) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'Escape') select(null);
  });

  window.addEventListener('darkroom:changed', () => { stale = true; });
}

export function enter() {
  if (stale) reload();
}

// ---------- 加载 ----------
async function reload() {
  stale = false;
  const token = ++loadToken;
  items = [];
  cursor = null;
  picked.clear();
  $('#sel-count').textContent = 0;
  try {
    const [st, months] = await Promise.all([api('/api/stats'), mode === 'sheet' ? api('/api/images/months') : null]);
    if (token !== loadToken) return;
    stats = st;
    $('#trash-count').textContent = st.trashCount ? `（${st.trashCount}）` : '';
    $('#trash-days').textContent = st.trashDays;
    if (months) {
      monthCounts = new Map(months.months.map((m) => [m.month, m.count]));
      const sel = $('#lib-month');
      const keep = sel.value;
      sel.innerHTML = '<option value="">全部月份</option>' + months.months
        .map((m) => `<option value="${m.month}">${fmtMonth(m.month)}（${m.count}）</option>`).join('');
      sel.value = monthCounts.has(keep) ? keep : '';
    }
    if (mode === 'sheet') {
      await loadPage(token);
    } else {
      const data = await api('/api/trash');
      if (token !== loadToken) return;
      items = data.items;
      render();
    }
  } catch (err) {
    toast(err.message);
  }
}

async function loadPage(token = loadToken) {
  loading = true;
  try {
    const params = new URLSearchParams({ limit: '60' });
    const q = $('#lib-q').value.trim();
    if (q) params.set('q', q);
    if ($('#lib-month').value) params.set('month', $('#lib-month').value);
    if (cursor) params.set('cursor', cursor);
    const data = await api(`/api/images?${params}`);
    if (token !== loadToken) return;
    items = items.concat(data.items);
    cursor = data.nextCursor;
    render();
  } catch (err) {
    toast(err.message);
  } finally {
    loading = false;
  }
}

// ---------- 渲染 ----------
const daysLeft = (it) => Math.max(0, Math.ceil((it.purgeAt - Date.now()) / DAY));

function cellHtml(it) {
  const label = mode === 'trash' ? `<span class="left">还剩 ${daysLeft(it)} 天</span>` : '';
  return `<button type="button" class="cell" data-id="${it.id}" aria-label="${it.name ? '' : '未命名'}"
    aria-current="${it.id === currentId}" aria-pressed="${picked.has(it.id)}">
    <img loading="lazy" alt="" src="${it.thumb}"><span class="tick"></span>${label}</button>`;
}

function render() {
  const groups = $('#groups');
  const filtered = $('#lib-q').value.trim() !== '';
  if (mode === 'trash') {
    groups.innerHTML = items.length ? `<section class="group"><div class="grid">${items.map(cellHtml).join('')}</div></section>` : '';
  } else {
    const byMonth = new Map();
    for (const it of items) {
      if (!byMonth.has(it.month)) byMonth.set(it.month, []);
      byMonth.get(it.month).push(it);
    }
    groups.innerHTML = [...byMonth].map(([m, list]) => `
      <section class="group">
        <h3>${fmtMonth(m)}<small>${filtered ? `${list.length} 张匹配` : `${monthCounts.get(m) ?? list.length} 张`}</small></h3>
        <div class="grid">${list.map(cellHtml).join('')}</div>
      </section>`).join('');
  }
  // 补上文件名作为无障碍标签（不经过 innerHTML，避免转义问题）
  for (const cell of groups.querySelectorAll('.cell')) {
    const it = items.find((x) => x.id === Number(cell.dataset.id));
    if (it?.name) cell.setAttribute('aria-label', it.name);
  }
  groups.classList.toggle('multi', multi);

  const empty = $('#lib-empty');
  empty.hidden = items.length > 0;
  empty.textContent = mode === 'trash' ? '废纸篓是空的。'
    : filtered || $('#lib-month').value ? '没有找到匹配的底片。' : '还没有冲洗过照片，去冲洗台传一张吧。';
  $('#trash-tools').hidden = mode !== 'trash' || items.length === 0;

  if (currentId && !items.some((x) => x.id === currentId)) currentId = null;
  renderDetail();
}

function renderDetail() {
  unsubDetailFmt?.();
  unsubDetailFmt = null;
  const it = items.find((x) => x.id === currentId);
  detail.classList.toggle('open', !!it);
  if (!it) {
    detail.innerHTML = stats ? `<p class="hint">点一张底片看详情。<br>
      共 ${stats.count} 张 · ${fmtBig(stats.bytes)}${stats.trashCount ? ` · 废纸篓 ${stats.trashCount} 张` : ''}</p>` : '';
    return;
  }

  const index = items.indexOf(it);
  const sizes = it.originalSize && it.originalSize !== it.size
    ? `${fmtSize(it.size)}（原 ${fmtSize(it.originalSize)}）` : fmtSize(it.size);
  const dims = it.width && it.height ? `${it.width} × ${it.height} · ` : '';
  detail.innerHTML = `
    <button type="button" class="link close">关闭</button>
    <div class="preview"><img alt=""></div>
    <h4></h4>
    <p class="facts">${dims}${sizes}<br>${fmtTime(it.createdAt)} 冲洗${mode === 'trash' ? `<br>${daysLeft(it)} 天后彻底删除` : ''}</p>
    ${mode === 'sheet' ? '<div class="fmt">复制为 <span class="seg"></span></div><pre class="code"></pre>' : ''}
    <div class="actions"></div>
    <div class="nav">
      <button type="button" class="link" data-step="-1">← 上一张</button>
      <span>${index + 1} / ${items.length}${mode === 'sheet' && cursor ? '+' : ''}</span>
      <button type="button" class="link" data-step="1">下一张 →</button>
    </div>`;
  detail.querySelector('.preview img').src = it.url;
  detail.querySelector('h4').textContent = it.name || '未命名';
  detail.querySelector('.close').addEventListener('click', () => select(null));
  detail.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step))));

  const actions = detail.querySelector('.actions');
  if (mode === 'sheet') {
    const code = detail.querySelector('.code');
    const sync = () => { code.textContent = formatLink(it.url, it.name); };
    sync();
    const offSwitch = fmtSwitch(detail.querySelector('.fmt .seg'));
    const offSync = onFmtChange(sync);
    unsubDetailFmt = () => { offSwitch(); offSync(); };
    actions.append(copyButton(() => code.textContent));
    const open = Object.assign(document.createElement('a'), { className: 'link', href: it.url, target: '_blank', rel: 'noopener', textContent: '看原图' });
    actions.append(open, button('移到废纸篓', () => moveToTrash([it.id]), true));
  } else {
    actions.append(button('恢复', () => restore([it.id])), button('彻底删除', () => purge([it.id]), true));
  }
}

function button(text, onClick, danger = false) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: danger ? 'link danger' : 'link', textContent: text });
  b.addEventListener('click', onClick);
  return b;
}

// ---------- 交互 ----------
function select(id) {
  currentId = id;
  for (const cell of $('#groups').querySelectorAll('.cell')) {
    cell.setAttribute('aria-current', Number(cell.dataset.id) === id);
  }
  renderDetail();
}

async function step(delta) {
  if (!currentId) return;
  const i = items.findIndex((x) => x.id === currentId);
  let next = i + delta;
  if (next >= items.length && mode === 'sheet' && cursor && !loading) {
    await loadPage();
  }
  next = Math.max(0, Math.min(items.length - 1, next));
  select(items[next]?.id ?? null);
  $(`.cell[data-id="${currentId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setMode(m) {
  mode = m;
  view.classList.toggle('trash', m === 'trash');
  $('#lib-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === m));
  $('#lib-q').hidden = $('#lib-month').hidden = m === 'trash';
  currentId = null;
  setMulti(false);
  reload();
}

function setMulti(on) {
  multi = on;
  picked.clear();
  $('#sel-count').textContent = 0;
  $('#selbar').hidden = !on;
  $('#lib-multi').textContent = on ? '完成' : '多选';
  $('#groups').classList.toggle('multi', on);
  $('#groups').querySelectorAll('.cell').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  if (on) select(null);
}

async function copyPicked() {
  if (!picked.size) { toast('先选几张'); return; }
  const text = items.filter((x) => picked.has(x.id)).map((x) => formatLink(x.url, x.name, getFmt())).join('\n');
  await copy(text);
  toast(`已复制 ${picked.size} 条`);
}

// 删除 / 恢复后，把选中项挪到相邻的一张，方便连续处理
function afterRemove(ids) {
  const gone = new Set(ids);
  const i = items.findIndex((x) => x.id === currentId);
  items = items.filter((x) => !gone.has(x.id));
  if (gone.has(currentId)) currentId = items[Math.min(i, items.length - 1)]?.id ?? null;
  if (multi) setMulti(false);
  stale = false;
  render();
  api('/api/stats').then((st) => {
    stats = st;
    $('#trash-count').textContent = st.trashCount ? `（${st.trashCount}）` : '';
    if (!currentId) renderDetail();
  }).catch(() => {});
}

async function moveToTrash(ids) {
  if (!ids.length) { toast('先选几张'); return; }
  try {
    await api('/api/images/trash', { method: 'POST', body: { ids } });
    afterRemove(ids);
    toast(`已移到废纸篓，${stats?.trashDays ?? 30} 天内可以恢复`);
  } catch (err) { toast(err.message); }
}

async function restore(ids) {
  if (!ids.length) { toast('先选几张'); return; }
  try {
    const r = await api('/api/trash/restore', { method: 'POST', body: { ids } });
    afterRemove(ids.filter((id) => !r.conflicts.includes(id)));
    toast(r.conflicts.length ? `恢复了 ${r.restored} 张；${r.conflicts.length} 张后来又传过一次，没法恢复` : `恢复了 ${r.restored} 张`);
    window.dispatchEvent(new Event('darkroom:changed'));
    stale = false;
  } catch (err) { toast(err.message); }
}

async function purge(ids) {
  if (ids && !ids.length) { toast('先选几张'); return; }
  const what = ids ? `这 ${ids.length} 张` : '废纸篓里的全部图片';
  if (!confirm(`彻底删除${what}？删掉就找不回来了。`)) return;
  try {
    const r = await api('/api/trash/purge', { method: 'POST', body: ids ? { ids } : {} });
    afterRemove(ids || items.map((x) => x.id));
    toast(`彻底删除了 ${r.purged} 张`);
  } catch (err) { toast(err.message); }
}
