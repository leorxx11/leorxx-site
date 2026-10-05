# leorxx.xyz

个人站点，杂志排版风格。

```
home/            主页 leorxx.xyz（纯静态，单个 HTML）
img/             暗房 img.leorxx.xyz（Node 图床，存储在 Cloudflare R2）
  Dockerfile       容器构建
  server.js        后端：上传、出图、列表、删除，以及主页用的在线检测
  public/          上传页
deploy/          Caddy 和 compose 配置片段、一键部署脚本
```

## 部署（服务器 oracle_jp = 129.225.134.39）

服务器上 caddy、komari、darkroom 都在 `/opt/komari-server` 的 docker compose 里：

- 主页 → `/opt/komari-server/static/home`（caddy 已挂载 `static/`，容器内路径 `/srv/static/home`）
- 暗房源码 → `/srv/leorxx/img`，由 compose 构建成 `darkroom` 容器，不映射端口，只有 caddy 能访问

日常更新：`./deploy/deploy.sh`（`img/.env` 也会一起推上去）。

首次部署额外做过的两件事（已完成，留作记录）：

1. `deploy/compose.darkroom.yaml` 追加进 `docker-compose.yaml`
2. `deploy/Caddyfile.snippet` 追加进 `Caddyfile`，然后
   `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`

暗房登录口令就是 `.env` 里的 `UPLOAD_TOKEN`。

## 本地调试暗房

```bash
cd img && cp .env.example .env   # 填好 R2 信息
npm install && npm start         # http://127.0.0.1:3100
```

## PicGo / PicList 也想传到同一个桶

用 S3 插件：endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`，region `auto`，
自定义域名填 `https://img.leorxx.xyz/i`，路径格式用 `{year}/{month}/{fileName}`。
