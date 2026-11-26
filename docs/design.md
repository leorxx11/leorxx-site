# leorxx.xyz 设计

整站是一个 Node 服务（`src/`），同时提供主页、桌面（Desk）和接口。文件本体存 Cloudflare R2，元信息和画布布局存 SQLite。服务跑在服务器的 docker compose 里，Caddy 只负责 HTTPS、压缩和转发。

## 地址

| 地址 | 内容 |
|---|---|
| `leorxx.xyz/` | 主页，单个 HTML 文件（`web/home.html`） |
| `leorxx.xyz/desk` | 桌面：画布 `#desk`、列表 `#library`、设置 `#settings`，同一个页面（`web/desk.html`）；没登录时只显示登录页 |
| `leorxx.xyz/darkroom` | 旧地址，302 到 `/desk` |
| `leorxx.xyz/api/*` | 接口 |
| `img.leorxx.xyz/i/*` | 出文件。上传的内容放在单独的子域名上，和页面不同源；这个域名的其他地址都 302 到 `/desk` |

主页和桌面同源，合起来装成一个 PWA，`manifest.json` 和 `sw.js` 整站共用。桌面以前单独跑在 `img.leorxx.xyz`，那边的 `/sw.js` 现在返回一个自我注销的脚本，清掉旧的 Service Worker。

## 目录

```
src/
  server.js     入口：页面与静态文件、接口路由、主页的在线检测、定时清理回收站
  config.js     环境变量
  http.js       读请求体、回响应、HttpError
  db.js         SQLite 表结构
  auth.js       通行密钥、会话、初始化码、API 令牌
  r2.js         R2 读写（aws4fetch）
  images.js     文件：上传、列表、回收站、出文件、从 R2 重建索引
  desk.js       画布布局：文件坐标、便签、分区、连线、手写
  mcp.js        MCP 服务
  cli.js        运维命令（setup-code、token-*、reindex）
web/            目录和网址一一对应
  home.html     /
  desk.html     /desk
  assets/       /assets/*，桌面的脚本和样式（原生 ES 模块，不需要构建）
  fonts/        /fonts/*，Inter 拉丁字符子集，主页和桌面共用
  manifest.json  sw.js  favicon.svg  icon-*.png  avatar.webp
```

`web/` 下只有白名单里的扩展名能直接访问（css、js、json、图片、woff2），两个 `.html` 只能从 `/` 和 `/desk` 打开。

## 登录

只有一个人用，不设账号密码。

| 谁 | 怎么证明身份 | 能访问 |
|---|---|---|
| 浏览器 | 通行密钥登录后拿到的会话 Cookie | 页面上的所有接口 |
| 脚本 | API 令牌，`Authorization: Bearer` | 按权限：`POST /api/v1/upload`（上传）、`GET /api/v1/files`（读取） |
| AI | 同一种令牌，或者把令牌放在地址里 `/api/mcp/<令牌>` | MCP，工具按权限给 |
| 任何人 | 不用 | 主页、`/api/status`、`/api/health`、`/i/*` 文件外链 |

哪些接口要登录、哪些要令牌，在 `server.js` 的路由表里逐条标注；没标注的默认要登录，新加的接口不会忘了保护。

### 通行密钥

- 通行密钥是存在设备里的一对密钥，服务器只保存公钥：没有可猜的东西，也不怕钓鱼网站。苹果设备之间经 iCloud 钥匙串自动同步，别人的电脑可以扫码用手机登录。
- RP ID 默认是 `ORIGIN` 的域名（`leorxx.xyz`），改了以后已经绑定的通行密钥就不能用了。
- **首次绑定**：库里一把都没有时，服务启动会生成一次性初始化码（`XXXX-XXXX`，30 分钟有效）打到日志里，网页上输入后创建通行密钥并直接登录。
- **加设备**：已登录时在「设置」里添加；或者在新设备上用初始化码绑定。
- **恢复**：设备全丢了，SSH 到服务器执行 `docker exec darkroom node src/cli.js setup-code` 生成新的初始化码。能 SSH 的只有本人，这就是恢复通道。
- 初始化码用过即作废；同一 IP 10 分钟内输错 5 次会被暂时拒绝，全局输错 10 次该码作废。
- 最后一把通行密钥不能删。

