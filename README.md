# Leo's corner

[leorxx.xyz](https://leorxx.xyz) 的源码：一个简洁的单栏个人小站，加上一个结合了无限白板画布与文件库的「桌面（Desk）」。两者由同一个 Node 服务提供，在同一个域名下，可以合起来装成一个 PWA。

- **主页**：一屏几段介绍文字，子站以小胶囊的形式嵌在句子里，图标上的小圆点显示在线状态；页脚是一个会自己写出来的签名。
- **桌面（`/desk`）**：白板画布与文件中转台，谁都能看，用通行密钥登录后才能改；文件存在 Cloudflare R2（旧路径 `/darkroom` 自动 302 跳转兼容）。

## 桌面

| | |
|---|---|
| 画布 | 全屏无限点阵画布：拖拽或 ⌘V 直接把图片/文件/剪贴板文字摊在桌面上（浏览器内自动转 WebP 并抹除 EXIF、哈希查重、复制链接）；内置框选、便签、卡片连线、手写批注、分区框、小地图、⌘K 搜索定位与多步撤销重做；一键「散落」成照片堆、时间线、分类、环形、扇形、拼贴墙等几种摆法；常用快捷键（⌘C / ⌘D / 方向键微调 / ⌘+ ⌘− / ⇧1 看全部，见 docs/design.md）；双击文件或点「预览」在右侧弹出预览面板，画布照常可以拖动 |
| 列表 | 和画布是同一批文件，换成按月分组的网格来看：搜索原文件名、按类型和月份筛选；点开是单独的详情页（可以一键在画布上找到它），键盘 ← → 切换；多选批量复制或删除 |
| 回收站 | 删除先放 30 天，可以恢复；移入回收站的文件外链立即失效 |
| 设置 | 没登录时这个标签叫「登录」，点进去是登录卡片。登录后：配置上传压缩参数和默认复制格式；管理通行密钥、退出其他设备；生成和吊销 API 令牌（给脚本和 MCP 用）；查看文件用量 |

几个设计上的取舍：

- **看是公开的，改要登录**：画布和列表谁都能打开看，相当于把桌面分享出去；访客可以预览、复制链接，也能在本地拖动卡片，但什么都不保存。上传、整理、删除、回收站和设置都要登录。
- **通行密钥，不设密码**：只有一个人用，浏览器里用指纹或面容登录，会话一年、每天自动续期，常用设备基本只登录一次。脚本和 AI 用 API 令牌，分「上传」「读取」两种权限，都不能删除。文件外链不需要登录，链接是猜不到的随机串。
- **同源校验与 CSP**：会话 Cookie 是 `HttpOnly; SameSite=Strict`，写操作再校验 `Origin`；页面的 CSP 只允许同源脚本。
- **图片单独一个子域名**：上传的文件和主站页面不同源。上传时按文件头判断类型，不收 SVG；出图时带 `nosniff` 和 `sandbox`。
- **SQLite 只是索引**：图片的元信息同时写在 R2 对象的 metadata 里，数据库丢了可以从 R2 原样重建。
- **服务器不装图片库**：压缩、缩略图都在浏览器里做，后端只依赖 `aws4fetch`（R2）和 `@simplewebauthn/server`（通行密钥）。

完整设计见 [docs/design.md](docs/design.md)。

## 结构

```
src/                  后端，一个 Node 服务（Node 22.13+，无框架）
  server.js           入口：页面与静态文件、接口路由
  images.js  desk.js  文件与回收站、画布布局同步
  mcp.js  r2.js  db.js  …
  cli.js              运维命令
web/                  前端，目录和网址一一对应（原生 ES 模块，不需要构建）
  home.html           主页（/），单个 HTML 文件
  desk.html           桌面（/desk）：无限画布 / 列表 / 设置
  assets/             桌面的脚本和样式
  fonts/              Inter 拉丁字符子集，自托管，主页和桌面共用（SIL Open Font License 1.1）
  manifest.json       整站共用的 PWA 配置
  sw.js               整站共用的 Service Worker
  favicon.svg  icon-*.png  avatar.webp
deploy/
  Caddyfile.snippet   站点配置
  compose.darkroom.yaml
  deploy.sh           一键同步到服务器
docs/design.md        设计文档
design/               原型和图标生成脚本，不参与部署
Dockerfile  package.json
```

线上的请求是这样走的：

```
leorxx.xyz            ─── 全部请求                → darkroom 容器
                            /                       主页
                            /desk  /assets/*        桌面页面（旧路径 /darkroom 302 到 /desk）
                            /api/*                  接口，包括主页用的在线检测 /api/status
                            /fonts/*  /sw.js  …     字体、图标、PWA 文件
img.leorxx.xyz        ─── /i/*                    → darkroom 容器 → R2
```

Caddy 只负责 HTTPS、压缩和转发。Caddy、darkroom 跑在同一个 docker compose 里，darkroom 不映射端口，只有 Caddy 能访问。

## 部署

需要：一台跑着 docker compose + Caddy 的服务器、一个 Cloudflare R2 桶，以及一个域名。

1. **R2**：建一个桶，不需要开公开访问。再建一个 Account API 令牌，权限选「对象读和写」，只限这个桶。
2. **配置**：`cp .env.example .env`，填好 R2 信息和域名。
3. **compose**：把 `deploy/compose.darkroom.yaml` 加进服务器的 `docker-compose.yaml`。
4. **Caddy**：把 `deploy/Caddyfile.snippet` 加进 Caddyfile，然后 reload。
5. **同步代码**：`./deploy/deploy.sh`。`src/`、`web/`、`Dockerfile` 和 `.env` 会同步过去，并构建、启动 darkroom 容器。服务器地址用环境变量 `SERVER` 指定 ssh 别名。
6. **绑定通行密钥**：第一次启动时还没有通行密钥，服务会在日志里打印一个初始化码（30 分钟有效）：`docker logs darkroom`。打开 `/desk`，输入初始化码，创建通行密钥。

`deploy.sh` 里的服务器路径（`/opt/komari-server`、`/srv/leorxx`）是按我的服务器写的，自己部署时改成你的路径。主页的文案、子站列表在 `web/home.html` 里，也需要按自己的情况改。

### 环境变量

| 变量 | 说明 |
|---|---|
| `ORIGIN` | 页面所在的源，桌面页面在它的 `/desk` 下，如 `https://leorxx.xyz` |
| `IMAGE_ORIGIN` | 图片链接用的源，如 `https://img.leorxx.xyz`；不填则与 `ORIGIN` 相同 |
| `RP_ID` | 通行密钥绑定的域名，默认取 `ORIGIN` 的域名；改了以后已经绑定的通行密钥就不能用了 |
| `SESSION_DAYS` | 登录有效期（天），默认 365，每天第一次访问自动续期 |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | R2 连接信息 |
| `MAX_MB` | 单张图片上限，默认 20 |
| `MAX_FILE_MB` | 其他文件上限，默认 100 |
| `TRASH_DAYS` | 回收站保留天数，默认 30 |
| `STORAGE_GB` | 设置页用量进度条的总量，默认 10（R2 免费额度） |
| `STATUS_TARGETS` | 主页在线检测的目标，`名字=地址` 逗号分隔 |

## 运维

```bash
# 生成一次性初始化码，在新设备上绑定通行密钥（设备全丢了时的恢复手段）
docker exec darkroom node src/cli.js setup-code

# API 令牌也可以在命令行里管理（令牌只显示一次）
docker exec darkroom node src/cli.js token-create 我的项目 upload,read
docker exec darkroom node src/cli.js token-list
docker exec darkroom node src/cli.js token-revoke 我的项目

# 从 R2 补全文件索引（启动时如果库是空的，也会自动执行一次）
docker exec darkroom node src/cli.js reindex
```

## 本地开发

```bash
cp .env.example .env    # ORIGIN=http://localhost:3100，删掉 IMAGE_ORIGIN 和 RP_ID
npm install
npm start               # 主页 http://localhost:3100/，桌面 http://localhost:3100/desk
```

本地跑起来就是完整的整站，字体、图标、Service Worker 都和线上一样。通行密钥在 `localhost` 上也能用，第一次的初始化码会打印在终端里。子站的在线状态要在 `.env` 里配好 `STATUS_TARGETS` 才有数据。
