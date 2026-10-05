#!/usr/bin/env bash
# 部署主页和暗房：./deploy/deploy.sh
# 服务器上 caddy、komari、darkroom 都在 /opt/komari-server 的 docker compose 里
# 换服务器：SERVER=别的ssh别名 ./deploy/deploy.sh
set -euo pipefail

SERVER="${SERVER:-oracle_jp}"
STACK=/opt/komari-server
SYNC=(rsync -az --rsync-path="sudo rsync")
cd "$(dirname "$0")/.."

echo "→ 主页"
ssh "$SERVER" "sudo mkdir -p $STACK/static/home /srv/leorxx/img"
"${SYNC[@]}" --delete home/ "$SERVER:$STACK/static/home/"
ssh "$SERVER" "sudo chmod -R a+rX $STACK/static/home"

echo "→ 暗房"
"${SYNC[@]}" --delete --exclude node_modules --exclude .env --exclude data img/ "$SERVER:/srv/leorxx/img/"
if [ -f img/.env ]; then
  "${SYNC[@]}" img/.env "$SERVER:/srv/leorxx/img/.env"
  ssh "$SERVER" "sudo chown root:root /srv/leorxx/img/.env && sudo chmod 600 /srv/leorxx/img/.env"
fi
ssh "$SERVER" "cd $STACK && sudo docker compose up -d --build darkroom && sleep 2 && sudo docker compose ps darkroom --format '{{.Name}} {{.Status}}'"

echo "✓ 部署完成"
