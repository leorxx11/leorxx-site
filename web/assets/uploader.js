// 共享文件上传与浏览器端图片处理：SHA-256 查重、WebP 压缩抹除 EXIF、生成缩略图、上传至 R2

import { api, store, unauthorized } from './lib.js';

export const getUploadPrefs = () => ({
  webp: store.get('darkroom-webp') !== '0',
  quality: Number(store.get('darkroom-q') || 85),
  maxWidth: Number(store.get('darkroom-maxw') || 0),
});

export function setUploadPref(key, val) {
  store.set(key, String(val));
}

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function encode(bmp, w, h, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function compressImage(file, bmp) {
  const prefs = getUploadPrefs();
  const result = { blob: file, width: bmp?.width ?? null, height: bmp?.height ?? null };
  if (!bmp || file.type === 'image/gif') return result;

  const maxW = prefs.maxWidth;
  const resize = maxW > 0 && bmp.width > maxW;
  const toWebp = prefs.webp && ['image/png', 'image/jpeg'].includes(file.type);
  if (!resize && !toWebp) return result;

  const w = resize ? maxW : bmp.width;
  const h = resize ? Math.round(bmp.height * maxW / bmp.width) : bmp.height;
  const type = toWebp || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? 'image/webp' : file.type;
  const blob = await encode(bmp, w, h, type, prefs.quality / 100);
  if (!blob || blob.type !== type) return result;
  if (!resize && blob.size >= file.size) return result;
  return { blob, width: w, height: h };
}

async function makeThumbnail(bmp) {
  const scale = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
  const blob = await encode(bmp, Math.round(bmp.width * scale), Math.round(bmp.height * scale), 'image/webp', 0.75);
  return blob?.type === 'image/webp' ? blob : null;
}

function sendXhr(blob, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/images');
    for (const [k, v] of Object.entries(headers)) if (v != null) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let body = null;
      try { body = JSON.parse(x.responseText); } catch {}
      if (x.status === 401) unauthorized();
      x.status === 200 ? resolve(body) : reject(new Error(body?.error || `出错了（${x.status}）`));
    };
    x.onerror = () => reject(new Error('网络断了'));
    x.send(blob);
  });
}

export function normalizeFileName(file) {
  const isImage = file.type.startsWith('image/');
  return !isImage || (file.name && file.name !== 'image.png')
    ? (file.name || '未命名')
    : `截图-${new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/: ]/g, '')}.png`;
}

// 上传单个文件，支持传入画布落点坐标 { x, y, rot } 和上传进度回调 onProgress(0..1)
export async function uploadFileToDesk(file, { x = null, y = null, rot = null, onProgress } = {}) {
  const isImage = file.type.startsWith('image/');
  const name = normalizeFileName(file);
  let bmp = null;

  try {
    const hash = await sha256(await file.arrayBuffer());
    const { image: existing } = await api(`/api/images/by-hash/${hash}`);
    if (existing) {
      // 之前传过：如果这次给了落点，把它挪到松手的地方
      if (x !== null && y !== null) {
        const nrot = rot ?? existing.rot ?? 0;
        await api('/api/desk', {
          method: 'PATCH',
          body: { files: [{ id: existing.id, x, y, rot: nrot }] },
        }).catch(() => {});
        existing.x = x;
        existing.y = y;
        existing.rot = nrot;
      }
      return { image: existing, duplicate: true };
    }

    if (isImage) {
      try { bmp = await createImageBitmap(file); } catch {}
    }
    const out = await compressImage(file, bmp);
    const thumb = bmp ? await makeThumbnail(bmp) : null;

    const { image, duplicate } = await sendXhr(out.blob, {
      'x-filename': encodeURIComponent(name),
      'x-source-hash': hash,
      'x-original-size': file.size,
      'x-width': out.width,
      'x-height': out.height,
      'x-desk-x': x !== null ? Math.round(x) : null,
      'x-desk-y': y !== null ? Math.round(y) : null,
      'x-desk-rot': rot !== null ? rot : null,
    }, onProgress);

    if (thumb && !duplicate && image.kind === 'image') {
      const updated = await api(`/api/images/${image.id}/thumb`, { method: 'PUT', body: thumb }).catch(() => null);
      if (updated?.image) return { image: updated.image, duplicate: false };
    }
    return { image, duplicate: !!duplicate };
  } finally {
    bmp?.close?.();
  }
}
