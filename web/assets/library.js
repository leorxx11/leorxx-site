// 列表：按月分组的卡片、详情页（图片、文本、PDF、音视频预览）、多选、回收站
// 列表和画布是同一批文件，只是换个方式看
// 详情页的地址是 #library/<id>，浏览器的返回键可以关掉它

import {
  $, $$, CHECK, api, copy, copyButton, esc, fmtBig, fmtDay, fmtLong, fmtMonth, fmtSize, fmtSwitch,
  formatLink, getFmt, isToday, onFmtChange, toast, transition,
} from './lib.js';
import { placeholder, renderPreview } from './preview.js';

const DAY = 864e5;
const view = $('#view-library');
const list = $('#lib-list');
const detail = $('#lib-detail');
const groups = $('#groups');
const selbar = $('#selbar');

let mode = 'sheet';          // sheet：底片；trash：废纸篓
let items = [];              // 当前已加载、按显示顺序排好的文件
let monthCounts = new Map(); // 月份 -> 张数
let cursor = null;
let loading = false;
let stale = true;            // 有新上传等变化，下次进来要重新加载
let loadToken = 0;
let stats = null;
let multi = false;
const picked = new Set();
let currentId = null;        // 正在看详情的那张
let pendingOpen = null;      // 地址里带着 id，但列表还没加载好
let pushedDetail = false;    // 详情是从列表点进来的（返回键能回到列表）
let listScroll = 0;
let unsubDetailFmt = null;

// 手绘的圈，圈住“新”
const NEW_MARK = '<svg viewBox="0 0 62 40" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M31 36.6C41 37.4 54 34.6 57.6 25.4 61 15.6 50.6 5.4 33.6 4.4 17.6 3.6 4.6 9.2 3.6 19 2.8 28.4 14.8 35.8 32.4 36.4 40 36.6 47.4 35.2 52.6 32.6"/></svg>';
const BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.25 12H4.75M9.17 16.42 4.75 12l4.42-4.42"/></svg>';

export function init() {
  $('#lib-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
  });

  let qTimer;
  $('#lib-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(reload, 250); });
  $('#lib-month').addEventListener('change', reload);
  $('#lib-kind').addEventListener('change', reload);

  $('#lib-multi').addEventListener('click', () => setMulti(!multi));
  $('#sel-cancel').addEventListener('click', () => setMulti(false));
  $('#sel-copy').addEventListener('click', copyPicked);
  $('#sel-trash').addEventListener('click', () => moveToTrash([...picked]));
  $('#sel-restore').addEventListener('click', () => restore([...picked]));
  $('#sel-purge').addEventListener('click', () => purge([...picked]));
  $('#trash-empty').addEventListener('click', () => purge(null));

  groups.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (multi) {
      picked.has(id) ? picked.delete(id) : picked.add(id);
      card.setAttribute('aria-pressed', picked.has(id));
      $('#sel-count').textContent = picked.size;
    } else {
      pushedDetail = true;
      location.hash = `library/${id}`;
    }
  });
  // 缩略图加载完再淡入
  const loaded = (e) => { if (e.target.tagName === 'IMG') e.target.classList.remove('loading'); };
  groups.addEventListener('load', loaded, true);
  groups.addEventListener('error', loaded, true);

  // 滚到底自动加载下一页
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && mode === 'sheet' && cursor && !loading && currentId === null) loadPage();
  }, { rootMargin: '600px' }).observe($('#sentinel'));

  document.addEventListener('keydown', (e) => {
    if (view.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) {
      if (e.key === 'Escape' && e.target.id === 'lib-q') e.target.blur();
      return;
    }
    if (currentId !== null) {
      if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'Escape') closeDetail();
    } else if (e.key === '/' && mode === 'sheet') {
      e.preventDefault();
      $('#lib-q').focus();
    } else if (e.key === 'Escape' && multi) {
      setMulti(false);
    }
  });

  window.addEventListener('darkroom:changed', () => { stale = true; });
}

// 进入列表，或者地址在 #library 和 #library/<id> 之间变化
export function enter(arg, viewChanged) {
  const id = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  if (stale) {
    pendingOpen = id;
    if (currentId !== null) hideDetailNow();
    reload();
    return;
  }
  if (id !== null && id !== currentId) {
    currentId === null ? showDetail(id, !viewChanged) : (currentId = id, renderDetail());
  } else if (id === null && currentId !== null) {
    hideDetail(!viewChanged);
  }
}

export function leave() {
  setMulti(false);
}

