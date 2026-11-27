#!/usr/bin/env bash
# bored? updater. Cron runs this every 5 minutes.
# It pulls the latest image; only if there's a new version does it back up the
# database, take a newer docker-compose.yml if it's still locked down, and restart the app.
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

# Take the new docker-compose.yml from the image, but only if it keeps the container locked
# down. This script itself is never replaced automatically: it runs on the Pi outside the
# container, so changing it stays a manual step (re-run setup.sh).
compose_is_safe() {
  local f=$1
  # nothing that gives the container more power or access to the Pi
  grep -Eiq 'privileged|cap_add|network_mode|docker\.sock|SYS_ADMIN|unconfined|^[[:space:]]*-?[[:space:]]*(pid|ipc|userns_mode|devices|volumes_from|cgroup_parent|source|target|bind|type|file|secrets|configs|build|extends|env_file|include|sysctls|device_cgroup_rules)[[:space:]]*:' "$f" && return 1
  # the only folders it may mount: ./data and a small /tmp
  grep -E ':/' "$f" | grep -Ev '^[[:space:]]*#|^[[:space:]]*-[[:space:]]*\./data:/data[[:space:]]*$|^[[:space:]]*-[[:space:]]*/tmp:size=[0-9a-z]+,mode=1777[[:space:]]*$' | grep -q . && return 1
  # and the hardening must still be there
  grep -Eq '^[[:space:]]*read_only:[[:space:]]*true' "$f" && grep -q 'no-new-privileges:true' "$f" && grep -A1 'cap_drop:' "$f" | grep -q 'ALL'
}
tmp=$(mktemp -p . .docker-compose.yml.XXXXXX)
if docker run --rm --network none --entrypoint cat "$BORED_IMAGE" /app/pi/docker-compose.yml > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
  if ! cmp -s "$tmp" docker-compose.yml; then
    if compose_is_safe "$tmp"; then chmod 600 "$tmp"; mv -f "$tmp" docker-compose.yml; log "Updated docker-compose.yml"
    else log "Skipped the new docker-compose.yml: it asks for more access than allowed"; fi
  fi
fi
rm -f "$tmp"
if docker run --rm --network none --entrypoint cat "$BORED_IMAGE" /app/pi/update.sh 2>/dev/null | cmp -s - update.sh; then :; else
  log "A newer update.sh is available. To install it, run: bash setup.sh"
fi

docker compose up -d --remove-orphans
docker image prune -f > /dev/null
version=$(docker exec bored sh -c 'node -p "require(\"./package.json\").version" 2>/dev/null; echo "($APP_VERSION)"' 2>/dev/null | tr '\n' ' ' || echo unknown)
log "Now running version $version"
