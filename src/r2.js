// Cloudflare R2（S3 兼容接口）读写

import { webcrypto } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { config } from './config.js';
import { HttpError } from './http.js';

// aws4fetch 用全局 crypto.subtle，老版本 Node 默认没有挂到全局
globalThis.crypto ??= webcrypto;

const client = new AwsClient({
  accessKeyId: config.r2.accessKeyId,
  secretAccessKey: config.r2.secretAccessKey,
  service: 's3',
  region: 'auto',
});
const bucketUrl = `${config.r2.endpoint}/${config.r2.bucket}`;
const objectUrl = (key) => `${bucketUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;

// metadata 只能是 ASCII，值统一 URI 编码
export async function putObject(key, body, type, meta = {}) {
  const headers = { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' };
  for (const [k, v] of Object.entries(meta)) {
    if (v !== null && v !== undefined && v !== '') headers[`x-amz-meta-${k}`] = encodeURIComponent(String(v));
  }
  const r = await client.fetch(objectUrl(key), { method: 'PUT', body, headers });
  if (!r.ok) throw new HttpError(502, `写入 R2 失败（${r.status}）`);
}

export async function deleteObject(key) {
  const r = await client.fetch(objectUrl(key), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new HttpError(502, `删除失败（${r.status}）`);
}

// 原样返回 R2 的响应，由调用方转发
export function getObject(key, { method = 'GET', headers = {} } = {}) {
  return client.fetch(objectUrl(key), { method, headers });
}

export async function headMeta(key) {
  const r = await client.fetch(objectUrl(key), { method: 'HEAD' });
  if (!r.ok) return null;
  const meta = {};
  for (const [k, v] of r.headers) {
    if (k.startsWith('x-amz-meta-')) {
      try { meta[k.slice(11)] = decodeURIComponent(v); } catch { meta[k.slice(11)] = v; }
    }
  }
  return { type: r.headers.get('content-type'), size: Number(r.headers.get('content-length')), meta };
}

const unxml = (s = '') => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e]));

export async function listAll() {
  const items = [];
  let token = null;
  do {
    const u = new URL(bucketUrl);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('max-keys', '1000');
    if (token) u.searchParams.set('continuation-token', token);
    const r = await client.fetch(u.toString());
    if (!r.ok) throw new HttpError(502, `读取 R2 列表失败（${r.status}）`);
    const xml = await r.text();
    for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (name) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
      items.push({ key: unxml(tag('Key')), size: Number(tag('Size')), time: Date.parse(tag('LastModified')) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unxml(xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1])
      : null;
  } while (token);
  return items;
}
