// 运维命令，在容器里执行：docker exec darkroom node cli.js <命令>
//   setup-code   生成一次性初始化码，用来在新设备上绑定通行密钥（设备都丢了时的恢复手段）
//   reindex      从 R2 补全图片索引（数据库丢了或损坏时用）

const cmd = process.argv[2];

if (cmd === 'setup-code') {
  const { createSetupCode } = await import('./src/auth.js');
  console.log(`初始化码：${createSetupCode()}（30 分钟内有效，用过即作废）`);
} else if (cmd === 'reindex') {
  const { reindex } = await import('./src/images.js');
  await reindex();
} else {
  console.log('用法：node cli.js setup-code | reindex');
  process.exitCode = 1;
}
process.exit();
