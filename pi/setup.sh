#!/usr/bin/env bash
# One-time setup of bored? on the Pi. Run it from the folder you want the app in:
#   bash setup.sh ghcr.io/<your-github-name>/bored:latest
# Safe to run again; it keeps your data and settings.
set -euo pipefail
IMAGE="${1:-}"
DIR="$(pwd)"

if [ -z "$IMAGE" ] && [ -f .env ]; then IMAGE=$(grep '^BORED_IMAGE=' .env | cut -d= -f2-); fi
if [ -z "$IMAGE" ]; then echo "Usage: bash setup.sh ghcr.io/<your-github-name>/bored:latest"; exit 1; fi
if ! docker info > /dev/null 2>&1; then
  echo "Docker isn't reachable for user $(whoami). Add yourself to the docker group:"
  echo "  sudo usermod -aG docker $(whoami)   (then log out and back in)"
  exit 1
fi

echo "Getting the Pi files out of $IMAGE"
docker pull -q "$IMAGE" > /dev/null
for f in docker-compose.yml update.sh; do
  docker run --rm --entrypoint cat "$IMAGE" "/app/pi/$f" > "$f"
done
chmod +x update.sh

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

mkdir -p data
# the app runs as uid 1000 inside the container
[ "$(stat -c %u data)" = "1000" ] || sudo chown 1000:1000 data

docker compose up -d

# check for updates every 5 minutes
CRON="*/5 * * * * $DIR/update.sh >> $DIR/update.log 2>&1"
( crontab -l 2>/dev/null | grep -v "$DIR/update.sh" || true; echo "$CRON" ) | crontab -

echo
echo "bored? is running on http://$(hostname -I | awk '{print $1}'):$(grep '^BORED_PORT=' .env | cut -d= -f2)"
echo "It checks for updates every 5 minutes. Log: $DIR/update.log"
echo "Open it now and create your account first: the first account becomes the admin."
