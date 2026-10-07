// MCP 服务：让 AI 直接列出、搜索、读取、上传暗房里的文件
// Streamable HTTP 传输，无状态：每个 POST 是一条（或一批）JSON-RPC 消息，直接回 JSON，不开 SSE
// 地址 /api/mcp，令牌放 Authorization: Bearer；不支持自定义请求头的客户端用 /api/mcp/<令牌>

import { createHash } from 'node:crypto';
import { config } from './config.js';
import { apiTokenScopes } from './auth.js';
import { HttpError, readBody, send } from './http.js';
import { activeFile, forAi, listPage, storeFile } from './images.js';
import { getObject } from './r2.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const TEXT_DEFAULT = 100 * 1024;
const TEXT_MAX = 400 * 1024;
const IMAGE_MAX = 5 * 1024 * 1024;   // 再大的图模型也看不清，还容易超出客户端限制
const PDF_MAX = 20 * 1024 * 1024;
const UPLOAD_MAX = 15 * 1024 * 1024; // base64 之后约 20 MB，在 Caddy 的请求体上限之内

const INSTRUCTIONS = `暗房（Darkroom）是 Leo 的私人云端文件库，存着图片、文档、PDF、音视频等。
用 list_files 按文件名关键词、类型、月份查找文件；用 read_file 读内容（文本可分段读，图片和 PDF 直接给原文件）；有上传权限时可以用 upload_file 存文件。
每个文件都有一个公开但猜不到的链接（url），可以直接给用户。`;

// ---------- 工具 ----------
const TOOLS = [
  {
    scope: 'read',
    name: 'list_files',
    title: '列出 / 搜索文件',
    description: '按时间倒序列出暗房里的文件。query 搜原文件名（空格分开的词都要命中，不搜内容）。返回每个文件的 id、名字、类型、大小、链接；内容用 read_file 读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '文件名关键词，比如「合同 2026」' },
        kind: { type: 'string', enum: ['image', 'file', 'text', 'pdf', 'audio', 'video'], description: 'image 是图片，file 是图片以外的全部，其余是具体类型' },
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: '上传月份（北京时间），比如 2026-10' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        cursor: { type: 'string', description: '翻页：上一次返回的 next_cursor' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: listFiles,
  },
  {
    scope: 'read',
    name: 'read_file',
    title: '读取文件',
    description: `读一个文件的内容。文本类（md、txt、代码、json、csv……）按 UTF-8 返回，大文件用 offset 分段读（单位是字节，返回里有 next_offset）；图片（≤${IMAGE_MAX / 1024 / 1024} MB）直接返回图像；PDF（≤${PDF_MAX / 1024 / 1024} MB）作为附件返回；音视频和其他格式只返回信息和链接。`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'list_files 返回的 id' },
        offset: { type: 'integer', minimum: 0, default: 0, description: '仅文本：从第几个字节开始读' },
        max_bytes: { type: 'integer', minimum: 1024, maximum: TEXT_MAX, default: TEXT_DEFAULT, description: '仅文本：这次最多读多少字节' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: readFile,
  },
  {
    scope: 'upload',
    name: 'upload_file',
    title: '上传文件',
    description: `把一个文件存进暗房，返回它的链接。文本内容放 text，二进制（图片、PDF 等）放 base64，二选一，上限 ${UPLOAD_MAX / 1024 / 1024} MB。文件类型按 name 的扩展名判断，所以名字要带扩展名。同样的内容传过会直接返回原来的链接。`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名，带扩展名，比如 会议纪要-1007.md' },
        text: { type: 'string', description: '文本内容（UTF-8）' },
        base64: { type: 'string', description: '二进制内容的 base64' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: uploadFile,
  },
];

const toolsFor = (scopes) => TOOLS.filter((t) => scopes.includes(t.scope));
const textResult = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });
const json = (v) => JSON.stringify(v, null, 1);

async function listFiles(args) {
  const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Number(args.limit) || 30))) });
  if (args.query) params.set('q', String(args.query));
  if (args.kind) params.set('kind', String(args.kind));
  if (args.month) params.set('month', String(args.month));
  if (args.cursor) params.set('cursor', String(args.cursor));
  const page = listPage(new URL(`http://x/?${params}`));
  const out = { files: page.items.map(forAi), next_cursor: page.nextCursor };
  const summary = page.items.length ? `找到 ${page.items.length} 个文件${page.nextCursor ? '（还有更多，用 next_cursor 翻页）' : ''}。` : '没有找到匹配的文件。';
  return textResult(`${summary}\n${json(out)}`, { structuredContent: out });
}

async function fetchBytes(key, range) {
  const r = await getObject(key, range ? { headers: { range } } : {});
  if (!r.ok) throw new Error(`读取文件失败（${r.status}）`);
  return Buffer.from(await r.arrayBuffer());
}

// 按字节分段读文本：开头跳过被截断的 UTF-8 续字节，结尾去掉不完整的字符
function utf8Window(buf, atStart, atEnd) {
  let start = 0;
  if (!atStart) while (start < buf.length && start < 4 && (buf[start] & 0xc0) === 0x80) start++;
  let end = buf.length;
  if (!atEnd) {
    let i = end - 1;
    while (i >= start && end - i <= 4 && (buf[i] & 0xc0) === 0x80) i--;
    if (i >= start) {
      const lead = buf[i];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (end - i < need) end = i;
    }
  }
  return { text: buf.subarray(start, end).toString('utf8'), start, end };
}

