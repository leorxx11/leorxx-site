// 全屏无限画布视图（#desk）：文件卡片散落与拖拽、便签、分区框、连线、手写批注、小地图、多步撤销与自动同步
// 访客（没登录）只能看：可以平移缩放、选中复制、预览，也能在本地拖动卡片，但什么都不保存

import {
  $, api, copy, copyButton, esc, extLabel, fmtLabel, fmtLong, fmtSize, fmtSwitch, formatLink, getFmt, isGuest, onFmtChange, store, toast,
} from './lib.js';
import { LAYOUTS } from './layouts.js';
import { renderPreview } from './preview.js';
import { normalizeFileName, uploadFileToDesk } from './uploader.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let inited = false;
let stale = true;
let active = false;

// 画布数据：files 来自 /api/desk 的 images 表（key 为 'f:<id>'），notes/frames/connectors/strokes 来自 board
// 画布和列表是同一批文件：没进回收站的都在桌上
let files = [];
let notes = [];
let frames = [];
let connectors = [];
let strokes = [];
let zTop = 10;

// 文本卡片预览缓存（fileId -> string）
const textCache = new Map();

// 相机与交互工具状态
let panX = 0;
let panY = 0;
let zoom = 1;
let cameraReady = false;
let tool = 'select';
let penColor = 'ink';
let spaceHeld = false;
let flyAnim = null;
let pendingFocusId = null;

// 选中集合：卡片 key 形如 'f:12' 或 'n_abc'
const selectedKeys = new Set();
let selectedFrameId = null;
let selectedConnId = null;
let selectedStrokeId = null;

// 撤销重做栈与防抖自动保存
const history = [];
let histIdx = -1;
const dirtyFileIds = new Set();
const trashedIds = new Set(); // 已移进回收站的文件，撤销时不再摆回画布
let dirtyBoard = false;
let saveTimer = null;
// 方向键连按时不每一下都记一步撤销：停手 0.4 秒后合成一步
let nudgeTimer = null;

const isDark = () => (document.documentElement.dataset.theme
  ? document.documentElement.dataset.theme === 'dark'
  : matchMedia('(prefers-color-scheme: dark)').matches);
const resolveStrokeColor = (c) => (c === 'ink' ? (isDark() ? '#ededef' : '#18181b') : c);
const toWorld = (sx, sy) => ({ x: (sx - panX) / zoom, y: (sy - panY) / zoom });

// 统一获取画布上所有卡片实体（文件 + 便签），用于定位、连线和小地图
function allCards() {
  const out = [];
  for (const f of files) out.push({ key: `f:${f.id}`, isNote: false, data: f, x: f.x, y: f.y, w: f.w || defaultWidth(f.kind), rot: f.rot || 0, z: f.z || 1 });
  for (const n of notes) out.push({ key: n.id, isNote: true, data: n, x: n.x, y: n.y, w: n.w || 204, rot: n.rot || 0, z: n.z || 1 });
  return out;
}

function findCard(key) {
  if (key.startsWith('f:')) {
    const id = Number(key.slice(2));
    const f = files.find((x) => x.id === id);
    return f ? { key, isNote: false, data: f } : null;
  }
  const n = notes.find((x) => x.id === key);
  return n ? { key, isNote: true, data: n } : null;
}

function defaultWidth(kind) {
  if (kind === 'text') return 236;
  if (kind === 'audio') return 218;
  if (kind === 'image') return 216;
  return 204;
}

// ---------- 初始化 ----------
export function init() {
  if (inited) return;
  inited = true;

  onFmtChange(() => syncMenuPos());

  bindCanvasEvents();
  bindHudEvents();

  window.addEventListener('darkroom:changed', () => { stale = true; });
  // 登录或退出：放下手里的选中和工具（访客只有选择和抓手），画布内容由上面的 stale 重新加载
  window.addEventListener('darkroom:auth', () => {
    clearSelection();
    setTool('select');
    toggleLayouts(false);
  });
  window.addEventListener('darkroom:theme', () => {
    if (!active) return;
    renderStrokes();
    drawMinimap();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
}

export async function enter(arg) {
  active = true;
  pendingFocusId = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  if (!cameraReady) {
    panX = window.innerWidth / 2;
    panY = window.innerHeight / 2;
    zoom = 1;
    cameraReady = true;
  }
  applyCamera();
  if (stale) await loadDesk();
  else handleFocusArg();
}

export function leave() {
  active = false;
  toggleHelp(false);
  toggleLayouts(false);
  $('#desk-menu').hidden = true;
  $('#desk-search').hidden = true;
  closePanel();
  flushSave();
}

async function loadDesk() {
  stale = false;
  try {
    const data = await api('/api/desk');
    files = data.files || [];
    trashedIds.clear();
    notes = data.board?.notes || [];
    frames = data.board?.frames || [];
    connectors = data.board?.connectors || [];
    strokes = data.board?.strokes || [];
    zTop = Math.max(10, ...files.map((f) => f.z || 0), ...notes.map((n) => n.z || 0));
    history.length = 0;
    histIdx = -1;
    pushHistory();
    renderAll();
    if (previewId !== null) files.some((f) => f.id === previewId) ? openPanel(previewId) : closePanel();
    handleFocusArg();
  } catch (err) {
    toast(err.message);
  }
}

// 地址是 #desk/<id>（从列表点「在画布上找到」）：飞过去并选中它
function handleFocusArg() {
  const id = pendingFocusId;
  pendingFocusId = null;
  if (!id) return;
  // 这个模块里的 history 是撤销栈，地址栏要用 window.history
  window.history.replaceState(null, '', '#desk');
  if (files.some((f) => f.id === id)) flyToCard(`f:${id}`);
}

// ---------- 自动保存与历史撤销栈 ----------
function scheduleSave({ fileIds = [], board = false } = {}) {
  // 访客拖动只在本地生效，刷新就复原
  if (isGuest()) return;
  for (const id of fileIds) dirtyFileIds.add(id);
  if (board) dirtyBoard = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 360);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirtyFileIds.size && !dirtyBoard) return;
  const body = {};
  if (dirtyFileIds.size) {
    const ids = [...dirtyFileIds];
    dirtyFileIds.clear();
    body.files = ids.map((id) => files.find((x) => x.id === id)).filter(Boolean)
      .map((f) => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), w: f.w || null, rot: f.rot || 0, z: f.z || 0 }));
  }
  if (dirtyBoard) {
    dirtyBoard = false;
    body.board = { notes, frames, connectors, strokes };
  }
  try {
    await api('/api/desk', { method: 'PATCH', body });
  } catch (err) {
    toast(err.message);
  }
}

function cloneSnapshot() {
  return {
    files: files.map((f) => ({ ...f })),
    notes: notes.map((n) => ({ ...n })),
    frames: frames.map((f) => ({ ...f })),
    connectors: connectors.map((c) => ({ ...c })),
    strokes: strokes.map((s) => ({ ...s, pts: s.pts.slice() })),
  };
}

function pushHistory() {
  // 这一步已经包含了方向键挪过的位置，不用再单独记
  clearTimeout(nudgeTimer);
  nudgeTimer = null;
  history.splice(histIdx + 1);
  history.push(cloneSnapshot());
  if (history.length > 40) history.shift();
  histIdx = history.length - 1;
  syncUndoBtns();
}

function applySnapshot(snap) {
  const prevIds = new Set(files.map((f) => f.id));
  files = snap.files.filter((f) => !trashedIds.has(f.id)).map((f) => ({ ...f }));
  notes = snap.notes.map((n) => ({ ...n }));
  frames = snap.frames.map((f) => ({ ...f }));
  connectors = snap.connectors.map((c) => ({ ...c }));
  strokes = snap.strokes.map((s) => ({ ...s, pts: s.pts.slice() }));
  const allAffected = new Set([...prevIds, ...files.map((f) => f.id)]);
  clearSelection();
  renderAll();
  scheduleSave({ fileIds: [...allAffected], board: true });
}

function commitNudge() {
  if (!nudgeTimer) return;
  pushHistory();
}

function undo() {
  if (isGuest()) return;
  commitNudge();
  if (histIdx <= 0) return;
  histIdx--;
  applySnapshot(history[histIdx]);
  syncUndoBtns();
  toast('已撤销', true);
}

function redo() {
  if (isGuest()) return;
  commitNudge();
  if (histIdx >= history.length - 1) return;
  histIdx++;
  applySnapshot(history[histIdx]);
  syncUndoBtns();
  toast('已重做', true);
}

