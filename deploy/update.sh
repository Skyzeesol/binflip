#!/usr/bin/env bash
# Pull the latest code, rebuild, migrate and restart. Run as the app user in the repo directory.
#   ./deploy/update.sh          # dry-run stack (default)
#   ./deploy/update.sh --live   # with docker-compose.live.yml
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=(-f docker-compose.yml)
[ "${1:-}" = "--live" ] && FILES+=(-f docker-compose.live.yml)

[ -f .env ] || { echo ".env missing (cp .env.example .env and fill it)"; exit 1; }
grep -q '^SESSION_SECRET=.\{32,\}' .env || { echo "SESSION_SECRET missing or too short in .env (openssl rand -base64 48)"; exit 1; }

before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)
echo "code: $before -> $after"

docker compose "${FILES[@]}" build
docker compose "${FILES[@]}" up -d
echo "waiting for health..."
for _ in $(seq 1 40); do
  unhealthy=$(docker compose "${FILES[@]}" ps --format '{{.Service}} {{.Status}}' | grep -vE '\(healthy\)|Exited \(0\)' || true)
  [ -z "$unhealthy" ] && break
  sleep 3
done
docker compose "${FILES[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
if [ -n "${unhealthy:-}" ]; then
  echo "!! not healthy yet:"; echo "$unhealthy"
  echo "   logs: docker compose logs --tail 100 <service>   rollback: git checkout $before && $0 ${1:-}"
  exit 1
fi
echo "OK"
