// 冲洗台：在浏览器里压缩、生成缩略图，再上传

import { $, $$, api, copyButton, fmtLabel, fmtSize, fmtSwitch, formatLink, onFmtChange, store, toast } from './lib.js';

const optWebp = $('#opt-webp');
const optQuality = $('#opt-quality');
const optWidth = $('#opt-width');

export function init() {
  optWebp.checked = store.get('darkroom-webp') !== '0';
  optQuality.value = store.get('darkroom-q') || 85;
  optWidth.value = store.get('darkroom-maxw') || '0';
  $('#opt-quality-out').textContent = optQuality.value;
  optWebp.addEventListener('change', () => store.set('darkroom-webp', optWebp.checked ? '1' : '0'));
  optQuality.addEventListener('input', () => { $('#opt-quality-out').textContent = optQuality.value; store.set('darkroom-q', optQuality.value); });
  optWidth.addEventListener('change', () => store.set('darkroom-maxw', optWidth.value));

  fmtSwitch($('[data-fmt-switch]'));
  onFmtChange(() => $$('#queue li[data-url]').forEach((li) => {
    li.querySelector('.code').textContent = formatLink(li.dataset.url, li.dataset.name);
  }));

  const drop = $('#drop');
  $('#file').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  document.addEventListener('paste', (e) => {
    if ($('#view-develop').hidden || !e.clipboardData?.files.length) return;
    e.preventDefault();
    handleFiles(e.clipboardData.files);
  });
}

async function handleFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) { toast('只收图片'); return; }
  for (const f of imgs) await handleFile(f);
}

// ---------- 图片处理 ----------
async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function encode(bmp, w, h, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// 按选项压缩：GIF 原样（保留动画）；转码后反而更大、又不需要缩小时，用原文件
async function develop(file, bmp) {
  const result = { blob: file, width: bmp?.width ?? null, height: bmp?.height ?? null };
  if (!bmp || file.type === 'image/gif') return result;

  const maxW = Number(optWidth.value);
  const resize = maxW > 0 && bmp.width > maxW;
  const toWebp = optWebp.checked && ['image/png', 'image/jpeg'].includes(file.type);
  if (!resize && !toWebp) return result;

  const w = resize ? maxW : bmp.width;
  const h = resize ? Math.round(bmp.height * maxW / bmp.width) : bmp.height;
  const type = toWebp || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? 'image/webp' : file.type;
  const blob = await encode(bmp, w, h, type, optQuality.value / 100);
  if (!blob || blob.type !== type) return result; // 浏览器不支持这种编码
  if (!resize && blob.size >= file.size) return result;
  return { blob, width: w, height: h };
}

async function thumbnail(bmp) {
  const scale = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
  const blob = await encode(bmp, Math.round(bmp.width * scale), Math.round(bmp.height * scale), 'image/webp', 0.75);
  return blob?.type === 'image/webp' ? blob : null;
}

function upload(blob, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/images');
    for (const [k, v] of Object.entries(headers)) if (v != null) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let body = null; try { body = JSON.parse(x.responseText); } catch {}
      if (x.status === 401) window.dispatchEvent(new Event('darkroom:logout'));
      x.status === 200 ? resolve(body) : reject(new Error(body?.error || `出错了（${x.status}）`));
    };
    x.onerror = () => reject(new Error('网络断了'));
    x.send(blob);
  });
}

// ---------- 一行冲洗记录 ----------
function newRow(file, name) {
  const li = document.createElement('li');
  li.innerHTML = `<img alt=""><div><div class="name"></div><div class="meta">显影中…</div><div class="progress"><i></i></div></div><div class="acts"></div>`;
  li.querySelector('img').src = URL.createObjectURL(file);
  li.querySelector('.name').textContent = name;
  $('#queue').prepend(li);
  return li;
}

async function finishRow(li, image, metaText, autoCopy) {
  li.querySelector('.progress')?.remove();
  li.dataset.url = image.url;
  li.dataset.name = image.name;
  const meta = li.querySelector('.meta');
  meta.className = 'meta ok';
  meta.textContent = metaText;
  const code = Object.assign(document.createElement('pre'), { className: 'code', textContent: formatLink(image.url, image.name) });
  meta.after(code);
  const btn = copyButton(() => code.textContent);
  li.querySelector('.acts').append(btn);
  if (autoCopy) {
    await navigator.clipboard?.writeText(code.textContent).then(() => btn.flash(), () => {});
  }
}

function failRow(li, message) {
  li.querySelector('.progress')?.remove();
  const meta = li.querySelector('.meta');
  meta.className = 'meta bad';
  meta.textContent = '冲洗失败：' + message;
}

async function handleFile(file) {
  const name = file.name && file.name !== 'image.png'
    ? file.name
    : `截图-${new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/: ]/g, '')}.png`;
  const li = newRow(file, name);
  const meta = li.querySelector('.meta');
  const bar = li.querySelector('.progress i');
  let bmp = null;
  try {
    const hash = await sha256(await file.arrayBuffer());
    const { image: existing } = await api(`/api/images/by-hash/${hash}`);
    if (existing) {
      await finishRow(li, existing, '之前冲洗过，直接用原来的链接', true);
      toast(`之前冲洗过，${fmtLabel()} 已复制`);
      return;
    }

    try { bmp = await createImageBitmap(file); } catch {}
    const out = await develop(file, bmp);
    const thumb = bmp ? await thumbnail(bmp) : null;
    const sizes = out.blob !== file ? `${fmtSize(file.size)} → ${fmtSize(out.blob.size)}` : fmtSize(file.size);
    meta.textContent = '冲洗中… ' + sizes;

    const { image, duplicate } = await upload(out.blob, {
      'x-filename': encodeURIComponent(name),
      'x-source-hash': hash,
      'x-original-size': file.size,
      'x-width': out.width,
      'x-height': out.height,
    }, (p) => { bar.style.width = (p * 100).toFixed(0) + '%'; });

    if (thumb && !duplicate) {
      await api(`/api/images/${image.id}/thumb`, { method: 'PUT', body: thumb }).catch(() => {});
    }
    await finishRow(li, image, duplicate ? '之前冲洗过，直接用原来的链接' : `已冲洗 · ${sizes}`, true);
    toast(`已冲洗，${fmtLabel()} 已复制`);
    window.dispatchEvent(new Event('darkroom:changed'));
  } catch (err) {
    failRow(li, err.message);
  } finally {
    bmp?.close?.();
  }
}