function syncUndoBtns() {
  const u = $('#desk-undo'), r = $('#desk-redo');
  if (u) u.disabled = histIdx <= 0;
  if (r) r.disabled = histIdx >= history.length - 1;
}

// ---------- 相机与动画 ----------
function applyCamera() {
  const desk = $('#desk-surface');
  const world = $('#desk-world');
  if (!desk || !world) return;
  world.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  const step = 24 * zoom;
  desk.style.backgroundSize = `${step}px ${step}px`;
  desk.style.backgroundPosition = `${panX % step}px ${panY % step}px`;
  desk.style.backgroundImage = zoom < 0.42 ? 'none' : 'radial-gradient(circle, var(--dot) 1px, transparent 1px)';
  $('#desk-zoom').textContent = `${Math.round(zoom * 100)}%`;
  syncMenuPos();
  drawMinimap();
}

function animateCamera(tx, ty, tz, duration = 380) {
  cancelAnimationFrame(flyAnim);
  const sX = panX, sY = panY, sZ = zoom;
  const t0 = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - p, 3);
    panX = sX + (tx - sX) * e;
    panY = sY + (ty - sY) * e;
    zoom = sZ + (tz - sZ) * e;
    applyCamera();
    if (p < 1) flyAnim = requestAnimationFrame(tick);
  }
  flyAnim = requestAnimationFrame(tick);
}

function flyToCard(key) {
  const found = findCard(key);
  if (!found) return;
  clearSelection();
  selectedKeys.add(key);
  syncSelectionDOM();
  const z = clamp(zoom < 0.85 ? 1 : zoom, 0.85, 1.35);
  animateCamera(window.innerWidth / 2 - found.data.x * z, window.innerHeight / 2 - found.data.y * z, z, 420);
}

// ---------- 渲染：分区框、连线、手写笔迹、卡片 ----------
function renderFrames() {
  const box = $('#desk-frames');
  box.innerHTML = '';
  for (const f of frames) {
    const el = document.createElement('div');
    el.className = 'd-frame' + (f.id === selectedFrameId ? ' selected' : '');
    el.dataset.fid = f.id;
    el.style.cssText = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;`;
    el.innerHTML = `<div class="d-frame-title" spellcheck="false"></div><span class="d-resize" data-resize-frame="${esc(f.id)}"></span>`;
    const t = el.querySelector('.d-frame-title');
    t.textContent = f.title || '分区';
    t.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (isGuest()) return;
      t.contentEditable = 'true';
      t.focus();
    });
    t.addEventListener('blur', () => {
      t.contentEditable = 'false';
      const title = t.textContent.trim() || '分区';
      // 改过标题的分区就是自己的了，换摆法时不再收走
      if (title !== f.title) delete f.auto;
      f.title = title;
      pushHistory();
      scheduleSave({ board: true });
    });
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } });
    box.appendChild(el);
  }
}

function curveBetween(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const pad = Math.min(64, dist * 0.34);
  const ux = dx / dist, uy = dy / dist;
  const sx = x1 + ux * pad, sy = y1 + uy * pad;
  const ex = x2 - ux * pad, ey = y2 - uy * pad;
  const cx = (sx + ex) / 2 - uy * Math.min(48, dist * 0.14);
  const cy = (sy + ey) / 2 + ux * Math.min(48, dist * 0.14);
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

function renderConnectors() {
  const g = $('#desk-conns');
  g.innerHTML = '';
  const map = new Map(allCards().map((c) => [c.key, c]));
  for (const c of connectors) {
    const a = map.get(c.from), b = map.get(c.to);
    if (!a || !b) continue;
    const d = curveBetween(a.x, a.y, b.x, b.y);
    const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    grp.setAttribute('class', 'd-conn' + (c.id === selectedConnId ? ' selected' : ''));
    grp.innerHTML = `<path class="d-conn-hit" d="${d}"/><path class="d-conn-line" d="${d}" marker-end="url(#desk-arrow)"/>`;
    grp.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      clearSelection();
      selectedConnId = c.id;
      renderConnectors();
      syncMenuPos();
    });
    g.appendChild(grp);
  }
}

function smoothPolyPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]} l 0.1 0.1`;
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
}

function renderStrokes() {
  const g = $('#desk-strokes');
  if (!g) return;
  g.innerHTML = '';
  for (const s of strokes) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'd-stroke' + (s.id === selectedStrokeId ? ' selected' : ''));
    p.setAttribute('d', smoothPolyPath(s.pts));
    p.setAttribute('stroke', resolveStrokeColor(s.color));
    p.setAttribute('stroke-width', s.width || 2.6);
    p.addEventListener('pointerdown', (e) => {
      if (tool !== 'select') return;
      e.stopPropagation();
      clearSelection();
      selectedStrokeId = s.id;
      renderStrokes();
      syncMenuPos();
    });
    g.appendChild(p);
  }
}

const cardTransform = (x, y, rot) => `translate3d(calc(${x}px - 50%), calc(${y}px - 50%), 0) rotate(${rot || 0}deg)`;

async function loadTextSnippet(f, pre) {
  if (textCache.has(f.id)) {
    pre.textContent = textCache.get(f.id);
    return;
  }
  try {
    const r = await fetch(f.url);
    if (!r.ok) throw new Error();
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const txt = new TextDecoder().decode(buf.subarray(0, 600));
    textCache.set(f.id, txt);
    if (pre.isConnected) pre.textContent = txt;
  } catch {
    if (pre.isConnected) pre.textContent = f.name;
  }
}

function buildFileCardEl(f, entering = false) {
  const key = `f:${f.id}`;
  const el = document.createElement('article');
  const styleKind = ['image', 'text', 'audio'].includes(f.kind) ? f.kind : 'file';
  el.className = `d-card d-card-${styleKind}${entering ? ' entering' : ''}${selectedKeys.has(key) ? ' selected' : ''}`;
  el.dataset.key = key;
  el.style.zIndex = f.z || 1;
  if (f.w) el.style.width = `${f.w}px`;
  el.style.transform = cardTransform(f.x, f.y, f.rot);

  if (f.kind === 'image') {
    el.innerHTML = `<div class="d-thumb"><img alt="" decoding="async" loading="lazy"></div><div class="d-foot"><span class="d-name"></span><span class="d-meta"></span></div><span class="d-resize" data-resize="${key}"></span>`;
    el.querySelector('img').src = f.thumb || f.url;
  } else if (f.kind === 'text') {
    el.innerHTML = `<pre>读取中…</pre><div class="d-foot"><span class="d-name"></span><span class="d-meta"></span></div><span class="d-resize" data-resize="${key}"></span>`;
    loadTextSnippet(f, el.querySelector('pre'));
  } else if (f.kind === 'audio') {
    const heights = [35, 70, 50, 95, 60, 80, 40, 90, 55, 75, 45, 85, 50, 65];
    el.innerHTML = `<div class="d-wave"><button type="button" class="d-play" aria-label="播放">▶</button><div class="d-bars">${heights.map((h) => `<i style="height:${h}%"></i>`).join('')}</div></div><div class="d-foot"><span class="d-name"></span><span class="d-meta"></span></div>`;
    const btn = el.querySelector('.d-play');
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = el.classList.toggle('playing');
      btn.textContent = on ? '❚❚' : '▶';
      if (!el._audio) {
        el._audio = new Audio(f.url);
        el._audio.onended = () => { el.classList.remove('playing'); btn.textContent = '▶'; };
      }
      on ? el._audio.play() : el._audio.pause();
    });
  } else {
    const accents = { pdf: '#fb7185', video: '#818cf8' };
    const dotColor = accents[f.kind] || '#34d399';
    el.innerHTML = `<div class="d-ext"><span></span><i style="background:${dotColor}"></i></div><div class="d-info"><div class="d-name"></div><div class="d-meta"></div></div>`;
    el.querySelector('.d-ext span').textContent = extLabel(f.name);
  }

  el.querySelector('.d-name').textContent = f.name || '未命名';
  el.querySelector('.d-name').title = f.name || '';
  el.querySelector('.d-meta').textContent = fmtSize(f.size);
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); openPanel(f.id); });
  return el;
}

