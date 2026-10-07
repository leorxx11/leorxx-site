// 运维命令，在容器里执行：docker exec darkroom node cli.js <命令>
//   setup-code   生成一次性初始化码，用来在新设备上绑定通行密钥（设备都丢了时的恢复手段）
//   token-create <名字>   生成上传用的 API 令牌（只显示这一次）
//   token-list / token-revoke <名字>
//   reindex      从 R2 补全图片索引（数据库丢了或损坏时用）

const cmd = process.argv[2];

if (cmd === 'setup-code') {
  const { createSetupCode } = await import('./src/auth.js');
  console.log(`初始化码：${createSetupCode()}（30 分钟内有效，用过即作废）`);
} else if (cmd === 'token-create') {
  const name = process.argv[3];
  if (!name) { console.log('用法：node cli.js token-create <名字>'); process.exit(1); }
  const { createApiToken } = await import('./src/auth.js');
  console.log(`令牌（只显示这一次，请保存）：${createApiToken(name)}`);
} else if (cmd === 'token-list') {
  const { listApiTokens } = await import('./src/auth.js');
  for (const t of listApiTokens()) console.log(t.name, new Date(t.created_at).toISOString(), t.last_used_at ? new Date(t.last_used_at).toISOString() : '从未使用');
} else if (cmd === 'token-revoke') {
  const { revokeApiToken } = await import('./src/auth.js');
  console.log(revokeApiToken(process.argv[3]) ? '已吊销' : '没有这个名字');
} else if (cmd === 'reindex') {
  const { reindex } = await import('./src/images.js');
  await reindex();
} else {
  console.log('用法：node cli.js setup-code | token-create <名字> | token-list | token-revoke <名字> | reindex');
  process.exitCode = 1;
}
process.exit();
