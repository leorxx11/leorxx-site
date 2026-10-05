# 暗房 Darkroom 设计

只给 Leo 一个人用的图床。图片存 Cloudflare R2，服务跑在 oracle_jp 的 docker compose 里，由 Caddy 反代到 `img.leorxx.xyz`。

## 已定的取舍

| 问题 | 决定 |
|---|---|
| 登录 | 通行密钥（Passkey），不再有口令 |
| 删除 | 先进废纸篓，30 天后自动彻底删除 |
| 相册 / 标签 | 第一版不做 |
| PicGo / PicList 等客户端 | 不支持，只用网页上传 |

## 登录

### 为什么是通行密钥

口令要么难记（随机长串），要么好猜（短密码，可被爆破）。通行密钥是存在设备里的一对密钥，服务器只保存公钥：没有可猜的东西，也不怕钓鱼。苹果设备之间经 iCloud 钥匙串自动同步，别人的电脑可以扫码用手机登录。

RP ID 用 `leorxx.xyz`（而非 `img.leorxx.xyz`），以后其他子域名也能复用同一把密钥。

### 流程

- **首次绑定**：库里一把密钥都没有时，服务启动会生成一次性初始化码（`XXXX-XXXX`，30 分钟有效）并打印到日志：`docker logs darkroom`。网页输入初始化码 → 创建通行密钥 → 直接登录。
- **日常登录**：点「用通行密钥进入」→ 指纹 / 面容 → 拿到会话。
- **加设备**：已登录时在「设置」里添加；或在新设备上用初始化码绑定。
- **恢复**：设备全丢了，SSH 到服务器执行 `docker exec darkroom node cli.js setup-code` 生成新的初始化码。能 SSH 的只有本人，这就是恢复通道。
- 初始化码用过即作废；同一 IP 连续输错会被锁 10 分钟，全局输错 10 次该码作废。

### 会话

- 登录成功发一个随机 32 字节令牌，放在 `dr_session` Cookie：`HttpOnly; Secure; SameSite=Strict`，页面脚本读不到。
- 库里只存令牌的 SHA-256。30 天有效，期间每天首次访问自动续期。
- 所有写操作额外校验 `Origin` 头，防跨站请求。
- 设置页可「退出其他设备」。

## 数据

R2 的列表接口只给文件名、大小、时间，所以另建索引：Node 自带的 SQLite（`node:sqlite`），文件在 Docker volume `/data/darkroom.db`。

```
images     id, key, thumb_key, name, mime, size, original_size, width, height,
           source_hash, created_at, deleted_at
passkeys   id, public_key, counter, transports, name, created_at, last_used_at
sessions   token_hash, created_at, expires_at, user_agent
meta       k, v                      -- WebAuthn user id、初始化码哈希与过期时间
```

- 图片元信息同时写进 R2 对象的 metadata（`x-amz-meta-*`），数据库丢了可以 `node cli.js reindex` 从 R2 重建，丢库不丢图。
- `source_hash` 是**原文件**的 SHA-256（压缩前）。同一张图再传，直接返回已有链接。
- 对象路径：原图 `2026/10/<id>.<ext>`，缩略图 `thumbs/2026/10/<id>.webp`。

## 上传（冲洗台）

全部在浏览器里处理，服务器不装图片库：

1. 算原文件哈希，查重；已存在就直接给链接。
2. 按选项处理：转 WebP（PNG / JPEG）、限制最大宽度、质量。重新编码会顺带抹掉 EXIF 和定位。GIF 原样上传（保留动画）。处理后反而更大就用原文件。
3. 生成 480px 的 WebP 缩略图。
4. 上传原图（带进度），再上传缩略图。
5. 结果行：代码块显示当前格式（链接 / Markdown / HTML），一个「复制」按钮，上传完自动复制。

服务器按文件头判断类型，只收 PNG / JPEG / GIF / WebP / AVIF，不收 SVG。

## 底片库

- 按月分组（「2026 年 10 月 · 12 张」），滚动到底自动加载。
- 搜原文件名、按月份筛选。
- 点开一张：右侧（手机上是底部）详情面板，显示大图、原文件名、尺寸、大小与压缩比、时间，格式切换 + 代码块 + 复制，看原图，移到废纸篓。键盘 ← → 切换，Esc 关闭。
- 多选：批量复制链接（一行一条）、批量移到废纸篓。
- 废纸篓：显示剩余天数，可恢复或立即彻底删除，也可一键清空。进了废纸篓的图片链接立即 404。

## 设置

- 通行密钥列表（设备名、添加时间、最近使用），添加 / 删除（最后一把不能删）。
- 退出当前设备 / 退出其他设备。
- 用量：张数、占用空间、R2 免费额度 10 GB。

## 出图

`GET /i/<key>` 由服务从 R2 读出转发，带一年的 `immutable` 缓存头和 `nosniff`、`sandbox` CSP。只对库里存在且未删除的图片出图，其他路径一律 404。

## 接口

```
GET    /api/auth/state                    { authed, hasPasskey }
POST   /api/auth/register/options         { setupCode? } → 创建密钥参数（需会话或初始化码）
POST   /api/auth/register/verify          { response, name? }
POST   /api/auth/login/options
POST   /api/auth/login/verify             { response }
POST   /api/auth/logout                   { others? }
GET    /api/passkeys
DELETE /api/passkeys/:id

POST   /api/images                        原始字节 + x-filename / x-source-hash / x-original-size / x-width / x-height
PUT    /api/images/:id/thumb              缩略图字节
GET    /api/images?cursor&q&month&limit   列表（未删除）
GET    /api/images/months                 [{ month, count }]
GET    /api/images/by-hash/:hash          查重
POST   /api/images/trash                  { ids } 移到废纸篓
GET    /api/trash                         废纸篓列表
POST   /api/trash/restore                 { ids }
POST   /api/trash/purge                   { ids? } 彻底删除；不带 ids 即清空
GET    /api/stats

GET    /i/<key>                           出图
GET    /api/status                        主页用的在线检测
GET    /api/health
```

## 代码结构

```
img/
  src/
    server.js     路由与启动
    config.js     环境变量
    http.js       请求 / 响应工具、Cookie、错误
    db.js         SQLite 表结构与查询
    r2.js         R2 读写
    auth.js       通行密钥、会话、初始化码
    images.js     图片、废纸篓、出图、定时清理
  cli.js          setup-code / reindex
  public/         页面（脚本拆成 ES 模块，CSP 只允许同源脚本）
```

## 以后再说

相册与标签、粘贴网址抓图、防盗链、服务器端本地缓存、主页展示「最近冲洗」。
