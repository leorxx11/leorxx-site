# leorxx.xyz

个人站点，杂志排版风格。

```
home/            主页 leorxx.xyz（纯静态；manifest 和 Service Worker 整站共用）
img/             暗房 leorxx.xyz/darkroom，图片走 img.leorxx.xyz（Node 图床，存储在 Cloudflare R2，设计见 docs/darkroom-design.md）
  src/             后端：通行密钥登录、上传、底片库、废纸篓、出图、主页用的在线检测
  public/          页面（冲洗台 / 底片库 / 设置）
  cli.js           运维命令：setup-code、reindex
  Dockerfile       容器构建
deploy/          Caddy 和 compose 配置片段、一键部署脚本
```

## 部署（服务器 oracle_jp = 129.225.134.39）

服务器上 caddy、komari、darkroom 都在 `/opt/komari-server` 的 docker compose 里：

- 主页 → `/opt/komari-server/static/home`（caddy 已挂载 `static/`，容器内路径 `/srv/static/home`）
- 暗房源码 → `/srv/leorxx/img`，由 compose 构建成 `darkroom` 容器，不映射端口，只有 caddy 能访问
- 暗房数据库 → `/srv/leorxx/darkroom-data`（容器内 `/data`）

日常更新：`./deploy/deploy.sh`（`img/.env` 也会一起推上去）。

首次部署额外做过的两件事（已完成，留作记录）：

1. `deploy/compose.darkroom.yaml` 追加进 `docker-compose.yaml`
2. `deploy/Caddyfile.snippet` 追加进 `Caddyfile`，然后
   `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`

## 暗房登录

用通行密钥（指纹 / 面容）。没有可用设备时，在服务器上生成一次性初始化码，再到网页上绑定：

```bash
ssh oracle_jp sudo docker exec darkroom node cli.js setup-code
```

数据库丢了也不怕，重启时库是空的会自动从 R2 重建索引，也可以手动执行 `node cli.js reindex`。

## 本地调试暗房

```bash
cd img && cp .env.example .env   # 填好 R2 信息，ORIGIN 改成 http://localhost:3100，RP_ID 改成 localhost
npm install && npm start         # 初始化码会打印在终端里
```