function buildNoteCardEl(n, entering = false) {
  const el = document.createElement('article');
  el.className = `d-card d-card-note${entering ? ' entering' : ''}${selectedKeys.has(n.id) ? ' selected' : ''}`;
  el.dataset.key = n.id;
  el.dataset.tint = n.tint || 'amber';
  el.style.zIndex = n.z || 1;
  if (n.w) el.style.width = `${n.w}px`;
  el.style.transform = cardTransform(n.x, n.y, n.rot);
  el.innerHTML = `<div class="d-note-body" spellcheck="false"></div><div class="d-note-tag">便签<span class="edit-only"> · 双击编辑</span></div><span class="d-resize" data-resize="${esc(n.id)}"></span>`;
  el.querySelector('.d-note-body').textContent = n.text || '';
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); startNoteEdit(el, n); });
  return el;
}

function startNoteEdit(el, n) {
  const body = el.querySelector('.d-note-body');
  if (!body || isGuest()) return;
  body.contentEditable = 'true';
  body.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(body);
  sel.collapseToEnd();
  const stop = (ev) => ev.stopPropagation();
  body.addEventListener('pointerdown', stop);
  body.addEventListener('blur', () => {
    body.contentEditable = 'false';
    body.removeEventListener('pointerdown', stop);
    n.text = body.textContent;
    pushHistory();
    scheduleSave({ board: true });
  }, { once: true });
}

function renderCards() {
  const box = $('#desk-cards');
  box.innerHTML = '';
  for (const f of files) box.appendChild(buildFileCardEl(f));
  for (const n of notes) box.appendChild(buildNoteCardEl(n));
}

function renderAll() {
  renderFrames();
  renderConnectors();
  renderStrokes();
  renderCards();
  updateEmptyHint();
  syncSelectionDOM();
  drawMinimap();
}

function updateEmptyHint() {
  const empty = $('#desk-empty-hint');
  if (empty) empty.hidden = files.length + notes.length + frames.length + strokes.length > 0;
}

// ---------- 选中状态与屏幕级动作胶囊 ----------
function clearSelection() {
  selectedKeys.clear();
  selectedFrameId = null;
  selectedConnId = null;
  selectedStrokeId = null;
  syncSelectionDOM();
}

function syncSelectionDOM() {
  $('#desk-cards')?.querySelectorAll('.d-card').forEach((el) => {
    el.classList.toggle('selected', selectedKeys.has(el.dataset.key));
  });
  $('#desk-frames')?.querySelectorAll('.d-frame').forEach((el) => {
    el.classList.toggle('selected', el.dataset.fid === selectedFrameId);
  });
  syncMenuPos();
}

function syncMenuPos() {
  const menu = $('#desk-menu');
  if (!menu || !active) { if (menu) menu.hidden = true; return; }

  if (selectedFrameId || selectedConnId || selectedStrokeId) {
    // 这时胶囊上只有「删除」，访客用不了，干脆不出
    if (isGuest()) { menu.hidden = true; return; }
    const rect = selectedFrameId
      ? $(`.d-frame[data-fid="${selectedFrameId}"]`, $('#desk-frames'))?.getBoundingClientRect()
      : selectedConnId
        ? $('.d-conn.selected', $('#desk-conns'))?.getBoundingClientRect()
        : $('.d-stroke.selected', $('#desk-strokes'))?.getBoundingClientRect();
    if (!rect) { menu.hidden = true; return; }
    $('#dm-swatches').hidden = true;
    $('#dm-copy').hidden = true;
    $('#dm-detail').hidden = true;
    $('#dm-sep').hidden = true;
    menu.hidden = false;
    menu.style.left = `${clamp(rect.left + rect.width / 2, 80, window.innerWidth - 80)}px`;
    menu.style.top = `${Math.max(76, rect.top)}px`;
    return;
  }

  if (!selectedKeys.size) { menu.hidden = true; return; }
  const keys = [...selectedKeys];
  let minL = Infinity, minT = Infinity, maxR = -Infinity;
  for (const k of keys) {
    const el = $(`.d-card[data-key="${k}"]`, $('#desk-cards'));
    if (!el || el.classList.contains('dragging')) { menu.hidden = true; return; }
    const r = el.getBoundingClientRect();
    minL = Math.min(minL, r.left);
    minT = Math.min(minT, r.top);
    maxR = Math.max(maxR, r.right);
  }
  if (minT > window.innerHeight || maxR < 0 || minL > window.innerWidth) { menu.hidden = true; return; }

  const single = keys.length === 1 ? findCard(keys[0]) : null;

  $('#dm-swatches').hidden = !(single && single.isNote);
  $('#dm-copy').hidden = false;
  $('#dm-detail').hidden = !(single && !single.isNote);
  $('#dm-sep').hidden = false;
  $('#dm-copy').textContent = keys.length > 1
    ? `复制 (${keys.length})`
    : single?.isNote ? '复制文字' : `复制 ${fmtLabel()}`;

  menu.hidden = false;
  menu.style.left = `${clamp((minL + maxR) / 2, 150, window.innerWidth - 150)}px`;
  menu.style.top = `${Math.max(76, minT)}px`;
}

