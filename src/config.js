// 环境变量集中在这里读，缺了就启动失败

const env = process.env;

function required(name) {
  if (!env[name]) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return env[name];
}

// 页面所在的源（桌面页面在它的 /desk 下），比如 https://leorxx.xyz；本地调试用 http://localhost:3100
const ORIGIN = required('ORIGIN').replace(/\/$/, '');
// 文件外链用的源；本地调试时和 ORIGIN 相同
const IMAGE_ORIGIN = (env.IMAGE_ORIGIN || ORIGIN).replace(/\/$/, '');

export const config = {
  port: Number(env.PORT || 3100),
  host: env.HOST || '127.0.0.1',
  origin: ORIGIN,
  imageOrigin: IMAGE_ORIGIN,
  secureCookie: ORIGIN.startsWith('https://'),
  // 通行密钥绑定的域名，默认是 ORIGIN 的域名；改了以后已经绑定的通行密钥就不能用了
  rpID: env.RP_ID || new URL(ORIGIN).hostname,
  rpName: env.RP_NAME || '桌面',
  // 登录有效期；每天第一次访问自动续期，常用的设备基本不用再登录
  sessionDays: Number(env.SESSION_DAYS || 365),
  dbPath: env.DB_PATH || './data/darkroom.db',
  maxBytes: Number(env.MAX_MB || 20) * 1024 * 1024,
  maxFileBytes: Number(env.MAX_FILE_MB || 100) * 1024 * 1024,
  trashDays: Number(env.TRASH_DAYS || 30),
  r2: {
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
    endpoint: (env.R2_ENDPOINT || `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`).replace(/\/$/, ''),
  },
  // 主页子站在线检测：名字=地址，逗号分隔
  statusTargets: (env.STATUS_TARGETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]),
};