### 会话

- 登录成功发一个随机 32 字节令牌，放在 `dr_session` Cookie：`HttpOnly; SameSite=Strict`，线上再加 `Secure`，页面脚本读不到，别的网站也带不上。
- 库里只存令牌的 SHA-256。有效期 `SESSION_DAYS`（默认 365 天），每天第一次访问自动续期，常用的设备基本只登录一次。
- 设置页可以「退出其他设备」，让除了当前这台以外的会话全部失效。

### API 令牌

- 两种权限：「上传」和「读取」（列出、搜索、读文件），都不能删除。在设置页生成、吊销，或者用命令行 `token-create / token-list / token-revoke`。
- 令牌形如 `dr_xxx`，明文只在生成时显示一次，库里只存 SHA-256，记录最近使用时间。
- 同一 IP 10 分钟内用错令牌 20 次，之后一段时间内的令牌请求都会被拒绝。

## 页面与缓存

- **CSP**：桌面只允许同源脚本（`script-src 'self'`）；主页的脚本和样式写在页面里，允许内联。两边都禁止被嵌入（`frame-ancestors 'none'`）。
- **缓存**：静态文件都带 ETag，没变就回 304。字体缓存 30 天，图片 1 天，页面、脚本和 PWA 配置每次都先确认一次。
- **Service Worker**：页面和脚本网络优先，断网时用缓存打开；`/api/` 和 `/i/` 一律直连网络。改了缓存列表要同时改 `sw.js` 里的 `CACHE` 版本号。
- **页面切换**：画布、列表、设置共用一个顶栏，切换时用 View Transition 淡入淡出，顶栏不动；主页和桌面之间也有跨页面的 View Transition。

## 数据

R2 的列表接口只给文件名、大小、时间，所以另建索引：Node 自带的 SQLite（`node:sqlite`），线上在 Docker volume 里的 `/data/darkroom.db`。

```
images   id, key, thumb_key, name, mime, size, original_size, width, height,
         source_hash, created_at, deleted_at,
         x, y, w, rot, z                       -- 在画布上的位置、宽度、倾角、层级
meta     k, v                                  -- desk_board：便签、分区、连线、手写（JSON）；初始化码哈希
passkeys    id, public_key, counter, transports, name, created_at, last_used_at
sessions    token_hash, created_at, expires_at, user_agent
api_tokens  token_hash, name, scopes, created_at, last_used_at
```

- 文件元信息同时写进 R2 对象的 metadata（`x-amz-meta-*`）。数据库丢了可以从 R2 重建（启动时库是空的会自动执行一次），丢库不丢文件；画布布局不在 R2 里，重建后文件会重新排开。
- `source_hash` 是**原文件**（压缩前）的 SHA-256。同样的文件再传，直接返回已有的链接。
- 对象路径：原文件 `2026/10/<id>.<ext>`，缩略图 `thumbs/2026/10/<id>.webp`。
- 画布和列表是同一批文件：没进回收站的都在画布上。新文件没有坐标时，打开画布会自动排开。

## 上传

图片在浏览器里处理，服务器不装图片库：

1. 算原文件哈希，查重；已存在就直接给链接（拖到画布上的会移到放下的位置）。
2. 按设置里的选项转 WebP、限制最大宽度和质量。重新编码会顺带抹掉 EXIF 和定位；GIF 原样上传以保留动画；处理后反而更大就用原文件。
3. 生成 480px 的 WebP 缩略图，先传原文件再传缩略图。

其他文件原样存进 R2，不压缩（上限 `MAX_FILE_MB`，默认 100 MB）。图片按文件头判断类型，不收 SVG。

## 出文件

`GET /i/<key>` 由服务从 R2 读出转发，带一年的 `immutable` 缓存、`nosniff` 和 `sandbox` CSP。只给库里存在且没进回收站的文件，其他一律 404。

- 链接里是随机串，猜不到；知道链接就能读，进回收站立即失效。
- 类型以库里为准（按扩展名定，不信任客户端）：文本类（含 HTML、SVG、JS）一律 `text/plain; charset=utf-8`，浏览器不会执行；PDF、音视频按原类型内联；其他一律下载。
- PDF 的响应不带 `sandbox`（Chrome 的 PDF 阅读器在 sandbox 里打不开）。
- 预览：文本读前 256 KB，PDF 用浏览器自带阅读器，音视频用播放器，其他只显示扩展名。