// ---------- 工具栏与指针手势 ----------
function setTool(t) {
  // 访客只有选择和抓手
  if (isGuest() && t !== 'select' && t !== 'hand') return;
  tool = t;
  $('#desk-surface').dataset.tool = t;
  $('#desk-dock').querySelectorAll('.d-tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('#desk-penbar').hidden = t !== 'pen';
  if (t === 'pen') toggleLayouts(false);
}

function createNoteAt(wx, wy, text = '', tint = 'amber') {
  if (isGuest()) return;
  const note = { id: uid('n'), x: Math.round(wx), y: Math.round(wy), w: 204, rot: 0, z: ++zTop, tint, text };
  notes.push(note);
  clearSelection();
  selectedKeys.add(note.id);
  const el = buildNoteCardEl(note, true);
  $('#desk-cards').appendChild(el);
  updateEmptyHint();
  syncSelectionDOM();
  drawMinimap();
  setTool('select');
  if (!text) requestAnimationFrame(() => startNoteEdit(el, note));
  else { pushHistory(); scheduleSave({ board: true }); }
}

function bindCanvasEvents() {
  const desk = $('#desk-surface');
  const livePath = $('#desk-live');
  let action = null;

  desk.addEventListener('dblclick', (e) => {
    // 按下时用了 pointer capture，Chrome 会把 click / dblclick 派给画布本身；
    // 这时按指针下面真正的卡片或分区标题重新派发，让它们自己的双击（预览、编辑）生效
    if (e.target === desk) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (under && under !== desk && desk.contains(under) && under.closest('.d-card, .d-frame-title')) {
        under.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
        return;
      }
    }
    if (e.target.closest('.d-card, .d-frame-title')) return;
    const p = toWorld(e.clientX, e.clientY);
    createNoteAt(p.x, p.y);
  });

  desk.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[contenteditable="true"]')) return;
    // 点到画布上就清掉页面里别处选中的文字，⌘C 才会去复制选中的卡片
    window.getSelection()?.removeAllRanges();
    if (e.button !== 0 && e.button !== 1) return;
    cancelAnimationFrame(flyAnim);
    const wPt = toWorld(e.clientX, e.clientY);

    if (tool === 'hand' || spaceHeld || e.button === 1) {
      action = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: panX, oy: panY };
      desk.classList.add('panning');
      desk.setPointerCapture(e.pointerId);
      return;
    }

    const resizeKey = !isGuest() && e.target.dataset?.resize;
    if (resizeKey) {
      const c = findCard(resizeKey);
      const el = $(`.d-card[data-key="${resizeKey}"]`, $('#desk-cards'));
      if (c && el) {
        action = { kind: 'resize-card', c, el, sx: e.clientX, ow: el.offsetWidth };
        desk.setPointerCapture(e.pointerId);
        return;
      }
    }

    const resizeFid = !isGuest() && e.target.dataset?.resizeFrame;
    if (resizeFid) {
      const f = frames.find((x) => x.id === resizeFid);
      const el = $(`.d-frame[data-fid="${resizeFid}"]`, $('#desk-frames'));
      if (f && el) {
        action = { kind: 'resize-frame', f, el, sx: e.clientX, sy: e.clientY, ow: f.w, oh: f.h };
        desk.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (tool === 'note') { createNoteAt(wPt.x, wPt.y); return; }

    if (tool === 'pen') {
      clearSelection();
      const pts = [[wPt.x, wPt.y]];
      livePath.setAttribute('stroke', resolveStrokeColor(penColor));
      livePath.setAttribute('stroke-width', '2.6');
      livePath.setAttribute('d', smoothPolyPath(pts));
      action = { kind: 'pen', pts };
      desk.setPointerCapture(e.pointerId);
      return;
    }

    if (tool === 'frame') {
      clearSelection();
      const f = { id: uid('fr'), title: '新建分区', x: Math.round(wPt.x), y: Math.round(wPt.y), w: 4, h: 4 };
      frames.push(f);
      selectedFrameId = f.id;
      renderFrames();
      action = { kind: 'draw-frame', f, ox: wPt.x, oy: wPt.y };
      desk.setPointerCapture(e.pointerId);
      return;
    }

    if (tool === 'arrow') {
      const cardEl = e.target.closest('.d-card');
      if (!cardEl) return;
      const from = findCard(cardEl.dataset.key);
      if (!from) return;
      livePath.setAttribute('stroke', 'var(--accent)');
      livePath.setAttribute('stroke-width', '1.8');
      livePath.setAttribute('marker-end', 'url(#desk-arrow)');
      livePath.setAttribute('d', '');
      action = { kind: 'arrow', fromKey: from.key, fromX: from.data.x, fromY: from.data.y, targetKey: null };
      desk.setPointerCapture(e.pointerId);
      return;
    }

    const cardEl = e.target.closest('.d-card');
    if (cardEl) {
      const key = cardEl.dataset.key;
      if (e.shiftKey) {
        selectedKeys.has(key) ? selectedKeys.delete(key) : selectedKeys.add(key);
      } else if (!selectedKeys.has(key)) {
        clearSelection();
        selectedKeys.add(key);
      }
      selectedFrameId = null; selectedConnId = null; selectedStrokeId = null;
      const moving = [...selectedKeys].map((k) => {
        const c = findCard(k);
        const el = $(`.d-card[data-key="${k}"]`, $('#desk-cards'));
        if (c && el) { c.data.z = ++zTop; el.style.zIndex = c.data.z; el.classList.remove('animating'); }
        return c && el ? { c, el, ox: c.data.x, oy: c.data.y } : null;
      }).filter(Boolean);
      syncSelectionDOM();
      action = { kind: 'drag-cards', moving, sx: e.clientX, sy: e.clientY, moved: false };
      desk.setPointerCapture(e.pointerId);
      return;
    }

    const frameEl = e.target.closest('.d-frame');
    if (frameEl) {
      const fid = frameEl.dataset.fid;
      const f = frames.find((x) => x.id === fid);
      if (f) {
        clearSelection();
        selectedFrameId = fid;
        syncSelectionDOM();
        const contained = allCards()
          .filter((c) => c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y && c.y <= f.y + f.h)
          .map((c) => ({ c, el: $(`.d-card[data-key="${c.key}"]`, $('#desk-cards')), ox: c.data.x, oy: c.data.y }));
        action = { kind: 'drag-frame', f, frameEl, ox: f.x, oy: f.y, contained, sx: e.clientX, sy: e.clientY, moved: false };
        desk.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (!e.shiftKey) clearSelection();
    action = { kind: 'marquee', sx: e.clientX, sy: e.clientY, moved: false };
    desk.setPointerCapture(e.pointerId);
  });

  desk.addEventListener('pointermove', (e) => {
    if (!action) return;
    const dx = e.clientX - action.sx, dy = e.clientY - action.sy;

    if (action.kind === 'pan') { panX = action.ox + dx; panY = action.oy + dy; applyCamera(); return; }

    if (action.kind === 'resize-card') {
      action.c.data.w = Math.round(clamp(action.ow + dx / zoom, 136, 620));
      action.el.style.width = `${action.c.data.w}px`;
      syncMenuPos(); drawMinimap();
      return;
    }

    if (action.kind === 'resize-frame') {
      action.f.w = Math.max(160, Math.round(action.ow + dx / zoom));
      action.f.h = Math.max(120, Math.round(action.oh + dy / zoom));
      action.el.style.width = `${action.f.w}px`;
      action.el.style.height = `${action.f.h}px`;
      syncMenuPos(); drawMinimap();
      return;
    }

    if (action.kind === 'pen') {
      const p = toWorld(e.clientX, e.clientY);
      const last = action.pts[action.pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 2 / zoom) {
        action.pts.push([p.x, p.y]);
        livePath.setAttribute('d', smoothPolyPath(action.pts));
      }
      return;
    }

    if (action.kind === 'draw-frame') {
      const p = toWorld(e.clientX, e.clientY);
      action.f.x = Math.round(Math.min(action.ox, p.x));
      action.f.y = Math.round(Math.min(action.oy, p.y));
      action.f.w = Math.round(Math.max(40, Math.abs(p.x - action.ox)));
      action.f.h = Math.round(Math.max(40, Math.abs(p.y - action.oy)));
      const el = $(`.d-frame[data-fid="${action.f.id}"]`, $('#desk-frames'));
      if (el) el.style.cssText = `left:${action.f.x}px;top:${action.f.y}px;width:${action.f.w}px;height:${action.f.h}px;`;
      drawMinimap();
      return;
    }

    if (action.kind === 'arrow') {
      const p = toWorld(e.clientX, e.clientY);
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.d-card');
      const tk = under?.dataset.key;
      action.targetKey = tk && tk !== action.fromKey ? tk : null;
      $('#desk-cards').querySelectorAll('.d-card').forEach((c) => c.classList.toggle('connect-target', c.dataset.key === action.targetKey));
      const dest = action.targetKey ? findCard(action.targetKey)?.data : p;
      if (dest) livePath.setAttribute('d', `M ${action.fromX} ${action.fromY} L ${dest.x} ${dest.y}`);
      return;
    }

    if (action.kind === 'drag-cards') {
      if (!action.moved && Math.hypot(dx, dy) > 3.5) {
        action.moved = true;
        action.moving.forEach((m) => m.el.classList.add('dragging'));
        $('#desk-menu').hidden = true;
      }
      if (!action.moved) return;
      action.moving.forEach((m) => {
        m.c.data.x = m.ox + dx / zoom;
        m.c.data.y = m.oy + dy / zoom;
        m.el.style.transform = cardTransform(m.c.data.x, m.c.data.y, m.c.data.rot);
      });
      renderConnectors(); drawMinimap();
      return;
    }

    if (action.kind === 'drag-frame') {
      if (!action.moved && Math.hypot(dx, dy) > 3.5) { action.moved = true; $('#desk-menu').hidden = true; }
      if (!action.moved) return;
      action.f.x = Math.round(action.ox + dx / zoom);
      action.f.y = Math.round(action.oy + dy / zoom);
      action.frameEl.style.left = `${action.f.x}px`;
      action.frameEl.style.top = `${action.f.y}px`;
      action.contained.forEach((m) => {
        m.c.data.x = m.ox + dx / zoom;
        m.c.data.y = m.oy + dy / zoom;
        if (m.el) m.el.style.transform = cardTransform(m.c.data.x, m.c.data.y, m.c.data.rot);
      });
      renderConnectors(); drawMinimap();
      return;
    }

    if (action.kind === 'marquee') {
      if (!action.moved && Math.hypot(dx, dy) > 4) action.moved = true;
      if (!action.moved) return;
      const l = Math.min(action.sx, e.clientX), t = Math.min(action.sy, e.clientY);
      const w = Math.abs(dx), h = Math.abs(dy);
      const mq = $('#desk-marquee');
      mq.hidden = false;
      mq.style.cssText = `left:${l}px;top:${t}px;width:${w}px;height:${h}px;`;
      selectedKeys.clear();
      $('#desk-cards').querySelectorAll('.d-card').forEach((el) => {
        const r = el.getBoundingClientRect();
        const hit = !(r.right < l || r.left > l + w || r.bottom < t || r.top > t + h);
        if (hit) selectedKeys.add(el.dataset.key);
        el.classList.toggle('selected', hit);
      });
    }
  });

  desk.addEventListener('pointerup', (e) => {
    if (!action) return;
    const a = action;
    action = null;
    try { desk.releasePointerCapture(e.pointerId); } catch {}
    desk.classList.remove('panning');

    if (a.kind === 'pen') {
      livePath.setAttribute('d', '');
      if (a.pts.length > 1) {
        strokes.push({ id: uid('st'), color: penColor, width: 2.6, pts: a.pts });
        renderStrokes();
        updateEmptyHint();
        pushHistory();
        scheduleSave({ board: true });
        drawMinimap();
      }
      return;
    }

    if (a.kind === 'draw-frame') {
      if (a.f.w < 70 && a.f.h < 70) { a.f.w = 340; a.f.h = 240; renderFrames(); }
      setTool('select');
      updateEmptyHint();
      pushHistory();
      scheduleSave({ board: true });
      syncMenuPos(); drawMinimap();
      return;
    }

    if (a.kind === 'arrow') {
      livePath.setAttribute('d', '');
      livePath.removeAttribute('marker-end');
      $('#desk-cards').querySelectorAll('.d-card').forEach((c) => c.classList.remove('connect-target'));
      if (a.targetKey) {
        if (!connectors.some((c) => c.from === a.fromKey && c.to === a.targetKey)) {
          connectors.push({ id: uid('cn'), from: a.fromKey, to: a.targetKey });
          renderConnectors();
          pushHistory();
          scheduleSave({ board: true });
          toast('已建立连线', true);
        }
        setTool('select');
      }
      return;
    }

    if (a.kind === 'drag-cards') {
      a.moving.forEach((m) => m.el.classList.remove('dragging'));
      // 预览面板开着时，单击另一张文件卡片就换成预览它
      const only = selectedKeys.size === 1 ? [...selectedKeys][0] : null;
      if (!a.moved && previewId !== null && only?.startsWith('f:')) openPanel(Number(only.slice(2)));
      const fids = a.moving.filter((m) => !m.c.isNote).map((m) => m.c.data.id);
      const hasNotes = a.moving.some((m) => m.c.isNote);
      if (a.moved) pushHistory();
      scheduleSave({ fileIds: fids, board: hasNotes });
      syncMenuPos();
      return;
    }

    if (a.kind === 'drag-frame') {
      const fids = a.contained.filter((m) => !m.c.isNote).map((m) => m.c.data.id);
      if (a.moved) pushHistory();
      scheduleSave({ fileIds: fids, board: true });
      syncMenuPos();
      return;
    }

    if (a.kind === 'resize-card') {
      pushHistory();
      if (a.c.isNote) scheduleSave({ board: true });
      else scheduleSave({ fileIds: [a.c.data.id] });
      syncMenuPos();
      return;
    }

    if (a.kind === 'resize-frame') {
      pushHistory();
      scheduleSave({ board: true });
      syncMenuPos();
      return;
    }

    if (a.kind === 'marquee') {
      $('#desk-marquee').hidden = true;
      syncMenuPos();
    }
  });

  desk.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelAnimationFrame(flyAnim);
    if (e.ctrlKey || e.metaKey) {
      const wx = (e.clientX - panX) / zoom;
      const wy = (e.clientY - panY) / zoom;
      zoom = clamp(zoom * Math.exp(-e.deltaY * 0.0085), 0.22, 3.0);
      panX = e.clientX - wx * zoom;
      panY = e.clientY - wy * zoom;
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
    }
    applyCamera();
  }, { passive: false });
}

