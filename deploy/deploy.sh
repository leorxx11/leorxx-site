#!/usr/bin/env bash
# 部署整站（主页 + 桌面，同一个容器）：./deploy/deploy.sh
# 服务器上 caddy、komari、darkroom 都在 /opt/komari-server 的 docker compose 里
# 换服务器：SERVER=别的ssh别名 ./deploy/deploy.sh
set -euo pipefail

SERVER="${SERVER:-oracle_jp}"
STACK=/opt/komari-server
SYNC=(rsync -az --rsync-path="sudo rsync")
cd "$(dirname "$0")/.."

# 服务器上的构建目录，compose.darkroom.yaml 里的 build 和 env_file 指向这里
APP_DIR=/srv/leorxx/img

echo "→ 同步代码"
ssh "$SERVER" "sudo mkdir -p $APP_DIR"
# 只同步镜像需要的文件；没列出的（.env 等）不会被删
"${SYNC[@]}" --delete \
  --include '/package.json' --include '/package-lock.json' --include '/Dockerfile' --include '/.dockerignore' \
  --include '/src/***' --include '/web/***' --exclude '*' \
  ./ "$SERVER:$APP_DIR/"
# 以前的目录结构留下的文件
ssh "$SERVER" "cd $APP_DIR && sudo rm -rf home public cli.js"
if [ -f .env ]; then
  "${SYNC[@]}" .env "$SERVER:$APP_DIR/.env"
  ssh "$SERVER" "sudo chown root:root $APP_DIR/.env && sudo chmod 600 $APP_DIR/.env"
fi

echo "→ 构建并重启"
ssh "$SERVER" "cd $STACK && sudo docker compose up -d --build darkroom && sleep 2 && sudo docker compose ps darkroom --format '{{.Name}} {{.Status}}'"

echo "✓ 部署完成"
