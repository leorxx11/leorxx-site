// 环境变量集中在这里读，缺了就启动失败

const env = process.env;

function required(name) {
  if (!env[name]) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return env[name];
}

// 页面的完整来源，比如 https://img.leorxx.xyz；本地调试用 http://localhost:3100
const ORIGIN = required('ORIGIN').replace(/\/$/, '');

export const config = {
  port: Number(env.PORT || 3100),
  host: env.HOST || '127.0.0.1',
  origin: ORIGIN,
  secureCookie: ORIGIN.startsWith('https://'),
  // 通行密钥绑定的域名；用上级域名，其他子域名以后也能复用
  rpID: env.RP_ID || new URL(ORIGIN).hostname,
  rpName: env.RP_NAME || '暗房',
  dbPath: env.DB_PATH || './data/darkroom.db',
  maxBytes: Number(env.MAX_MB || 20) * 1024 * 1024,
  trashDays: Number(env.TRASH_DAYS || 30),
  sessionDays: 30,
  r2: {
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
    endpoint: (env.R2_ENDPOINT || `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`).replace(/\/$/, ''),
  },
  // 主页「目录」在线检测：名字=地址，逗号分隔
  statusTargets: (env.STATUS_TARGETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]),
};