// ---------- 真实文件上传上桌 ----------
async function dropFilesOntoDesk(fileList, screenX, screenY) {
  // 访客拖进来的文件也要拦下，不然浏览器会直接打开它
  if (isGuest()) { toast('登录后才能上传'); return; }
  const arr = [...fileList];
  if (!arr.length) return;
  const base = toWorld(screenX, screenY);
  let newest = null;

  for (let i = 0; i < arr.length; i++) {
    const file = arr[i];
    const angle = i * 2.39996;
    const dist = i === 0 ? 0 : 82 * Math.sqrt(i);
    const x = Math.round(base.x + Math.cos(angle) * dist + (Math.random() - 0.5) * 16);
    const y = Math.round(base.y + Math.sin(angle) * dist + (Math.random() - 0.5) * 16);
    const rot = Number(((Math.random() - 0.5) * 3.4).toFixed(2));

    // 先放一张带进度条的占位卡片在松手处
    const ghost = document.createElement('article');
    ghost.className = 'd-card d-card-file entering';
    ghost.style.zIndex = ++zTop;
    ghost.style.transform = cardTransform(x, y, rot);
    ghost.innerHTML = `<div class="d-ext"><span>···</span></div><div class="d-info"><div class="d-name"></div><div class="d-prog"><i></i></div></div>`;
    ghost.querySelector('.d-name').textContent = normalizeFileName(file);
    $('#desk-cards').appendChild(ghost);
    const bar = ghost.querySelector('.d-prog i');

    try {
      const { image, duplicate } = await uploadFileToDesk(file, {
        x, y, rot,
        onProgress: (p) => { bar.style.width = `${(p * 100).toFixed(0)}%`; },
      });
      ghost.remove();

      const existIdx = files.findIndex((f) => f.id === image.id);
      if (existIdx >= 0) {
        files[existIdx] = image;
        $(`.d-card[data-key="f:${image.id}"]`, $('#desk-cards'))?.replaceWith(buildFileCardEl(image, true));
      } else {
        files.push(image);
        $('#desk-cards').appendChild(buildFileCardEl(image, true));
      }
      newest = { image, duplicate };
      window.dispatchEvent(new Event('darkroom:changed'));
    } catch (err) {
      ghost.remove();
      toast(`上传失败：${err.message}`);
    }
  }

  if (newest) {
    clearSelection();
    selectedKeys.add(`f:${newest.image.id}`);
    pushHistory();
    updateEmptyHint();
    syncSelectionDOM();
    drawMinimap();
    await copy(formatLink(newest.image, getFmt()));
    toast(newest.duplicate ? `之前传过，${fmtLabel()} 已复制` : `已上桌，${fmtLabel()} 已复制`, true);
  }
}

