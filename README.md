# bored?

Spin a wheel of the hobbies, games and projects you already own. Do the thing, log the time, and every 20 hours unlocks one new purchase.

- **Wheel**: things you haven't touched in a while get bigger slices (up to 3× after four weeks, or if never touched).
- **Time**: live timer that keeps running across devices, or log hours afterwards.
- **Unlocks**: every *X* hours (default 20) earns one purchase. Unlocks stack; buying uses one.
- **Wishlist**: park things you want instead of buying them now.
- **Accounts**: invite only. The first account becomes the admin and gets the invite key.

No npm dependencies: Node's built-in HTTP server, crypto (scrypt passwords) and SQLite.

---

## How updates work

```
change pushed to GitHub ──► GitHub tests it and builds a Pi image ──► Pi checks every 5 min, backs up, updates
```

- **GitHub Actions** (`.github/workflows/publish.yml`) runs a smoke test on every push to `main`. Only if that passes does it build images for arm64, armv7 and x86 and publish them to GitHub Container Registry as `ghcr.io/<you>/bored:latest`. A broken change never reaches the Pi.
- **On the Pi**, `update.sh` runs from cron every 5 minutes. If there's a new image, it backs up the database to `data/backups/` (keeping the last 10) and restarts the app. If not, it does nothing.
- Open tabs reload themselves when they notice a new version. The version is shown at the bottom of Settings.

Nobody needs access to the Pi: changes only ever go to GitHub.

---

## One-time setup

### 1. Put the code on GitHub

Create an empty repository called `bored` on github.com (private is fine), then push this folder to it. If you connect GitHub to Claude, Claude can do the push for you.

After the first push, open the repo's **Actions** tab and wait for "Test and publish" to go green (a few minutes).

### 2. Let the Pi download the image

The image is private by default, like the repo. Pick one:

- **Simplest:** on GitHub go to your profile → **Packages** → `bored` → **Package settings** → **Change visibility** → Public. The code has no secrets in it.
- **Keep it private:** create a classic token at github.com/settings/tokens with only the `read:packages` scope, then on the Pi run once:
  ```bash
  echo YOUR_TOKEN | docker login ghcr.io -u YOUR_GITHUB_NAME --password-stdin
  ```

### 3. Install on the Pi

You need Docker with the compose plugin, and your user in the `docker` group. Replace `YOUR_GITHUB_NAME` (lowercase):

```bash
mkdir -p ~/bored && cd ~/bored
IMAGE=ghcr.io/YOUR_GITHUB_NAME/bored:latest
docker run --rm --entrypoint cat $IMAGE /app/pi/setup.sh > setup.sh && bash setup.sh $IMAGE
```

This starts the app on port 3000 and adds the 5-minute update check to your crontab. **Open it straight away and create your account: the first account becomes the admin.**

### 4. Connect bored.kaikawaka.com

In your Cloudflare tunnel, add a public hostname: `bored.kaikawaka.com` → `http://localhost:3000`.

Login cookies switch to `Secure` automatically, because Cloudflare sends `X-Forwarded-Proto: https`.

**iPhone:** open the site in Safari → Share → **Add to Home Screen**.

---

## Day to day on the Pi (all optional)

```bash
cd ~/bored
cat update.log              # what got updated and when
./update.sh                 # check for an update right now
docker compose logs -f      # app logs
ls data/backups/            # automatic backups made before each update
```

**Roll back** to an earlier version: every build is also tagged with its short commit id (see the repo's Packages page). Put that tag in `.env`, for example `BORED_IMAGE=ghcr.io/you/bored:a1b2c3d`, and run `docker compose up -d`. Auto-update stays pinned to that version until you set it back to `:latest`.

**Restore a backup:** `docker compose stop`, copy a file from `data/backups/` over `data/bored.db` (and delete `data/bored.db-wal` and `data/bored.db-shm`), then `docker compose start`.

**Settings** are in `~/bored/.env`:

| Variable | Default | What it does |
|---|---|---|
| `BORED_IMAGE` | | Which image to run and auto-update |
| `BORED_PORT` | `3000` | Port on the Pi |
| `TZ` | `Europe/Brussels` | Timezone |
| `DEFAULT_HOURS_PER_UNLOCK` | `20` | Hours per purchase for new accounts (each user can change their own) |

Run `docker compose up -d` after editing `.env`.

---

## Invite key

As admin, tap the gear icon (top right):

- **Copy key** or **Copy sign-up link** (the link opens sign-up with the key filled in).
- The key works any number of times.
- **Make a new key** stops the old key right away. Existing accounts keep working.
- The admin account can't be deleted, because it holds the invite key.

## Why 20 hours?

- **Skill:** Josh Kaufman's "first 20 hours" idea is that about 20 hours of focused practice gets you past the frustrating beginner stage, where the thing you bought starts being fun.
- **Money:** at a typical 3 to 7 free hours a week, 20 hours means a 3 to 6 week wait between purchases. That's longer than the popular 30-day rule against impulse buys, and most cravings fade before then.

## Developing locally

```bash
npm start                        # Node 22.5+; data goes to ./data
# or with Docker:
docker compose up --build
```
