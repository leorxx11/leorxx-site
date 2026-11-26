// 文件预览：列表详情页和画布右侧预览面板共用
// 图片按原比例不裁切、文本（只读前 256 KB）、PDF、音视频；其他只显示扩展名

import { esc, extLabel, fmtSize } from './lib.js';

const TEXT_PREVIEW_BYTES = 256 * 1024;
const PLAY = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L4.9 2.3a.6.6 0 0 0-.9.5Z"/></svg>';

function bars(n, seed) {
  let s = seed || 7, out = '';
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    out += `<i style="height:${(14 + (s / 233280) * 60 * Math.sin(((i + .5) / n) * Math.PI) + 6).toFixed(0)}%"></i>`;
  }
  return out;
}

// 没有缩略图的文件，按类型画个示意
export function placeholder(it, big = false) {
  const tag = `<span class="ext tag">${esc(extLabel(it.name))}</span>`;
  switch (it.kind) {
    case 'pdf': return `<div class="ph"><div class="sheet"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>${tag}`;
    case 'text': return `<div class="ph"><div class="sheet txt"><i></i><i></i><i></i><i></i><i></i></div></div>${tag}`;
    case 'audio': return `<div class="ph aud">${bars(big ? 48 : 28, it.id)}</div>${big ? '' : tag}`;
    case 'video': return `<div class="ph vid"><span class="play">${PLAY}</span></div>${tag}`;
    default: return `<div class="ph"><span class="ext">${esc(extLabel(it.name))}</span></div>`;
  }
}

// box 是一个 .dmedia 容器，按文件类型往里放预览
export function renderPreview(box, it) {
  box.className = `dmedia ${it.kind}`;
  const el = (tag, props) => box.appendChild(Object.assign(document.createElement(tag), props));
  if (it.kind === 'image') {
    if (it.width && it.height) { box.style.setProperty('--w', it.width); box.style.setProperty('--h', it.height); }
    else box.classList.add('unknown');
    if (it.thumb && it.thumb !== it.url) box.style.backgroundImage = `url("${it.thumb}")`;
    el('img', { alt: it.name || '', src: it.url, decoding: 'async' });
  } else if (it.kind === 'pdf') {
    el('iframe', { src: it.url, title: it.name || 'PDF' });
  } else if (it.kind === 'audio') {
    box.insertAdjacentHTML('beforeend', placeholder(it, true));
    el('audio', { src: it.url, controls: true, preload: 'metadata' });
  } else if (it.kind === 'video') {
    el('video', { src: it.url, controls: true, preload: 'metadata', playsInline: true });
  } else if (it.kind === 'text') {
    loadText(el('pre', { textContent: '读取中…' }), it);
  } else {
    el('span', { className: 'ext', textContent: extLabel(it.name) });
  }
}

async function loadText(pre, it) {
  try {
    // 不用 Range 请求头：跨域时会触发预检，读够了直接断开
    const r = await fetch(it.url);
    if (!r.ok) throw new Error(`读取失败（${r.status}）`);
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < TEXT_PREVIEW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    const cut = it.size > TEXT_PREVIEW_BYTES;
    const text = new TextDecoder().decode(cut ? bytes.subarray(0, TEXT_PREVIEW_BYTES) : bytes);
    if (pre.isConnected) pre.textContent = text + (cut ? `\n\n…… 只预览前 ${fmtSize(TEXT_PREVIEW_BYTES)}，完整内容点「打开」` : '');
  } catch (err) {
    if (pre.isConnected) pre.textContent = err.message;
  }
}