## 回收站

删除先放 30 天（`TRASH_DAYS`），可以恢复，也可以立即彻底删除；服务每小时清理一次过期的。在画布上删除可以撤销。

## 接口

浏览器发来的写操作（带 `Origin` 头）只接受同源。没有特别说明的都要登录。

```
GET    /api/auth/state                    { authed, hasPasskey }                    公开
POST   /api/auth/login/options | verify   通行密钥登录                              公开
POST   /api/auth/register/options | verify  添加通行密钥：已登录，或者带 { setupCode }  公开
POST   /api/auth/logout                   { others? } 退出这台 / 其他设备
GET    /api/passkeys                      { passkeys, sessions }
DELETE /api/passkeys/:id
GET    /api/tokens
POST   /api/tokens                        { name, scopes } → { token }（只返回这一次）
DELETE /api/tokens/:id

GET    /api/desk                          { files, board } 画布上的文件和布局
PATCH  /api/desk                          { files?: [{ id, x?, y?, w?, rot?, z? }], board? }

POST   /api/images                        原始字节 + x-filename / x-source-hash / x-original-size / x-width / x-height
PUT    /api/images/:id/thumb              缩略图字节
GET    /api/images?cursor&q&kind&month&limit
GET    /api/images/months                 [{ month, count }]
GET    /api/images/by-hash/:hash          查重
POST   /api/images/trash                  { ids }
GET    /api/trash
POST   /api/trash/restore                 { ids }
POST   /api/trash/purge                   { ids? } 不带 ids 即清空
GET    /api/stats

POST   /api/v1/upload                     令牌（上传）：请求体是文件原始字节，X-Filename 可选
GET    /api/v1/files?q&kind&month&limit&cursor    令牌（读取）
GET    /api/v1/files/:id                  令牌（读取）
POST   /api/mcp  /api/mcp/<令牌>          令牌，工具按权限给

GET    /api/status                        公开：主页用的在线检测（服务器端探测 STATUS_TARGETS）
GET    /api/health                        公开
GET    /i/<key>                           公开：出文件
```

`/api/v1/files`：`q` 搜原文件名（空格分开的词都要命中），`kind` 是 `image` / `file` / `text` / `pdf` / `audio` / `video`，`month` 形如 `2026-10`，`limit` ≤ 100，`cursor` 用上一页返回的 `nextCursor`。返回的 `url` 可以直接读。

## MCP

`src/mcp.js`，Streamable HTTP 传输，无状态：每个 POST 是一条或一批 JSON-RPC 消息，直接回 JSON，不开 SSE（GET 回 405）。不用 SDK，只实现 initialize / ping / tools/list / tools/call。

令牌放 `Authorization: Bearer`；只能填地址的客户端（Claude 的自定义连接器等）用 `/api/mcp/<令牌>`，这个地址就等于令牌本身，别外传。`tools/list` 只列出令牌有权限的工具。

- `list_files`（读取）：列出、搜索文件，参数同 `/api/v1/files`。
- `read_file`（读取）：文本按字节分段读（默认 100 KB，最多 400 KB，对齐 UTF-8 字符边界，返回 `next_offset`）；图片 ≤ 5 MB 返回图像；PDF ≤ 20 MB 作为附件返回；其他只给信息和链接。
- `upload_file`（上传）：`text` 或 `base64` 二选一，≤ 15 MB，类型按文件名扩展名判断，按内容哈希查重。

## 运维

```
docker exec darkroom node src/cli.js setup-code                        # 一次性初始化码
docker exec darkroom node src/cli.js token-create 我的项目 upload,read   # 生成令牌，默认只能上传
docker exec darkroom node src/cli.js token-list
docker exec darkroom node src/cli.js token-revoke 我的项目
docker exec darkroom node src/cli.js reindex                           # 从 R2 补全文件索引
```

服务器上的容器、目录名（`darkroom`、`/srv/leorxx/img`、`/srv/leorxx/darkroom-data`）沿用早期的名字，改名要同时改 `deploy/` 里的配置和服务器上的 compose。
