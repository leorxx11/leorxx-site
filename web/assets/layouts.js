// 「散落」的几种摆法。每种都直接改卡片的 x、y、rot（卡片中心点，画布坐标）
// 传进来的卡片是 { key, isNote, data, w, h }，w、h 是卡片在页面上的实际宽高
// 摆完由 desk.js 整体挪到原点、调好镜头、保存；返回 [{ title, cards }] 的，每组外面套一个分区框
// step：同一种摆法连着点的第几次（从 0 开始），本身不随机的摆法用它换个变化，让每次点都有动静

import { fmtMonth } from './lib.js';

const GAP = 24;
const jitter = (n) => (Math.random() - 0.5) * n;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 上传时间：文件有 createdAt；便签的 id 里带着创建时间（desk.js 的 uid），看不出来的算 0
function timeOf(c) {
  if (!c.isNote) return Date.parse(c.data.createdAt) || 0;
  const t = parseInt(String(c.data.id).slice(2, -4), 36);
  return t > 1e12 && t < 1e13 ? t : 0;
}

// 北京时间的月份，和列表的按月分组一致
function monthOf(c) {
  if (!c.isNote && c.data.month) return c.data.month;
  const t = timeOf(c);
  return t ? new Date(t + 8 * 3600e3).toISOString().slice(0, 7) : '';
}

const newestFirst = (cards) => [...cards].sort((a, b) => timeOf(b) - timeOf(a));
const oldestFirst = (cards) => [...cards].sort((a, b) => timeOf(a) - timeOf(b));

// 瀑布流：按顺序把每张放进当前最矮的一列，左上角从 (x0, 0) 开始；返回占了多宽
function masonry(cards, cols, x0 = 0, gap = GAP) {
  cols = Math.min(cols, cards.length);
  const colW = Math.max(...cards.map((c) => c.w));
  const heights = new Array(cols).fill(0);
  for (const c of cards) {
    const i = heights.indexOf(Math.min(...heights));
    c.data.x = x0 + i * (colW + gap) + colW / 2;
    c.data.y = heights[i] + c.h / 2;
    c.data.rot = 0;
    heights[i] += c.h + gap;
  }
  return cols * (colW + gap) - gap;
}

const KIND_GROUPS = [
  ['图片', (c) => !c.isNote && c.data.kind === 'image'],
  ['文档', (c) => !c.isNote && !['image', 'audio', 'video'].includes(c.data.kind)],
  ['音视频', (c) => !c.isNote && ['audio', 'video'].includes(c.data.kind)],
  ['便签', (c) => c.isNote],
];