async function readFile(args) {
  const file = activeFile(Number(args.id));
  const info = forAi(file);
  const header = `${file.name || '未命名'}（id ${file.id}，${file.mime}，${file.size} 字节）\n链接：${file.url}`;

  if (file.kind === 'text') {
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const maxBytes = Math.min(TEXT_MAX, Math.max(1024, Math.floor(Number(args.max_bytes) || TEXT_DEFAULT)));
    if (offset >= file.size) return textResult(`${header}\n\noffset 超出文件大小。`);
    const last = Math.min(file.size, offset + maxBytes) - 1;
    const buf = await fetchBytes(file.key, offset === 0 && last === file.size - 1 ? null : `bytes=${offset}-${last}`);
    const atEnd = last === file.size - 1;
    const { text, end } = utf8Window(buf, offset === 0, atEnd);
    const next = atEnd ? null : offset + end;
    const range = offset === 0 && atEnd ? '' : `\n本段：第 ${offset} 到 ${offset + end} 字节${next === null ? '（已到结尾）' : `；继续读用 offset=${next}`}`;
    return textResult(`${header}${range}\n\n${text}`, { structuredContent: { ...info, offset, next_offset: next, text } });
  }

  if (file.kind === 'image' && file.size <= IMAGE_MAX) {
    const buf = await fetchBytes(file.key);
    return { content: [{ type: 'text', text: header }, { type: 'image', data: buf.toString('base64'), mimeType: file.mime }] };
  }

  if (file.kind === 'pdf' && file.size <= PDF_MAX) {
    const buf = await fetchBytes(file.key);
    return {
      content: [
        { type: 'text', text: `${header}\nPDF 原文件作为附件返回；如果读不到附件，可以直接打开上面的链接。` },
        { type: 'resource', resource: { uri: file.url, mimeType: 'application/pdf', blob: buf.toString('base64') } },
      ],
    };
  }

  const why = file.kind === 'image' || file.kind === 'pdf' ? '文件太大，不直接返回内容' : '这种格式没法直接读成文字';
  return textResult(`${header}\n\n${why}，可以把链接交给用户或其他工具处理。`, { structuredContent: info });
}

async function uploadFile(args) {
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name 不能为空');
  const hasText = typeof args.text === 'string';
  const hasB64 = typeof args.base64 === 'string';
  if (hasText === hasB64) throw new Error('text 和 base64 要给且只给一个');
  const buf = hasText ? Buffer.from(args.text, 'utf8') : Buffer.from(args.base64, 'base64');
  if (buf.length > UPLOAD_MAX) throw new Error(`超过 ${UPLOAD_MAX / 1024 / 1024} MB，太大的文件请用网页上传`);
  const sourceHash = createHash('sha256').update(buf).digest('hex');
  const { image, duplicate } = await storeFile(buf, { name, sourceHash });
  const info = forAi(image);
  return textResult(`${duplicate ? '同样的内容之前传过，返回原来的文件' : '已上传'}：${info.name}\nid ${info.id} · ${info.mime} · ${info.size} 字节\n链接：${info.url}`,
    { structuredContent: { ...info, duplicate: !!duplicate } });
}

// ---------- JSON-RPC ----------
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function dispatch(msg, scopes) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // 客户端发来的响应（比如回应我们的请求）直接忽略；格式不对的请求报错
    return msg && ('result' in msg || 'error' in msg) ? null : rpcError(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const p = msg.params || {};

  switch (msg.method) {
    case 'initialize': {
      const asked = p.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'darkroom', title: '暗房', version: '1.0.0', websiteUrl: `${config.origin}/darkroom` },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: toolsFor(scopes).map(({ scope, run, ...t }) => t) });
    case 'tools/call': {
      const tool = toolsFor(scopes).find((t) => t.name === p.name);
      if (!tool) {
        const exists = TOOLS.some((t) => t.name === p.name);
        return isNotification ? null : rpcError(msg.id, -32602, exists ? `这个令牌没有 ${p.name} 需要的权限` : `没有工具 ${p.name}`);
      }
      try {
        return ok(await tool.run(p.arguments || {}));
      } catch (err) {
        // 工具自己的错误（文件不存在、参数不对）交给模型看，让它自己调整
        if (!(err instanceof HttpError) || err.status >= 500) console.error('MCP 工具出错：', err);
        return ok(textResult(err.message || '出错了', { isError: true }));
      }
    }
    default:
      if (isNotification || msg.method.startsWith('notifications/')) return null;
      return rpcError(msg.id, -32601, `不支持 ${msg.method}`);
  }
}

export async function handleMcp(req, res, pathToken) {
  // 无状态服务：不提供服务端推送的 SSE 流，也没有会话可删
  if (req.method !== 'POST') return send(res, 405, { error: '只支持 POST' }, { allow: 'POST' });
  const scopes = apiTokenScopes(req, pathToken || undefined);

  let body;
  try { body = JSON.parse((await readBody(req, UPLOAD_MAX * 1.4 + 64 * 1024)).toString('utf8')); }
  catch (err) {
    if (err instanceof HttpError) throw err;
    return send(res, 400, rpcError(null, -32700, 'Parse error'));
  }

  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((m) => dispatch(m, scopes)))).filter(Boolean);
  if (!replies.length) { res.writeHead(202); return res.end(); }
  send(res, 200, batch ? replies : replies[0]);
}