// ---------- HUD 按钮、理齐/散落、小地图、搜索与快捷键 ----------
function bindHudEvents() {
  $('#desk-dock').addEventListener('click', (e) => {
    const b = e.target.closest('.d-tool[data-tool]');
    if (b) setTool(b.dataset.tool);
  });

  $('#desk-penbar').addEventListener('click', (e) => {
    const b = e.target.closest('.d-pencolor');
    if (!b) return;
    penColor = b.dataset.color;
    $('#desk-penbar').querySelectorAll('.d-pencolor').forEach((x) => x.classList.toggle('active', x === b));
  });

  $('#desk-undo').addEventListener('click', undo);
  $('#desk-redo').addEventListener('click', redo);
  $('#desk-zoom').addEventListener('click', () => animateCamera(window.innerWidth / 2, window.innerHeight / 2, 1, 360));

  $('#desk-upload').addEventListener('click', () => $('#desk-file').click());
  $('#desk-file').addEventListener('change', (e) => {
    dropFilesOntoDesk(e.target.files, window.innerWidth / 2, window.innerHeight / 2);
    e.target.value = '';
  });

  // 全窗口拖拽文件上桌
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!active || isGuest() || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('#desk-drop-halo').hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (active) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    if (!active) return;
    if (--dragDepth <= 0) { dragDepth = 0; $('#desk-drop-halo').hidden = true; }
  });
  window.addEventListener('drop', (e) => {
    if (!active) return;
    e.preventDefault();
    dragDepth = 0;
    $('#desk-drop-halo').hidden = true;
    if (e.dataTransfer?.files?.length) dropFilesOntoDesk(e.dataTransfer.files, e.clientX, e.clientY);
  });

  // ⌘V 粘贴截图文件或纯文本便签
  window.addEventListener('paste', (e) => {
    if (!active || e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (isGuest()) { toast('登录后才能往画布上贴东西'); return; }
    if (e.clipboardData?.files?.length) {
      e.preventDefault();
      dropFilesOntoDesk(e.clipboardData.files, window.innerWidth / 2, window.innerHeight / 2);
      return;
    }
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (text) {
      e.preventDefault();
      const c = toWorld(window.innerWidth / 2, window.innerHeight / 2);
      createNoteAt(c.x + (Math.random() - 0.5) * 32, c.y + (Math.random() - 0.5) * 32, text, 'plain');
      toast('剪贴板文字已贴上桌面', true);
    }
  });

  // 理齐 / 散落：「散落」按钮上写着当前的摆法，点它按这种摆法再摆一次；
  // 旁边的小箭头展开摆法菜单，选一种立刻按它摆，按钮上的字也换成它
  // 卡片自己会动过去，不再弹「已理齐」之类的提示
  $('#desk-tidy').addEventListener('click', () => {
    relayoutCards((cards) => {
      const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(cards.length))));
      cards.forEach((c, idx) => {
        c.data.x = (idx % cols) * 258;
        c.data.y = Math.floor(idx / cols) * 232;
        c.data.rot = 0;
      });
    });
  });

  syncScatterButton();
  $('#desk-scatter').addEventListener('click', () => {
    toggleLayouts(false);
    applyLayout(currentLayout());
  });
  $('#desk-scatter-more').addEventListener('click', () => toggleLayouts());
  $('#desk-layouts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layout]');
    if (!b) return;
    toggleLayouts(false);
    applyLayout(b.dataset.layout);
  });

  // 悬浮操作条按钮
  $('#dm-copy').addEventListener('click', copySelected);

  $('#dm-detail').addEventListener('click', () => {
    const first = [...selectedKeys][0];
    if (first?.startsWith('f:')) openPanel(Number(first.slice(2)));
  });
  $('#dp-close').addEventListener('click', closePanel);

  // 删除：文件进 30 天回收站，便签/连线/分区/笔迹直接移除
  $('#dm-del').addEventListener('click', () => deleteSelected());

  $('#dm-swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tint]');
    if (!b) return;
    const k = [...selectedKeys][0];
    const c = k && findCard(k);
    if (!c?.isNote) return;
    c.data.tint = b.dataset.tint;
    const el = $(`.d-card[data-key="${k}"]`, $('#desk-cards'));
    if (el) el.dataset.tint = c.data.tint;
    pushHistory();
    scheduleSave({ board: true });
  });

  // 快捷键面板：点「?」或按 ? 开关，点别处、按 Esc 关掉
  $('#desk-help-btn').addEventListener('click', () => toggleHelp());
  document.addEventListener('pointerdown', (e) => {
    if (!$('#desk-help').hidden && !e.target.closest('#desk-help, #desk-help-btn')) toggleHelp(false);
    if (!$('#desk-layouts').hidden && !e.target.closest('#desk-layouts, #desk-scatter-more')) toggleLayouts(false);
  }, true);
  // 不是苹果设备时按键写成 Ctrl / Shift
  if (!/mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)) {
    const names = { '⌘': 'Ctrl', '⇧': 'Shift', '⌫': 'Delete', '↩': 'Enter' };
    $('#desk-help').querySelectorAll('kbd').forEach((k) => { k.textContent = names[k.textContent] || k.textContent; });
    $('#desk-help').querySelectorAll('dt').forEach((d) => { d.textContent = d.textContent.replace('⇧', 'Shift'); });
  }

  // 搜索飞跃定位
  $('#desk-search-btn').addEventListener('click', openSearch);
  $('#desk-cmd-input').addEventListener('input', (e) => renderSearchList(e.target.value));
  $('#desk-cmd-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#desk-cmd-list .d-cmd-item')?.click();
  });
  $('#desk-search').addEventListener('click', (e) => {
    if (e.target.id === 'desk-search') $('#desk-search').hidden = true;
  });

  // 小地图点击与拖动跳转
  const mini = $('#desk-minimap');
  let miniDrag = false;
  mini.addEventListener('pointerdown', (e) => { miniDrag = true; mini.setPointerCapture(e.pointerId); jumpFromMinimap(e); });
  mini.addEventListener('pointermove', (e) => { if (miniDrag) jumpFromMinimap(e); });
  mini.addEventListener('pointerup', () => { miniDrag = false; });

  // 键盘快捷键
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if (e.key === 'Escape') {
      if (!$('#desk-help').hidden) { toggleHelp(false); return; }
      if (!$('#desk-layouts').hidden) { toggleLayouts(false); return; }
      if (!$('#desk-search').hidden) { $('#desk-search').hidden = true; return; }
      if (previewId !== null && !document.activeElement?.isContentEditable) { closePanel(); return; }
      if (document.activeElement?.isContentEditable) document.activeElement.blur();
      else { clearSelection(); setTool('select'); }
      return;
    }
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectedKeys.clear();
      allCards().forEach((c) => selectedKeys.add(c.key));
      syncSelectionDOM();
      return;
    }
    // ⌘C：页面上选中了文字就照常复制文字，否则复制选中的卡片（和动作条上的「复制」一样）
    if (mod && e.key.toLowerCase() === 'c' && selectedKeys.size && window.getSelection()?.isCollapsed !== false) {
      e.preventDefault();
      copySelected();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateNotes(); return; }
    // ⌘+ ⌘− ⌘0：以屏幕中心缩放，拦下浏览器自己的整页缩放
    if (mod && (e.code === 'Equal' || e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAtCenter(zoom * 1.25); return; }
    if (mod && (e.code === 'Minus' || e.key === '-')) { e.preventDefault(); zoomAtCenter(zoom / 1.25); return; }
    if (mod && (e.code === 'Digit0' || e.key === '0')) { e.preventDefault(); zoomAtCenter(1); return; }
    if (e.code === 'Space') { spaceHeld = true; $('#desk-surface').classList.add('space-ready'); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelected(); return; }
    if (mod || e.altKey) return;

    // ?（有的键盘布局报的是 ⇧ + /）
    if (e.key === '?' || (e.shiftKey && (e.code === 'Slash' || e.key === '/'))) { e.preventDefault(); toggleHelp(); return; }
    // ⇧1 看全部，⇧2 看选中的
    if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); fitAll(); return; }
    if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); fitSelection(); return; }

    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow) {
      e.preventDefault();
      // 有选中就挪选中的（⇧ 一次 10），没选中就平移视野
      const step = e.shiftKey ? 10 : 1;
      if (!nudgeSelection(arrow[0] * step, arrow[1] * step)) {
        const pan = e.shiftKey ? 240 : 80;
        cancelAnimationFrame(flyAnim);
        panX -= arrow[0] * pan;
        panY -= arrow[1] * pan;
        applyCamera();
      }
      return;
    }

    // 回车：文件打开预览，便签进入编辑
    if (e.key === 'Enter' && selectedKeys.size === 1) {
      const key = [...selectedKeys][0];
      const c = findCard(key);
      const el = $(`.d-card[data-key="${key}"]`, $('#desk-cards'));
      if (!c || !el) return;
      e.preventDefault();
      c.isNote ? startNoteEdit(el, c.data) : openPanel(c.data.id);
      return;
    }

    const map = { v: 'select', h: 'hand', n: 'note', a: 'arrow', p: 'pen', f: 'frame' };
    const k = e.key.toLowerCase();
    if (map[k]) setTool(map[k]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceHeld = false; $('#desk-surface')?.classList.remove('space-ready'); }
  });
  window.addEventListener('resize', () => { if (active) applyCamera(); });
}

// ---------- 键盘操作：复制、复制一份、微调、缩放、看全部 ----------
async function copySelected() {
  const texts = [...selectedKeys].map((k) => {
    const c = findCard(k);
    if (!c) return '';
    return c.isNote ? (c.data.text || '') : formatLink(c.data, getFmt());
  }).filter(Boolean);
  if (!texts.length) return;
  await copy(texts.join('\n'));
  toast(texts.length > 1 ? `已复制 ${texts.length} 条` : '已复制', true);
}

// ⌘D：便签原地复制一份，错开一点；文件在画布上只有一张（位置存在文件上），不复制
function duplicateNotes() {
  if (isGuest()) return;
  const src = [...selectedKeys].map(findCard).filter((c) => c?.isNote);
  if (!src.length) {
    if (selectedKeys.size) toast('文件在画布上只有一张，⌘D 只复制便签');
    return;
  }
  clearSelection();
  for (const c of src) {
    const n = { ...c.data, id: uid('n'), x: c.data.x + 24, y: c.data.y + 24, z: ++zTop };
    notes.push(n);
    selectedKeys.add(n.id);
    $('#desk-cards').appendChild(buildNoteCardEl(n, true));
  }
  syncSelectionDOM();
  drawMinimap();
  pushHistory();
  scheduleSave({ board: true });
}

// 方向键挪选中的卡片；选中的是分区时，框里的卡片跟着走（和拖动分区一样）。没东西可挪返回 false
function nudgeSelection(dx, dy) {
  const moving = new Map();
  for (const k of selectedKeys) {
    const c = findCard(k);
    if (c) moving.set(k, c);
  }
  const frame = selectedFrameId ? frames.find((f) => f.id === selectedFrameId) : null;
  if (frame) {
    for (const c of allCards()) {
      if (c.x >= frame.x && c.x <= frame.x + frame.w && c.y >= frame.y && c.y <= frame.y + frame.h) moving.set(c.key, findCard(c.key));
    }
    frame.x += dx;
    frame.y += dy;
    const el = $(`.d-frame[data-fid="${frame.id}"]`, $('#desk-frames'));
    if (el) { el.style.left = `${frame.x}px`; el.style.top = `${frame.y}px`; }
  }
  if (!moving.size && !frame) return false;
  const cards = [...moving.values()];
  for (const c of cards) {
    c.data.x += dx;
    c.data.y += dy;
    const el = $(`.d-card[data-key="${c.key}"]`, $('#desk-cards'));
    if (el) { el.classList.remove('animating'); el.style.transform = cardTransform(c.data.x, c.data.y, c.data.rot); }
  }
  renderConnectors();
  drawMinimap();
  syncMenuPos();
  scheduleSave({ fileIds: cards.filter((c) => !c.isNote).map((c) => c.data.id), board: Boolean(frame) || cards.some((c) => c.isNote) });
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(commitNudge, 400);
  return true;
}

