#!/usr/bin/env bash
# Daily Postgres backup with 14-day retention. Install as a cron job of the app user:
#   crontab -e  →  17 3 * * * /home/binflip/binflip/deploy/backup.sh >> /home/binflip/binflip-data/backup.log 2>&1
# The keystore is NOT included: it is already encrypted, back it up once by hand (see README, step 6).
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-$HOME/binflip-data/backups}"
mkdir -p "$DEST" && chmod 700 "$DEST"
f="$DEST/binflip-$(date -u +%Y%m%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U binflip -d binflip | gzip > "$f"
chmod 600 "$f"
find "$DEST" -name 'binflip-*.sql.gz' -mtime +14 -delete
echo "$(date -u +%FT%TZ) backup ok: $f ($(du -h "$f" | cut -f1))"
[ -f keystore/agent.json ] && [ ! -f "$DEST/.keystore-reminded" ] && { echo "reminder: copy keystore/agent.json off this server once (README step 6)"; touch "$DEST/.keystore-reminded"; }
exit 0
