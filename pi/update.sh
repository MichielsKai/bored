#!/usr/bin/env bash
# bored? updater. Cron runs this every 5 minutes.
# It pulls the latest image; only if there's a new version does it back up the
# database, refresh these Pi files from the new image, and restart the app.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
umask 077

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
  docker exec bored sh -c "umask 077 && mkdir -p /data/backups && node --experimental-sqlite --disable-warning=ExperimentalWarning \
    -e \"new (require('node:sqlite').DatabaseSync)('/data/bored.db').exec(\\\"VACUUM INTO '/data/backups/bored-$stamp.db'\\\")\" \
    && ls -1t /data/backups/*.db | tail -n +11 | xargs -r rm --" \
    || log "Backup failed, updating anyway"
fi

# Keep the Pi files (this script and docker-compose.yml) in step with the app version.
for f in docker-compose.yml update.sh; do
  tmp=$(mktemp -p . ".$f.XXXXXX")
  if docker run --rm --network none --entrypoint cat "$BORED_IMAGE" "/app/pi/$f" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    if [ "$f" = update.sh ]; then chmod 700 "$tmp"; else chmod 600 "$tmp"; fi
    mv -f "$tmp" "$f"
  else
    rm -f "$tmp"
  fi
done

docker compose up -d --remove-orphans
docker image prune -f > /dev/null
version=$(docker exec bored sh -c 'echo $APP_VERSION' 2>/dev/null || echo unknown)
log "Now running version $version"
