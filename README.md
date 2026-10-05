# Leo's corner

[leorxx.xyz](https://leorxx.xyz) 的源码：一个杂志排版风格的个人小站，加上一个只给自己用的图床「暗房」。两者在同一个域名下，可以合起来装成一个 PWA。

- **主页**：报头、目录、机房三个栏目。目录列出各个子站并显示在线状态，机房栏实时显示每台服务器的负载（数据来自 [Komari](https://github.com/komari-monitor/komari) 探针）。
- **暗房**：用通行密钥登录的私人图床，图片存在 Cloudflare R2。

## 暗房

| | |
|---|---|
| 冲洗台 | 拖拽、选文件或 ⌘V 粘贴截图上传；浏览器里转 WebP、限制最大宽度（顺带抹掉 EXIF 和定位）；按原文件哈希查重；上传完自动复制链接 / Markdown / HTML |
| 底片库 | 按月分组的缩略图、搜索原文件名、详情面板、键盘 ← → 切换、多选批量复制或删除 |
| 废纸篓 | 删除先放 30 天，可以恢复；放进废纸篓的图片链接立即失效 |
| 设置 | 管理通行密钥、退出其他设备、查看 R2 用量 |

几个设计上的取舍：

- **登录用通行密钥**：没有口令，也就没有可以爆破的东西。首次绑定、设备丢失后的恢复，都靠在服务器上生成的一次性初始化码。
- **会话放在 HttpOnly Cookie**：写操作要校验 `Origin`；页面的 CSP 只允许同源脚本。
- **图片单独一个子域名**：用户上传的内容和需要登录的页面不同源。上传时按文件头判断类型，不收 SVG；出图时带 `nosniff` 和 `sandbox`。
- **SQLite 只是索引**：图片的元信息同时写在 R2 对象的 metadata 里，数据库丢了可以从 R2 原样重建。
- **服务器不装图片库**：压缩、缩略图都在浏览器里做，后端只有 `aws4fetch` 和 `@simplewebauthn/server` 两个依赖。

完整设计见 [docs/darkroom-design.md](docs/darkroom-design.md)。

## 结构

```
home/                 主页，纯静态，由 Caddy 直接提供
  index.html
  manifest.json       整站共用的 PWA 配置
  sw.js               整站共用的 Service Worker
img/                  暗房，Node 22.13+，无框架
  src/                后端：路由、通行密钥与会话、图片与废纸篓、R2、SQLite
  public/             页面：冲洗台 / 底片库 / 设置（原生 ES 模块，不需要构建）
  cli.js              运维命令
  Dockerfile
deploy/
  Caddyfile.snippet   站点配置
  compose.darkroom.yaml
  deploy.sh           一键同步到服务器
docs/
```

线上的请求是这样走的：

```
leorxx.xyz            ─┬─ /                          → 主页静态文件
                       ├─ /darkroom /api/* /assets/* → darkroom 容器
                       ├─ /komari/*                  → Komari（主页读机房数据）
                       └─ /status                    → darkroom（服务器端探测各子站是否在线）
img.leorxx.xyz        ─── /i/*                       → darkroom 容器 → R2
```

Caddy、Komari、darkroom 跑在同一个 docker compose 里，darkroom 不映射端口，只有 Caddy 能访问。

## 部署

需要：一台跑着 docker compose + Caddy 的服务器、一个 Cloudflare R2 桶，以及一个域名。

1. **R2**：建一个桶，不需要开公开访问。再建一个 Account API 令牌，权限选「对象读和写」，只限这个桶。
2. **配置**：`cp img/.env.example img/.env`，填好 R2 信息和域名。
3. **compose**：把 `deploy/compose.darkroom.yaml` 加进服务器的 `docker-compose.yaml`。
4. **Caddy**：把 `deploy/Caddyfile.snippet` 加进 Caddyfile，然后 reload。
5. **同步代码**：`./deploy/deploy.sh`。主页、暗房源码和 `.env` 会同步过去，并构建、启动 darkroom 容器。服务器地址用环境变量 `SERVER` 指定 ssh 别名。
6. **绑定通行密钥**：`docker logs darkroom` 里能找到初始化码，打开 `/darkroom` 输入它，绑定第一把通行密钥。

`deploy.sh` 里的服务器路径（`/opt/komari-server`、`/srv/leorxx`）是按我的服务器写的，自己部署时改成你的路径。主页的文案、子站列表在 `home/index.html` 里，也需要按自己的情况改。

### 环境变量

| 变量 | 说明 |
|---|---|
| `ORIGIN` | 页面所在的源，暗房页面在它的 `/darkroom` 下，如 `https://leorxx.xyz` |
| `IMAGE_ORIGIN` | 图片链接用的源，如 `https://img.leorxx.xyz`；不填则与 `ORIGIN` 相同 |
| `RP_ID` | 通行密钥绑定的域名，用上级域名，各子域名都能用，如 `leorxx.xyz` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | R2 连接信息 |
| `MAX_MB` | 单张上限，默认 20 |
| `TRASH_DAYS` | 废纸篓保留天数，默认 30 |
| `STATUS_TARGETS` | 主页在线检测的目标，`名字=地址` 逗号分隔 |

## 运维

```bash
# 设备都丢了：生成新的初始化码（30 分钟有效，用过即作废），再到网页上绑定
docker exec darkroom node cli.js setup-code

# 从 R2 补全图片索引（启动时如果库是空的，也会自动执行一次）
docker exec darkroom node cli.js reindex
```

## 本地开发

```bash
cd img
cp .env.example .env    # ORIGIN=http://localhost:3100，RP_ID=localhost，删掉 IMAGE_ORIGIN
npm install
npm start               # 打开 http://localhost:3100/darkroom，初始化码打印在终端里
```

`localhost` 不用 HTTPS 也能使用通行密钥。主页是单个 HTML 文件，直接用浏览器打开就能看排版；机房和在线状态两栏，要部署到服务器上才有数据。