function zoomAtCenter(tz) {
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  const w = toWorld(cx, cy);
  const z = clamp(tz, 0.22, 3.0);
  animateCamera(cx - w.x * z, cy - w.y * z, z, 220);
}

// 把画布上的一块区域放进视野：上面让开顶栏，下面让开工具坞，最多放大到 100%
function fitWorld(l, t, r, b) {
  const top = 84, bottom = 104, side = 64;
  const availW = window.innerWidth - side * 2, availH = window.innerHeight - top - bottom;
  const z = clamp(Math.min(availW / Math.max(1, r - l), availH / Math.max(1, b - t), 1), 0.22, 3.0);
  animateCamera(window.innerWidth / 2 - ((l + r) / 2) * z, top + availH / 2 - ((t + b) / 2) * z, z, 420);
}

// 把一组元素整体放进视野
function fitElements(els) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const q = el.getBoundingClientRect();
    if (!q.width && !q.height) continue;
    l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  if (l === Infinity) return false;
  const p1 = toWorld(l, t), p2 = toWorld(r, b);
  fitWorld(p1.x, p1.y, p2.x, p2.y);
  return true;
}

function fitAll() {
  const els = document.querySelectorAll('#desk-cards .d-card, #desk-frames .d-frame, #desk-strokes .d-stroke');
  if (!fitElements(els)) animateCamera(window.innerWidth / 2, window.innerHeight / 2, 1, 360);
}

function fitSelection() {
  const els = [...selectedKeys].map((k) => $(`.d-card[data-key="${k}"]`, $('#desk-cards')));
  if (selectedFrameId) els.push($(`.d-frame[data-fid="${selectedFrameId}"]`, $('#desk-frames')));
  if (!fitElements(els.filter(Boolean))) fitAll();
}

async function deleteSelected() {
  if (isGuest()) return;
  const fids = [...selectedKeys].filter((k) => k.startsWith('f:')).map((k) => Number(k.slice(2)));
  const nids = new Set([...selectedKeys].filter((k) => !k.startsWith('f:')));
  let boardChanged = false;

  if (fids.length) {
    try {
      await api('/api/images/trash', { method: 'POST', body: { ids: fids } });
      const gone = new Set(fids);
      fids.forEach((id) => trashedIds.add(id));
      files = files.filter((f) => !gone.has(f.id));
      connectors = connectors.filter((c) => !selectedKeys.has(c.from) && !selectedKeys.has(c.to));
      if (gone.has(previewId)) closePanel();
      boardChanged = true;
      window.dispatchEvent(new Event('darkroom:changed'));
    } catch (err) {
      toast(err.message);
      return;
    }
  }
  if (nids.size) {
    notes = notes.filter((n) => !nids.has(n.id));
    connectors = connectors.filter((c) => !nids.has(c.from) && !nids.has(c.to));
    boardChanged = true;
  }
  if (selectedFrameId) { frames = frames.filter((f) => f.id !== selectedFrameId); selectedFrameId = null; boardChanged = true; }
  if (selectedConnId) { connectors = connectors.filter((c) => c.id !== selectedConnId); selectedConnId = null; boardChanged = true; }
  if (selectedStrokeId) { strokes = strokes.filter((s) => s.id !== selectedStrokeId); selectedStrokeId = null; boardChanged = true; }

  selectedKeys.clear();
  if (fids.length || boardChanged) {
    pushHistory();
    renderAll();
    if (boardChanged) scheduleSave({ board: true });
    toast(fids.length ? '已移入回收站，30 天内可以在「列表」里恢复' : '已删除（可按 ⌘Z 撤销）', true);
  }
}

// ---------- 小地图与搜索 ----------
let miniBounds = { sc: 0.1, ox: 148, oy: 96 };

function drawMinimap() {
  const canvas = $('#desk-minimap');
  if (!canvas || !active) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const cards = allCards();
  let minX = -650, maxX = 650, minY = -420, maxY = 420;
  for (const c of cards) { minX = Math.min(minX, c.x - 160); maxX = Math.max(maxX, c.x + 160); minY = Math.min(minY, c.y - 120); maxY = Math.max(maxY, c.y + 120); }
  for (const f of frames) { minX = Math.min(minX, f.x - 60); maxX = Math.max(maxX, f.x + f.w + 60); minY = Math.min(minY, f.y - 60); maxY = Math.max(maxY, f.y + 60 + f.h); }
  const vL = -panX / zoom, vT = -panY / zoom;
  const vR = (window.innerWidth - panX) / zoom, vB = (window.innerHeight - panY) / zoom;
  minX = Math.min(minX, vL - 80); maxX = Math.max(maxX, vR + 80);
  minY = Math.min(minY, vT - 80); maxY = Math.max(maxY, vB + 80);

  const sc = Math.min((W - 20) / (maxX - minX), (H - 20) / (maxY - minY));
  const ox = (W - (maxX - minX) * sc) / 2 - minX * sc;
  const oy = (H - (maxY - minY) * sc) / 2 - minY * sc;
  miniBounds = { sc, ox, oy };

  const dark = isDark();
  ctx.strokeStyle = dark ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.16)';
  ctx.lineWidth = 1.5;
  for (const f of frames) ctx.strokeRect(ox + f.x * sc, oy + f.y * sc, f.w * sc, f.h * sc);

  for (const c of cards) {
    const cw = (c.w || 208) * sc, ch = 130 * sc;
    ctx.fillStyle = selectedKeys.has(c.key)
      ? '#3b82f6'
      : c.isNote ? '#f59e0b' : dark ? 'rgba(255,255,255,.46)' : 'rgba(24,24,27,.38)';
    ctx.beginPath();
    ctx.roundRect(ox + c.x * sc - cw / 2, oy + c.y * sc - ch / 2, Math.max(5, cw), Math.max(4, ch), 2);
    ctx.fill();
  }

  ctx.strokeStyle = dark ? '#ededef' : '#18181b';
  ctx.lineWidth = 2;
  ctx.strokeRect(ox + vL * sc, oy + vT * sc, (vR - vL) * sc, (vB - vT) * sc);
}

function jumpFromMinimap(e) {
  const canvas = $('#desk-minimap');
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * (canvas.width / r.width);
  const cy = (e.clientY - r.top) * (canvas.height / r.height);
  const wx = (cx - miniBounds.ox) / miniBounds.sc;
  const wy = (cy - miniBounds.oy) / miniBounds.sc;
  panX = window.innerWidth / 2 - wx * zoom;
  panY = window.innerHeight / 2 - wy * zoom;
  applyCamera();
}

// ---------- 理齐、散落 ----------
const FRAME_PAD = 28;

