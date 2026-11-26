// 桌面画布接口：读取在桌文件与白板元素（便签、分区框、连线、手绘笔迹），批量保存布局

import { db, getMeta, setMeta, tx } from './db.js';
import { HttpError, readBody, send } from './http.js';
import { listDeskFiles } from './images.js';

const BOARD_KEY = 'desk_board';
const MAX_BOARD_BYTES = 2 * 1024 * 1024;
const EMPTY_BOARD = { notes: [], frames: [], connectors: [], strokes: [] };

const num = (v, min, max, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function loadBoard() {
  const raw = getMeta(BOARD_KEY);
  if (!raw) return EMPTY_BOARD;
  try {
    const b = JSON.parse(raw);
    return {
      notes: Array.isArray(b?.notes) ? b.notes : [],
      frames: Array.isArray(b?.frames) ? b.frames : [],
      connectors: Array.isArray(b?.connectors) ? b.connectors : [],
      strokes: Array.isArray(b?.strokes) ? b.strokes : [],
    };
  } catch {
    return EMPTY_BOARD;
  }
}

function sanitizeBoard(b) {
  const notes = (Array.isArray(b.notes) ? b.notes : []).slice(0, 500).map((n) => ({
    id: String(n.id || '').slice(0, 40),
    x: num(n.x, -1e5, 1e5),
    y: num(n.y, -1e5, 1e5),
    w: num(n.w, 120, 720, 204),
    rot: num(n.rot, -45, 45, 0),
    z: Math.trunc(num(n.z, 0, 1e9, 1)),
    tint: ['plain', 'amber', 'mint', 'rose'].includes(n.tint) ? n.tint : 'amber',
    text: String(n.text ?? '').slice(0, 8000),
  })).filter((n) => n.id);

  const frames = (Array.isArray(b.frames) ? b.frames : []).slice(0, 200).map((f) => ({
    id: String(f.id || '').slice(0, 40),
    title: String(f.title ?? '分区').slice(0, 80),
    x: num(f.x, -1e5, 1e5),
    y: num(f.y, -1e5, 1e5),
    w: num(f.w, 80, 2e4, 360),
    h: num(f.h, 80, 2e4, 260),
    // 散落模板自动加的分区框，换摆法时收走
    ...(f.auto === true ? { auto: true } : {}),
  })).filter((f) => f.id);

  const connectors = (Array.isArray(b.connectors) ? b.connectors : []).slice(0, 1000).map((c) => ({
    id: String(c.id || '').slice(0, 40),
    from: String(c.from || '').slice(0, 40),
    to: String(c.to || '').slice(0, 40),
  })).filter((c) => c.id && c.from && c.to && c.from !== c.to);

  const strokes = (Array.isArray(b.strokes) ? b.strokes : []).slice(0, 1000).map((s) => ({
    id: String(s.id || '').slice(0, 40),
    color: String(s.color || 'ink').slice(0, 24),
    width: num(s.width, 1, 16, 2.6),
    pts: (Array.isArray(s.pts) ? s.pts : []).slice(0, 1500)
      .map((p) => (Array.isArray(p) && p.length >= 2 ? [Number(num(p[0], -1e5, 1e5).toFixed(1)), Number(num(p[1], -1e5, 1e5).toFixed(1))] : null))
      .filter(Boolean),
  })).filter((s) => s.id && s.pts.length > 1);

  return { notes, frames, connectors, strokes };
}

export function ensurePlaced() {
  const unplaced = db.prepare('SELECT id FROM images WHERE x IS NULL OR y IS NULL ORDER BY created_at ASC, id ASC').all();
  if (!unplaced.length) return;
  const { maxZ } = db.prepare('SELECT COALESCE(MAX(z), 0) AS maxZ FROM images').get();
  const stmt = db.prepare('UPDATE images SET x = ?, y = ?, rot = ?, z = ? WHERE id = ?');
  tx(() => {
    unplaced.forEach((row, i) => {
      const angle = i * 2.39996;
      const radius = i === 0 ? 0 : 156 * Math.sqrt(i);
      const x = Math.round(Math.cos(angle) * radius * 1.2);
      const y = Math.round(Math.sin(angle) * radius * 0.86);
      const rot = Number((((i * 7 % 9) - 4) * 0.45).toFixed(2));
      stmt.run(x, y, rot, maxZ + i + 1, row.id);
    });
  });
}

export function handleGetDesk(req, res) {
  ensurePlaced();
  send(res, 200, { files: listDeskFiles(), board: loadBoard() });
}

export async function handlePatchDesk(req, res) {
  const raw = await readBody(req, MAX_BOARD_BYTES);
  let body = {};
  if (raw.length) {
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { throw new HttpError(400, '请求格式不对'); }
  }

  const updateFull = db.prepare('UPDATE images SET x = ?, y = ?, w = ?, rot = ?, z = ? WHERE id = ? AND deleted_at IS NULL');
  const getRow = db.prepare('SELECT x, y, w, rot, z FROM images WHERE id = ?');

  tx(() => {
    if (Array.isArray(body.files)) {
      for (const f of body.files.slice(0, 600)) {
        const id = Number(f?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const cur = getRow.get(id);
        if (!cur) continue;
        const x = f.x !== undefined ? num(f.x, -1e5, 1e5, cur.x ?? 0) : cur.x;
        const y = f.y !== undefined ? num(f.y, -1e5, 1e5, cur.y ?? 0) : cur.y;
        const w = f.w === null ? null : f.w !== undefined ? num(f.w, 110, 900, 216) : cur.w;
        const rot = f.rot !== undefined ? num(f.rot, -45, 45, cur.rot ?? 0) : cur.rot;
        const z = f.z !== undefined ? Math.trunc(num(f.z, 0, 1e9, cur.z ?? 0)) : cur.z;
        updateFull.run(x, y, w, rot, z, id);
      }
    }
    if (body.board && typeof body.board === 'object') {
      setMeta(BOARD_KEY, JSON.stringify(sanitizeBoard(body.board)));
    }
  });

  send(res, 200, { ok: true });
}