export const LAYOUTS = {
  // 随机：从中心按黄金角螺旋摊开，带一点随机
  spiral: {
    label: '随机',
    run(cards) {
      cards.forEach((c, i) => {
        const angle = i * 2.39996 + jitter(0.35);
        const radius = i === 0 ? 18 : 144 * Math.sqrt(i) + jitter(24);
        c.data.x = Math.cos(angle) * radius * 1.2;
        c.data.y = Math.sin(angle) * radius * 0.86;
        c.data.rot = jitter(4);
      });
    },
  },

  // 照片堆：都叠在中间，各自歪一点，叠放顺序也打乱
  pile: {
    label: '照片堆',
    run(cards, { raise }) {
      for (const c of shuffle(cards)) {
        c.data.x = jitter(120);
        c.data.y = jitter(90);
        c.data.rot = jitter(22);
        raise(c);
      }
    },
  },

  // 时间线：一个月一个分区。按上传时间从左到右排，每列最多三张；再点一次换成从上到下，每行最多五张
  timeline: {
    label: '时间线',
    run(cards, { step = 0 } = {}) {
      const ROWS = 3;
      const COLS = 5;
      const MONTH_GAP = 120;
      const months = new Map();
      for (const c of oldestFirst(cards)) {
        const m = monthOf(c);
        if (!months.has(m)) months.set(m, []);
        months.get(m).push(c);
      }
      // 看不出时间的（很早以前的便签）放在最后
      const ordered = [...months].sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1));
      const groups = ordered.map(([m, list]) => ({ title: m ? fmtMonth(m) : '更早', cards: list }));
      if (step % 2) {
        const colW = Math.max(...cards.map((c) => c.w));
        let y = 0;
        for (const { cards: list } of groups) {
          for (let i = 0; i < list.length; i += COLS) {
            const row = list.slice(i, i + COLS);
            const rowH = Math.max(...row.map((c) => c.h));
            row.forEach((c, j) => {
              c.data.x = j * (colW + GAP) + colW / 2;
              c.data.y = y + rowH / 2;
              c.data.rot = 0;
            });
            y += rowH + GAP;
          }
          y += MONTH_GAP - GAP;
        }
        return groups;
      }
      let x = 0;
      for (const [, list] of ordered) {
        for (let i = 0; i < list.length; i += ROWS) {
          const col = list.slice(i, i + ROWS);
          const colW = Math.max(...col.map((c) => c.w));
          let y = 0;
          for (const c of col) {
            c.data.x = x + colW / 2;
            c.data.y = y + c.h / 2;
            c.data.rot = 0;
            y += c.h + GAP;
          }
          x += colW + GAP;
        }
        x += MONTH_GAP - GAP;
      }
      return groups;
    },
  },

  // 分类：图片、文档、音视频、便签各成一堆，新的在前，每堆一个分区
  kinds: {
    label: '分类',
    run(cards) {
      const groups = [];
      let x = 0;
      for (const [title, test] of KIND_GROUPS) {
        const list = newestFirst(cards.filter(test));
        if (!list.length) continue;
        const width = masonry(list, Math.min(5, Math.ceil(Math.sqrt(list.length))), x);
        for (const c of list) {
          c.data.x += jitter(10);
          c.data.y += jitter(10);
          c.data.rot = jitter(3);
        }
        x += width + 120;
        groups.push({ title: `${title} · ${list.length}`, cards: list });
      }
      return groups;
    },
  },

  // 环形：围成一圈，中间留白；最里圈最多 16 张，多出来的往外一圈圈排，最新的在里面；再点一次转一格
  // 圈稍微压扁一点，横着更适合屏幕
  ring: {
    label: '环形',
    run(cards, { step = 0 } = {}) {
      const list = newestFirst(cards);
      const size = Math.max(...list.map((c) => Math.max(c.w, c.h))) + GAP; // 一张卡片在圈上占的长度
      let r = Math.max(size, (Math.min(list.length, 16) * size) / (2 * Math.PI));
      let ring = 0;
      for (let i = 0; i < list.length; ring++, r += size) {
        const take = Math.min(Math.max(6, Math.floor((2 * Math.PI * r) / size)), list.length - i);
        for (let j = 0; j < take; j++) {
          // 相邻两圈错开半格；再点一次整圈顺时针转一格
          const a = -Math.PI / 2 + ((j + (ring % 2) / 2 + step) / take) * 2 * Math.PI;
          const c = list[i + j];
          c.data.x = Math.cos(a) * r * 1.2;
          c.data.y = Math.sin(a) * r;
          c.data.rot = 0;
        }
        i += take;
      }
    },
  },

  // 扇形：像手里的一把牌，从左到右一张压一张；最多张开 80°（服务端只存 ±45° 的旋转）。再点一次洗牌
  fan: {
    label: '扇形',
    run(cards, { raise, step = 0 }) {
      const list = step ? shuffle(cards) : oldestFirst(cards);
      const n = list.length;
      const avgW = list.reduce((s, c) => s + c.w, 0) / n;
      const spread = (Math.min(80, 8 + n * 6) * Math.PI) / 180;
      // 相邻两张露出不到一半，像握在手里
      const R = Math.max(500, ((n - 1) * avgW * 0.45) / spread);
      list.forEach((c, i) => {
        const a = n === 1 ? 0 : -spread / 2 + (i / (n - 1)) * spread;
        c.data.x = R * Math.sin(a);
        c.data.y = R * (1 - Math.cos(a));
        c.data.rot = (a * 180) / Math.PI;
        raise(c);
      });
    },
  },

  // 拼贴墙：新的在前，按实际高度紧凑拼成几列；再点一次换列数（多一列、少一列、回到原样）
  masonry: {
    label: '拼贴墙',
    run(cards, { step = 0 } = {}) {
      const base = Math.round(Math.sqrt(cards.length * 1.3));
      const cols = Math.max(2, Math.min(9, base + [0, 1, -1][step % 3]));
      masonry(newestFirst(cards), cols, 0, 14);
    },
  },
};
