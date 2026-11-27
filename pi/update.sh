#!/usr/bin/env bash
# bored? updater. Cron runs this every 5 minutes.
# It pulls the latest image; only if there's a new version does it back up the
# database and restart the app. Otherwise it exits silently.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

# never run two updates at once
exec 9>.update.lock
flock -n 9 || exit 0

set -a; . ./.env; set +a
log() { echo "$(date '+%F %T') $*"; }

docker compose pull -q bored
latest=$(docker image inspect -f '{{.Id}}' "$BORED_IMAGE")
running=$(docker inspect -f '{{.Image}}' bored 2>/dev/null || true)
[ "$latest" = "$running" ] && exit 0

if [ -n "$running" ] && [ "$(docker inspect -f '{{.State.Running}}' bored)" = "true" ]; then
  stamp=$(date +%Y%m%d-%H%M%S)-$RANDOM
  log "New version found. Backing up the database to data/backups/bored-$stamp.db"
  docker exec bored sh -c "mkdir -p /data/backups && node --experimental-sqlite --disable-warning=ExperimentalWarning \
    -e \"new (require('node:sqlite').DatabaseSync)('/data/bored.db').exec(\\\"VACUUM INTO '/data/backups/bored-$stamp.db'\\\")\" \
    && ls -1t /data/backups/*.db | tail -n +11 | xargs -r rm --" \
    || log "Backup failed, updating anyway"
fi

docker compose up -d --remove-orphans
docker image prune -f > /dev/null
version=$(docker exec bored sh -c 'echo $APP_VERSION' 2>/dev/null || echo unknown)
log "Now running version $version"