// ---------- 加载 ----------
async function reload() {
  stale = false;
  const token = ++loadToken;
  items = [];
  cursor = null;
  if (multi) setMulti(false);
  try {
    const [st, months] = await Promise.all([api('/api/stats'), mode === 'sheet' ? api('/api/images/months') : null]);
    if (token !== loadToken) return;
    setStats(st);
    if (months) {
      monthCounts = new Map(months.months.map((m) => [m.month, m.count]));
      const sel = $('#lib-month');
      const keep = sel.value;
      sel.innerHTML = '<option value="">全部月份</option>' + months.months
        .map((m) => `<option value="${esc(m.month)}">${fmtMonth(m.month)}（${m.count}）</option>`).join('');
      sel.value = monthCounts.has(keep) ? keep : '';
    }
    if (mode === 'sheet') {
      await loadPage(token, true);
    } else {
      const data = await api('/api/trash');
      if (token !== loadToken) return;
      items = data.items;
      renderList(items, true);
    }
    if (token !== loadToken) return;
    openPending();
  } catch (err) {
    toast(err.message);
  }
}

async function loadPage(token = loadToken, reset = false) {
  loading = true;
  try {
    const params = new URLSearchParams({ limit: '60' });
    const q = $('#lib-q').value.trim();
    if (q) params.set('q', q);
    if ($('#lib-month').value) params.set('month', $('#lib-month').value);
    if ($('#lib-kind').value) params.set('kind', $('#lib-kind').value);
    if (cursor) params.set('cursor', cursor);
    const data = await api(`/api/images?${params}`);
    if (token !== loadToken) return;
    items = items.concat(data.items);
    cursor = data.nextCursor;
    renderList(data.items, reset);
  } catch (err) {
    toast(err.message);
  } finally {
    loading = false;
  }
}

// 地址里带着某张底片的 id：列表加载好以后打开它；找不到就留在列表
function openPending() {
  const id = pendingOpen;
  pendingOpen = null;
  if (id === null) return;
  if (items.some((x) => x.id === id)) showDetail(id, false);
  else history.replaceState(null, '', '#library');
}

function setStats(st) {
  stats = st;
  $('#trash-count').textContent = st.trashCount ? String(st.trashCount) : '';
  $('#trash-days').textContent = st.trashDays;
}

async function refreshStats() {
  try { setStats(await api('/api/stats')); } catch {}
}

// ---------- 列表 ----------
const daysLeft = (it) => Math.max(0, Math.ceil((it.purgeAt - Date.now()) / DAY));
const isFiltered = () => $('#lib-q').value.trim() !== '' || $('#lib-kind').value !== '';

function cardHtml(it) {
  const right = mode === 'trash'
    ? `<span class="left${daysLeft(it) <= 3 ? ' soon' : ''}">还剩 ${daysLeft(it)} 天</span>`
    : `<time datetime="${new Date(it.createdAt).toISOString()}">${fmtDay(it.createdAt)}</time>`;
  const media = it.thumb ? `<img class="loading" loading="lazy" decoding="async" alt="" src="${esc(it.thumb)}">` : placeholder(it);
  const isNew = mode === 'sheet' && isToday(it.createdAt) ? `<span class="new">新${NEW_MARK}</span>` : '';
  return `<li data-id="${it.id}"><button type="button" class="card" data-id="${it.id}" aria-pressed="${picked.has(it.id)}">
    <span class="media">${media}<span class="tick">${CHECK}</span></span>
    <span class="cap"><span class="nm"><span title="${esc(it.name)}">${esc(it.name || '未命名')}</span>${isNew}</span>${right}</span>
  </button></li>`;
}

// 加载下一页时只追加，已经显示的卡片不动
function renderList(newItems, reset) {
  if (reset) groups.innerHTML = '';
  view.classList.toggle('trash', mode === 'trash');
  for (const it of newItems) {
    const key = mode === 'trash' ? 'trash' : it.month;
    let ul = groups.querySelector(`.group[data-month="${key}"] .cards`);
    if (!ul) {
      const sec = document.createElement('section');
      sec.className = 'group';
      sec.dataset.month = key;
      sec.innerHTML = `${mode === 'trash' ? '' : `<h3 class="ghead">${fmtMonth(key)}<small></small></h3>`}<ul class="cards"></ul>`;
      groups.append(sec);
      ul = sec.querySelector('.cards');
    }
    ul.insertAdjacentHTML('beforeend', cardHtml(it));
  }
  // 已经在缓存里的缩略图不用等淡入
  for (const img of groups.querySelectorAll('img.loading')) if (img.complete) img.classList.remove('loading');
  updateCounts();
}

function updateCounts() {
  const filtered = isFiltered();
  for (const sec of groups.querySelectorAll('.group')) {
    const n = sec.querySelectorAll('.card').length;
    if (!n) { sec.remove(); continue; }
    const small = sec.querySelector('.ghead small');
    if (small) small.textContent = filtered ? `${n} 项匹配` : `${monthCounts.get(sec.dataset.month) ?? n} 项`;
  }
  const empty = $('#lib-empty');
  empty.hidden = items.length > 0;
  empty.textContent = mode === 'trash' ? '回收站是空的。'
    : isFiltered() || $('#lib-month').value ? '没有找到匹配的文件。' : '还没有传过文件，去画布上拖一张进来吧。';
  $('#trash-tools').hidden = mode !== 'trash' || items.length === 0;
}

