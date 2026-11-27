#!/usr/bin/env bash
# One-time setup of bored? on the Pi. Run it from the folder you want the app in:
#   bash setup.sh ghcr.io/<your-github-name>/bored:latest
# Safe to run again; it keeps your data and settings.
set -euo pipefail
umask 077
IMAGE="${1:-}"
DIR="$(pwd)"

if [ -z "$IMAGE" ] && [ -f .env ]; then IMAGE=$(grep '^BORED_IMAGE=' .env | cut -d= -f2-); fi
if [ -z "$IMAGE" ]; then echo "Usage: bash setup.sh ghcr.io/<your-github-name>/bored:latest"; exit 1; fi
if ! docker info > /dev/null 2>&1; then
  echo "Docker isn't reachable for user $(whoami). Add yourself to the docker group:"
  echo "  sudo usermod -aG docker $(whoami)   (then log out and back in)"
  exit 1
fi

# Where does the Cloudflare tunnel run? If it's on the Pi itself (or in Docker with host
# networking), the app only needs to listen on localhost, so nothing else on your network can reach it.
detect_bind() {
  if systemctl is-active --quiet cloudflared 2>/dev/null; then echo 127.0.0.1; return; fi
  for pid in $(pgrep -x cloudflared 2>/dev/null || true); do
    if ! grep -qE 'docker|containerd|libpod' "/proc/$pid/cgroup" 2>/dev/null; then echo 127.0.0.1; return; fi
  done
  for c in $(docker ps --format '{{.ID}} {{.Image}}' | awk 'tolower($2) ~ /cloudflared/ {print $1}'); do
    if [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$c")" = host ]; then echo 127.0.0.1; return; fi
  done
  echo 0.0.0.0
}

echo "Getting the Pi files out of $IMAGE"
docker pull -q "$IMAGE" > /dev/null
for f in docker-compose.yml update.sh; do
  docker run --rm --network none --entrypoint cat "$IMAGE" "/app/pi/$f" > "$f"
done
chmod 700 update.sh
chmod 600 docker-compose.yml

if [ ! -f .env ]; then
  cat > .env <<EOF
BORED_IMAGE=$IMAGE
BORED_PORT=3000
TZ=Europe/Brussels
DEFAULT_HOURS_PER_UNLOCK=20
EOF
else
  sed -i "s#^BORED_IMAGE=.*#BORED_IMAGE=$IMAGE#" .env
fi
if ! grep -q '^BORED_BIND=' .env; then
  BIND=$(detect_bind)
  echo "BORED_BIND=$BIND" >> .env
  if [ "$BIND" = 127.0.0.1 ]; then
    echo "Found your Cloudflare tunnel on this Pi: the app will only accept connections from the Pi itself."
  else
    echo "Couldn't find a Cloudflare tunnel running on this Pi, so the app stays reachable on your network."
    echo "If your tunnel does run here, set BORED_BIND=127.0.0.1 in $DIR/.env and run this again."
  fi
fi
chmod 600 .env

mkdir -p data
# the app runs as uid 1000 inside the container
[ "$(stat -c %u data)" = "1000" ] || sudo chown 1000:1000 data
chmod 700 data 2>/dev/null || sudo chmod 700 data || true

docker compose up -d --remove-orphans

# check for updates every 5 minutes
CRON="*/5 * * * * $DIR/update.sh >> $DIR/update.log 2>&1"
( crontab -l 2>/dev/null | grep -v "$DIR/update.sh" || true; echo "$CRON" ) | crontab -

BIND=$(grep '^BORED_BIND=' .env | cut -d= -f2)
PORT=$(grep '^BORED_PORT=' .env | cut -d= -f2)
echo
if [ "$BIND" = 127.0.0.1 ]; then
  echo "bored? is running on http://localhost:$PORT (reachable through your Cloudflare tunnel)"
else
  echo "bored? is running on http://$(hostname -I | awk '{print $1}'):$PORT"
fi
echo "It checks for updates every 5 minutes. Log: $DIR/update.log"
