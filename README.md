# bored?

Spin a wheel of the hobbies, games and projects you already own. Do the thing, log the time, and every 20 hours unlocks one new purchase.

- **Wheel**: things you haven't touched in a while get bigger slices (up to 3× after four weeks, or if never touched).
- **Time**: live timer that keeps running across devices, or log hours afterwards.
- **Unlocks**: every *X* hours (default 20) earns one purchase. Unlocks stack; buying uses one.
- **Wishlist**: park things you want instead of buying them now.
- **Points & friends**: sessions earn points with streak and other bonuses; add friends and compare on a weekly, monthly and all-time leaderboard.
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
| `BORED_BIND` | detected | `127.0.0.1` = only the Pi itself (your tunnel) can connect; `0.0.0.0` = reachable on your network |

Run `docker compose up -d` after editing `.env`.

---

## Invite key

As admin, tap the gear icon (top right):

- **Copy key** or **Copy sign-up link** (the link opens sign-up with the key filled in).
- The key works any number of times.
- **Make a new key** stops the old key right away. Existing accounts keep working.
- The admin account can't be deleted, because it holds the invite key.

## Security

What's in place, and tested on every build by `test/security.js` (an attack test suite: a failing test means no new version ships):

**Passwords**
- Hashed with scrypt at OWASP-recommended cost (N=2^15, r=8, p=3), a unique salt per password, never stored or logged in plain text. Older hashes are upgraded automatically on the next login.
- New passwords need 10+ characters, can't be common, repetitive or contain the username, and are checked against known data breaches via Have I Been Pwned. Only the first 5 characters of a hash ever leave the Pi (k-anonymity).
- 5 wrong passwords slow that account down (30 seconds, doubling up to 15 minutes), whoever is trying and from wherever. Unknown usernames behave exactly the same, so accounts can't be probed. Locks are stored in the database, so floods and restarts can't wipe them, and only one password check per account runs at a time, so parallel guessing doesn't help.
- Devices you've signed in on before get a "known device" cookie. Strangers guessing your password lock only *new* devices, not your own phone and laptop.
- Each network gets 20 login attempts per 15 minutes. IPv6 counts per /64, because one home connection has billions of addresses.
- Hashing runs at most 3 at a time, so a login flood can't exhaust the Pi. Known devices skip the queue.

**Accounts**
- Sign-up needs the invite key, checked before anything else.
- Admin (Settings → People): see who has an account, give someone a one-time reset code (valid 24 hours), or remove an account.
- Settings → Signed-in devices: see where you're logged in and sign out other devices. Logins end after 30 days unused (90 days at most). Changing or resetting a password signs out every other device.

**Web**
- Session cookies are random 256-bit tokens, stored only as hashes. They're `HttpOnly`, `SameSite=Strict`, and `Secure` with the `__Host-` prefix over HTTPS.
- Cross-site requests are blocked (same-origin JSON only, `Sec-Fetch-Site` check).
- Strict Content Security Policy (no inline scripts, no third-party anything), HSTS, no framing, no referrers, locked-down browser permissions.
- Proxy headers (`CF-Connecting-IP`, `X-Forwarded-Proto`) are only trusted from the tunnel's own address, so nobody on your network can fake them.
- Names are cleaned of hidden control and text-direction characters; everything shown is HTML-escaped.
- Size limits on requests, timeouts on slow connections, a per-IP request cap, and malformed requests can't crash the server.

**On the Pi**
- The container runs as a normal user with a read-only filesystem, no Linux capabilities, no privilege escalation, and capped memory and processes.
- If your Cloudflare tunnel runs on the Pi, the app only listens on localhost.
- The database and backups are readable only by the app's user.
- The image is rebuilt weekly with the latest Alpine and Node security patches. Build tools are pinned to exact commits, and Dependabot proposes updates.
- The updater takes a new `docker-compose.yml` only if it keeps every lockdown and mounts nothing but `./data`. It never replaces itself, because it runs outside the container. When `update.log` says a newer `update.sh` is available, run `bash setup.sh`.

**Worth doing yourself**
- Turn on two-factor authentication on your GitHub account. Whoever controls the repo controls what runs on the Pi.
- Optional: in Cloudflare (Security → WAF → Rate limiting rules), add a rule for `/api/login` (e.g. 20 requests per minute per IP). It stops floods before they reach the Pi.

**Security log:** `docker compose logs bored | grep security` shows failed logins, lockouts, password changes and admin actions.

## Why 20 hours?

- **Skill:** Josh Kaufman's "first 20 hours" idea is that about 20 hours of focused practice gets you past the frustrating beginner stage, where the thing you bought starts being fun.
- **Money:** at a typical 3 to 7 free hours a week, 20 hours means a 3 to 6 week wait between purchases. That's longer than the popular 30-day rule against impulse buys, and most cravings fade before then.

## Developing locally

```bash
npm start                        # Node 22.5+; data goes to ./data
# or with Docker:
docker compose up --build
```