// ---------- 详情 ----------
// 打开：缩略图“长”成大图；关上：大图缩回卡片，列表回到原来的位置
function showDetail(id, morph) {
  const it = items.find((x) => x.id === id);
  if (!it) { history.replaceState(null, '', '#library'); return; }
  if (multi) setMulti(false);
  listScroll = scrollY;
  const from = morph ? groups.querySelector(`.card[data-id="${id}"] .media`) : null;
  if (from) from.style.viewTransitionName = 'shot';
  const run = () => {
    if (from) from.style.viewTransitionName = '';
    currentId = id;
    renderDetail();
    list.hidden = true;
    detail.hidden = false;
    if (from) $('.dmedia', detail).style.viewTransitionName = 'shot';
    scrollTo({ top: 0 });
  };
  (morph ? transition(run) : (run(), Promise.resolve())).then(() => {
    const m = $('.dmedia', detail);
    if (m) m.style.viewTransitionName = '';
  });
}

function hideDetail(morph) {
  const id = currentId;
  const from = morph ? $('.dmedia', detail) : null;
  if (from) from.style.viewTransitionName = 'shot';
  let to = null;
  const run = () => {
    if (from) from.style.viewTransitionName = '';
    hideDetailNow();
    scrollTo({ top: listScroll });
    to = groups.querySelector(`.card[data-id="${id}"] .media`);
    if (to) {
      const r = to.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) to.scrollIntoView({ block: 'center' });
      if (from) to.style.viewTransitionName = 'shot';
    }
  };
  (morph ? transition(run) : (run(), Promise.resolve())).then(() => { if (to) to.style.viewTransitionName = ''; });
}

function hideDetailNow() {
  unsubDetailFmt?.();
  unsubDetailFmt = null;
  currentId = null;
  pushedDetail = false;
  detail.hidden = true;
  detail.innerHTML = '';
  list.hidden = false;
}

function closeDetail() {
  if (pushedDetail) history.back();
  else location.replace('#library');
}

function renderDetail() {
  unsubDetailFmt?.();
  unsubDetailFmt = null;
  const it = items.find((x) => x.id === currentId);
  if (!it) return;
  const index = items.indexOf(it);
  const sizes = it.originalSize && it.originalSize !== it.size
    ? `${fmtSize(it.size)}（原 ${fmtSize(it.originalSize)}）` : fmtSize(it.size);
  const dims = it.width && it.height ? `${it.width} × ${it.height} · ` : '';
  detail.innerHTML = `
    <button type="button" class="back" id="d-back">${BACK}${mode === 'trash' ? '回收站' : '列表'}</button>
    <div class="detail">
      <div class="dmedia ${it.kind}"></div>
      <div class="dinfo">
        <h2></h2>
        <p class="facts">${dims}${sizes}<br>${fmtLong(it.createdAt)} 上传${mode === 'trash' ? `<br>还剩 ${daysLeft(it)} 天彻底删除` : ''}</p>
        ${mode === 'sheet' ? '<div class="fmtrow">复制为 <span class="seg"></span></div><pre class="code"></pre>' : ''}
        <div class="dacts"></div>
        <div class="dnav">
          <button type="button" class="textbtn" data-step="-1" ${index <= 0 ? 'disabled' : ''}>← 上一项</button>
          <span>${index + 1} / ${items.length}${mode === 'sheet' && cursor ? '+' : ''}</span>
          <button type="button" class="textbtn" data-step="1" ${index >= items.length - 1 && !(mode === 'sheet' && cursor) ? 'disabled' : ''}>下一项 →</button>
        </div>
        <p class="keys"><kbd>←</kbd> <kbd>→</kbd> 切换　<kbd>Esc</kbd> 返回</p>
      </div>
    </div>`;
  renderPreview($('.dmedia', detail), it);
  $('h2', detail).textContent = it.name || '未命名';
  $('#d-back').addEventListener('click', closeDetail);
  $$('[data-step]', detail).forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step))));

  const acts = $('.dacts', detail);
  const grow = () => Object.assign(document.createElement('span'), { className: 'grow' });
  if (mode === 'sheet') {
    const code = $('.code', detail);
    const sync = () => { code.textContent = formatLink(it); };
    sync();
    const offSwitch = fmtSwitch($('.fmtrow .seg', detail));
    const offSync = onFmtChange(sync);
    unsubDetailFmt = () => { offSwitch(); offSync(); };
    const open = Object.assign(document.createElement('a'), {
      className: 'textbtn', href: it.url, target: '_blank', rel: 'noopener',
      textContent: `${it.kind === 'image' ? '看原图' : it.kind === 'other' ? '下载' : '打开'} ↗`,
    });
    const toDesk = textButton('在画布上找到', () => { location.hash = `desk/${it.id}`; });
    acts.append(copyButton(() => code.textContent, { className: 'btn primary' }), open, toDesk, grow(), textButton('移入回收站', () => moveToTrash([it.id]), true));
  } else {
    const back = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: '恢复' });
    back.addEventListener('click', () => restore([it.id]));
    acts.append(back, grow(), textButton('彻底删除', () => purge([it.id]), true));
  }
}

