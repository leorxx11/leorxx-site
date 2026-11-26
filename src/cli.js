// 运维命令，在容器里执行：docker exec darkroom node src/cli.js <命令>
//   setup-code                          生成一次性初始化码，在新设备上绑定通行密钥（设备都丢了时的恢复手段）
//   token-create <名字> [upload,read]   生成 API 令牌（只显示这一次），默认只能上传
//   token-list / token-revoke <名字>
//   reindex                             从 R2 补全文件索引（数据库丢了或损坏时用）
// 本地：npm run reindex，或 node --env-file=.env src/cli.js <命令>

const USAGE = '用法：node src/cli.js setup-code | token-create <名字> [upload,read] | token-list | token-revoke <名字> | reindex';
const cmd = process.argv[2];

if (cmd === 'setup-code') {
  const { createSetupCode } = await import('./auth.js');
  console.log(`初始化码：${createSetupCode()}（30 分钟内有效，用过即作废）`);
} else if (cmd === 'token-create') {
  const name = process.argv[3];
  if (!name) { console.log('用法：node src/cli.js token-create <名字> [upload,read]'); process.exit(1); }
  const { createApiToken, TOKEN_SCOPES } = await import('./auth.js');
  const scopes = (process.argv[4] || 'upload').split(',').filter((s) => TOKEN_SCOPES.includes(s));
  if (!scopes.length) { console.log(`权限只能是 ${TOKEN_SCOPES.join(' / ')}`); process.exit(1); }
  console.log(`令牌（只显示这一次，请保存）：${createApiToken(name, scopes)}`);
} else if (cmd === 'token-list') {
  const { listApiTokens } = await import('./auth.js');
  for (const t of listApiTokens()) {
    console.log(t.name, t.scopes, new Date(t.created_at).toISOString(), t.last_used_at ? new Date(t.last_used_at).toISOString() : '从未使用');
  }
} else if (cmd === 'token-revoke') {
  const { revokeApiToken } = await import('./auth.js');
  console.log(revokeApiToken(process.argv[3]) ? '已吊销' : '没有这个名字');
} else if (cmd === 'reindex') {
  const { reindex } = await import('./images.js');
  await reindex();
} else {
  console.log(USAGE);
  process.exitCode = 1;
}
process.exit();