// run(cards, { raise, step }) 改卡片的位置；摆完整体挪到原点附近、镜头装下全部。
// run 返回分组时每组套一个分区框（auto）；上一次模板加的分区框先收走，自己画的不动。
// step 是同一种摆法连着点的第几次；摆出来和现在一模一样（比如刷新后再点）就换下一个变化。返回实际用的 step
function relayoutCards(run, step = 0) {
  const cards = allCards();
  if (!cards.length) return step;
  const els = new Map(cards.map((c) => [c.key, $(`.d-card[data-key="${c.key}"]`, $('#desk-cards'))]));
  for (const c of cards) c.h = els.get(c.key)?.offsetHeight || 160;
  const box = (list) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const c of list) {
      l = Math.min(l, c.data.x - c.w / 2); r = Math.max(r, c.data.x + c.w / 2);
      t = Math.min(t, c.data.y - c.h / 2); b = Math.max(b, c.data.y + c.h / 2);
    }
    return { l, t, r, b };
  };
  const was = new Map(cards.map((c) => [c.key, [c.data.x, c.data.y, c.data.rot || 0]]));
  const unchanged = () => cards.every((c) => {
    const [x, y, rot] = was.get(c.key);
    return Math.abs(c.data.x - x) < 2 && Math.abs(c.data.y - y) < 2 && Math.abs(c.data.rot - rot) < 0.1;
  });

  let groups, all, dx, dy;
  for (let tries = 0; ; tries++, step++) {
    groups = run(cards, { raise: (c) => { c.data.z = ++zTop; }, step }) || [];
    all = box(cards);
    dx = -(all.l + all.r) / 2;
    dy = -(all.t + all.b) / 2;
    for (const c of cards) {
      c.data.x = Math.round(c.data.x + dx);
      c.data.y = Math.round(c.data.y + dy);
      c.data.rot = Number((c.data.rot || 0).toFixed(2));
    }
    if (tries >= 2 || !unchanged()) break;
  }

  const before = frames.length;
  frames = frames.filter((f) => !f.auto);
  const removed = before - frames.length;
  for (const g of groups) {
    if (!g.cards.length) continue;
    const q = box(g.cards);
    frames.push({
      id: uid('fr'), title: g.title, auto: true,
      x: Math.round(q.l - FRAME_PAD), y: Math.round(q.t - FRAME_PAD),
      w: Math.round(q.r - q.l + FRAME_PAD * 2), h: Math.round(q.b - q.t + FRAME_PAD * 2),
    });
  }

  for (const c of cards) {
    const el = els.get(c.key);
    if (!el) continue;
    el.classList.add('animating');
    el.style.transform = cardTransform(c.data.x, c.data.y, c.data.rot);
    el.style.zIndex = c.data.z || 1;
  }
  clearSelection();
  renderFrames();
  renderConnectors();
  drawMinimap();
  pushHistory();
  scheduleSave({ fileIds: files.map((f) => f.id), board: notes.length > 0 || removed > 0 || groups.length > 0 });

  // 镜头装下卡片和新加的分区框（分区标题在框外面，上面多留一点）
  const pad = groups.length ? FRAME_PAD + 30 : 0;
  fitWorld(all.l + dx - pad, all.t + dy - pad, all.r + dx + pad, all.b + dy + pad);
  return step;
}

// 当前的摆法：存在本机，第一次是随机；「散落」按钮上写的就是它
const currentLayout = () => (LAYOUTS[store.get('desk-layout')] ? store.get('desk-layout') : 'spiral');

function syncScatterButton() {
  const name = currentLayout();
  const btn = $('#desk-scatter');
  btn.textContent = LAYOUTS[name].label;
  btn.title = `按「${LAYOUTS[name].label}」再摆一次`;
  $('#desk-layouts').querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layout === name)));
}

// 按某种摆法重新摆，并记成当前的。连着点同一种时每次换个变化：
// 环形转一格、扇形洗牌、拼贴墙换列数、时间线横竖切换；随机、照片堆、分类本来就每次不一样
let lastLayout = null;
let layoutStep = 0;
function applyLayout(name) {
  if (!LAYOUTS[name]) name = 'spiral';
  store.set('desk-layout', name);
  syncScatterButton();
  layoutStep = relayoutCards(LAYOUTS[name].run, name === lastLayout ? layoutStep + 1 : 0);
  lastLayout = name;
}

// 摆法菜单：从小箭头上方弹出，左边和「散落」按钮对齐；右边别压住小地图
function toggleLayouts(open = $('#desk-layouts').hidden) {
  const menu = $('#desk-layouts');
  if (!menu || open === !menu.hidden) return;
  $('#desk-scatter-more').setAttribute('aria-expanded', String(open));
  if (!open) { menu.hidden = true; return; }
  if (tool === 'pen') setTool('select');
  menu.hidden = false;
  const r = $('#desk-scatter').getBoundingClientRect();
  const mini = $('.desk-minimap-wrap')?.getBoundingClientRect();
  const right = mini?.width ? mini.left - 10 : window.innerWidth - 8;
  menu.style.left = `${Math.max(8, Math.min(r.left, right - menu.offsetWidth))}px`;
}

function toggleHelp(open = $('#desk-help').hidden) {
  $('#desk-help').hidden = !open;
  const btn = $('#desk-help-btn');
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-expanded', String(open));
}

function openSearch() {
  $('#desk-search').hidden = false;
  $('#desk-cmd-input').value = '';
  renderSearchList('');
  $('#desk-cmd-input').focus();
}

function renderSearchList(q) {
  const kw = q.trim().toLowerCase();
  const ul = $('#desk-cmd-list');
  ul.innerHTML = '';
  const cards = allCards().filter((c) => {
    if (!kw) return true;
    const label = c.isNote ? (c.data.text || '') : (c.data.name || '');
    return label.toLowerCase().includes(kw);
  });
  if (!cards.length) {
    ul.innerHTML = '<li class="d-cmd-empty">没有匹配的内容</li>';
    return;
  }
  cards.slice(0, 40).forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'd-cmd-item' + (i === 0 ? ' active' : '');
    li.innerHTML = `<span></span><small></small>`;
    li.firstElementChild.textContent = c.isNote ? `便签：${(c.data.text || '').slice(0, 28) || '空'}` : c.data.name;
    li.lastElementChild.textContent = c.isNote ? 'NOTE' : fmtSize(c.data.size);
    li.addEventListener('click', () => {
      $('#desk-search').hidden = true;
      flyToCard(c.key);
    });
    ul.appendChild(li);
  });
}

// ---------- 右侧预览面板：双击文件卡片或点「预览」打开，画布照常可以拖动 ----------
let previewId = null;
let offPanelFmt = null;

function openPanel(id) {
  const f = files.find((x) => x.id === id);
  if (!f) return;
  const panel = $('#desk-panel');
  const switching = previewId !== null;
  previewId = id;
  renderPanel(f);
  panel.hidden = false;
  document.body.classList.add('desk-previewing');
  if (!switching) {
    panel.classList.remove('entering');
    void panel.offsetWidth;
    panel.classList.add('entering');
  }
  keepClearOfPanel(id);
}

// 卡片被面板挡住时，把画布往左挪一点，让它露出来（手机上面板在底部，不挪）
function keepClearOfPanel(id) {
  if (window.innerWidth <= 640) return;
  const el = $(`.d-card[data-key="f:${id}"]`, $('#desk-cards'));
  if (!el) return;
  const r = el.getBoundingClientRect();
  const edge = window.innerWidth - 16 - $('#desk-panel').offsetWidth - 24;
  const shift = Math.min(r.right - edge, r.left - 24);
  if (shift > 0) animateCamera(panX - shift, panY, zoom, 320);
}

function closePanel() {
  if (previewId === null) return;
  previewId = null;
  offPanelFmt?.();
  offPanelFmt = null;
  $('#desk-panel').hidden = true;
  $('#dp-body').innerHTML = ''; // 顺带停掉正在播放的音视频
  document.body.classList.remove('desk-previewing');
}

function renderPanel(f) {
  offPanelFmt?.();
  const body = $('#dp-body');
  const sizes = f.originalSize && f.originalSize !== f.size ? `${fmtSize(f.size)}（原 ${fmtSize(f.originalSize)}）` : fmtSize(f.size);
  const dims = f.width && f.height ? `${f.width} × ${f.height} · ` : '';
  body.innerHTML = `
    <div class="dmedia"></div>
    <h2 class="dp-name"></h2>
    <p class="facts">${dims}${sizes}<br>${fmtLong(f.createdAt)} 上传</p>
    <div class="fmtrow">复制为 <span class="seg"></span></div>
    <pre class="code"></pre>
    <div class="dacts"></div>`;
  body.scrollTop = 0;
  renderPreview($('.dmedia', body), f);
  $('.dp-name', body).textContent = f.name || '未命名';

  const code = $('.code', body);
  const sync = () => { code.textContent = formatLink(f); };
  sync();
  const offSwitch = fmtSwitch($('.fmtrow .seg', body));
  const offSync = onFmtChange(sync);
  offPanelFmt = () => { offSwitch(); offSync(); };

  const open = Object.assign(document.createElement('a'), {
    className: 'textbtn', href: f.url, target: '_blank', rel: 'noopener',
    textContent: `${f.kind === 'image' ? '看原图' : f.kind === 'other' ? '下载' : '打开'} ↗`,
  });
  const trash = Object.assign(document.createElement('button'), { type: 'button', className: 'textbtn danger edit-only', textContent: '移入回收站' });
  trash.addEventListener('click', () => {
    clearSelection();
    selectedKeys.add(`f:${f.id}`);
    deleteSelected();
  });
  $('.dacts', body).append(
    copyButton(() => code.textContent, { className: 'btn primary' }),
    open,
    Object.assign(document.createElement('span'), { className: 'grow' }),
    trash,
  );
}