function textButton(text, onClick, danger = false) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: danger ? 'textbtn danger' : 'textbtn', textContent: text });
  b.addEventListener('click', onClick);
  return b;
}

// 左右切换不新增历史记录，返回键仍然回到列表
async function step(delta) {
  if (currentId === null) return;
  let next = items.findIndex((x) => x.id === currentId) + delta;
  if (next >= items.length && mode === 'sheet' && cursor && !loading) await loadPage();
  next = Math.max(0, Math.min(items.length - 1, next));
  const id = items[next]?.id;
  if (id === undefined || id === currentId) return;
  currentId = id;
  history.replaceState(null, '', `#library/${id}`);
  renderDetail();
}

// ---------- 模式、多选 ----------
function setMode(m) {
  mode = m;
  view.classList.toggle('trash', m === 'trash');
  $$('#lib-mode button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === m));
  setMulti(false);
  transition(() => { groups.innerHTML = ''; items = []; updateCounts(); $('#lib-empty').hidden = true; });
  reload();
}

function setMulti(on) {
  multi = on;
  picked.clear();
  $('#sel-count').textContent = 0;
  $('#lib-multi').textContent = on ? '完成' : '选择';
  groups.classList.toggle('selecting', on);
  groups.querySelectorAll('.card').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  selbar.classList.toggle('trash', mode === 'trash');
  selbar.classList.toggle('show', on);
  document.body.classList.toggle('has-selbar', on);
}

async function copyPicked() {
  if (!picked.size) { toast('先选几张'); return; }
  const text = items.filter((x) => picked.has(x.id)).map((x) => formatLink(x, getFmt())).join('\n');
  await copy(text);
  toast(`已复制 ${picked.size} 条`, true);
}

// 删除 / 恢复后：卡片从列表里拿掉；正在看详情的话，换到相邻的一张，方便连续处理
function afterRemove(ids) {
  const gone = new Set(ids);
  const i = items.findIndex((x) => x.id === currentId);
  for (const it of items) {
    if (!gone.has(it.id)) continue;
    groups.querySelector(`li[data-id="${it.id}"]`)?.remove();
    if (mode === 'sheet' && monthCounts.has(it.month)) monthCounts.set(it.month, monthCounts.get(it.month) - 1);
  }
  items = items.filter((x) => !gone.has(x.id));
  if (multi) setMulti(false);
  updateCounts();
  refreshStats();
  if (currentId !== null && gone.has(currentId)) {
    const next = items[Math.min(i, items.length - 1)];
    if (next) {
      currentId = next.id;
      history.replaceState(null, '', `#library/${next.id}`);
      transition(renderDetail);
    } else {
      closeDetail();
    }
  }
}

async function moveToTrash(ids) {
  if (!ids.length) { toast('先选几项'); return; }
  try {
    await api('/api/images/trash', { method: 'POST', body: { ids } });
    afterRemove(ids);
    window.dispatchEvent(new Event('darkroom:changed'));
    toast(`已移入回收站，${stats?.trashDays ?? 30} 天内可以恢复`, true);
  } catch (err) { toast(err.message); }
}

async function restore(ids) {
  if (!ids.length) { toast('先选几项'); return; }
  try {
    const r = await api('/api/trash/restore', { method: 'POST', body: { ids } });
    afterRemove(ids.filter((id) => !r.conflicts.includes(id)));
    window.dispatchEvent(new Event('darkroom:changed'));
    if (r.conflicts.length) toast(`恢复了 ${r.restored} 项；${r.conflicts.length} 项后来又传过一次，没法恢复`);
    else toast(`恢复了 ${r.restored} 项`, true);
  } catch (err) { toast(err.message); }
}

async function purge(ids) {
  if (ids && !ids.length) { toast('先选几张'); return; }
  const what = ids ? `这 ${ids.length} 张` : '废纸篓里的全部文件';
  if (!confirm(`彻底删除${what}？删掉就找不回来了。`)) return;
  try {
    const r = await api('/api/trash/purge', { method: 'POST', body: ids ? { ids } : {} });
    afterRemove(ids || items.map((x) => x.id));
    toast(`彻底删除了 ${r.purged} 张`, true);
  } catch (err) { toast(err.message); }
}
