'use strict';
// bored? — spin the wheel, do your stuff, earn your next purchase.
// Zero dependencies: Node's built-in http, crypto and sqlite.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { scoring, dayKey } = require('./score');
const { achievements } = require('./achievements');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_HOURS = Number(process.env.DEFAULT_HOURS_PER_UNLOCK || 20);
const COOKIE_SECURE = process.env.COOKIE_SECURE;             // 'true' | 'false' | unset (auto)
const TRUST_PROXY = process.env.TRUST_PROXY || 'auto';       // 'auto' | 'always' | 'never'
const PWNED_CHECK = process.env.PWNED_CHECK !== 'false';     // breached-password check
const MAX_SIGNUPS_PER_DAY = Number(process.env.MAX_SIGNUPS_PER_DAY || 100); // anti-spam cap for the whole site
const PRIVACY_CONTACT = String(process.env.PRIVACY_CONTACT || '').slice(0, 200); // shown in the privacy notice
const APP_VERSION = process.env.APP_VERSION || 'dev';                 // git commit of this build
const APP_RELEASE = require('./package.json').version;              // release number, e.g. 1.1.0
const BUILD_DATE = process.env.BUILD_DATE || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const KINDS = ['hobby', 'game', 'project', 'learning', 'other'];

const DAY = 86400_000;
const SESSION_MAX_AGE = 90 * DAY;      // absolute lifetime of a login
const SESSION_IDLE = 30 * DAY;         // signed out after 30 days without use
const RESET_CODE_TTL = DAY;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 256;

// Files we create (database, backups) are readable by the app user only.
process.umask(0o077);
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'bored.db');
const db = new DatabaseSync(DB_FILE);
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.chmodSync(f, 0o600); } catch { /* not there yet */ } }

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  hours_per_unlock REAL NOT NULL DEFAULT ${DEFAULT_HOURS},
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'hobby',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wishes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price REAL,
  created_at INTEGER NOT NULL,
  bought_at INTEGER
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cost_minutes INTEGER NOT NULL,
  wish_id INTEGER REFERENCES wishes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_failures (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  until INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS known_devices (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_steps (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done_at INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_item ON project_steps(item_id, position);
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS friendships (
  a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS idx_friend_b ON friendships(b);
CREATE INDEX IF NOT EXISTS idx_requests_to ON friend_requests(to_id);
CREATE TABLE IF NOT EXISTS password_resets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON time_logs(user_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
`);

// ---------- migrations ----------
const hasColumn = (table, col) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
if (!hasColumn('users', 'is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
  db.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
}
for (const [col, def] of [['sid', "TEXT NOT NULL DEFAULT ''"], ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_seen', 'INTEGER NOT NULL DEFAULT 0'], ['device', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!hasColumn('auth_sessions', col)) db.exec(`ALTER TABLE auth_sessions ADD COLUMN ${col} ${def}`);
}
db.exec(`UPDATE auth_sessions SET sid = lower(hex(randomblob(8))) WHERE sid = '';
         UPDATE auth_sessions SET last_seen = strftime('%s','now') * 1000 WHERE last_seen = 0;`);

const q = (sql) => db.prepare(sql);
const score = scoring(db);
db.exec(`CREATE TABLE IF NOT EXISTS high_fives (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES score_events(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, event_id)
); CREATE INDEX IF NOT EXISTS idx_hf_event ON high_fives(event_id);`);
for (const col of ['quick', 'chill']) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = ?").get(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
}
// 1.2: pause, snooze, notes, monthly goal, nudges
for (const [t, col, def] of [['timers', 'paused_at', 'INTEGER NOT NULL DEFAULT 0'], ['timers', 'paused_ms', 'INTEGER NOT NULL DEFAULT 0'],
  ['items', 'snoozed_until', 'INTEGER NOT NULL DEFAULT 0'], ['time_logs', 'note', "TEXT NOT NULL DEFAULT ''"],
  ['time_logs', 'edited', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'monthly_goal', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!hasColumn(t, col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`);
}
if (!hasColumn('users', 'prefs')) db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'");
db.exec(`CREATE TABLE IF NOT EXISTS nudges (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id, day)
); CREATE INDEX IF NOT EXISTS idx_nudges_to ON nudges(to_id, seen);`);
const ach = achievements(db, score);
const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ---------- site stats ----------
// Totals per day for the admin's stats screen: page views, requests, sign-ins and so on.
// Only counts are kept, never who or from where. "Active people" needs to know who was already
// counted today, so those ids are kept for today only and dropped once the day is over.
db.exec(`CREATE TABLE IF NOT EXISTS site_daily (
  day TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key)
);
CREATE TABLE IF NOT EXISTS site_active_today (day TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (day, user_id));`);
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (ts = Date.now()) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const traffic = new Map();   // "day|key" → count, written to the database every minute
const countVisit = (key, by = 1) => { const k = `${localDay()}|${key}`; traffic.set(k, (traffic.get(k) || 0) + by); };
function flushTraffic() {
  if (!traffic.size) return;
  const up = q('INSERT INTO site_daily (day, key, value) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET value = value + excluded.value');
  const rows = [...traffic]; traffic.clear();
  try { tx(() => { for (const [k, n] of rows) { const [day, key] = k.split('|'); up.run(day, key, n); } }); }
  catch (e) { console.error('traffic', e); }
}
const activeSeen = new Set();
function markActive(userId) {
  const day = localDay(), k = `${day}|${userId}`;
  if (activeSeen.has(k)) return;
  if (activeSeen.size > 50_000) activeSeen.clear();
  activeSeen.add(k);
  if (q('INSERT OR IGNORE INTO site_active_today (day, user_id) VALUES (?, ?)').run(day, userId).changes) countVisit('active');
}
setInterval(flushTraffic, 60_000).unref();

// ---------- errors & logging ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
// Security log, throttled per event type so a flood of junk can't fill the disk.
const logBudget = new Map();
const secLog = (event, details = {}) => {
  const now = Date.now();
  let b = logBudget.get(event);
  if (!b || b.reset < now) {
    if (b && b.dropped) console.log(`${new Date().toISOString()} [security] ${event} (${b.dropped} more not shown)`);
    b = { n: 0, dropped: 0, reset: now + 60_000 }; logBudget.set(event, b);
  }
  if (++b.n > 30) { b.dropped++; return; }
  const d = Object.entries(details).map(([k, v]) => `${k}=${JSON.stringify(String(v)).slice(0, 80)}`).join(' ');
  console.log(`${new Date().toISOString()} [security] ${event} ${d}`);
};

// ---------- client IP (only trust proxy headers from the proxy) ----------
// Cloudflare's tunnel connects from the Pi itself (loopback or the Docker bridge, 172.16.0.0/12).
// Anyone else on the network connects with their own address and can't fake the header.
function isTrustedProxy(addr) {
  if (TRUST_PROXY === 'always') return true;
  if (TRUST_PROXY === 'never') return false;
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (a === '::1' || a.startsWith('127.')) return true;
  const m = a.match(/^172\.(\d+)\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}
function clientIp(req) {
  const sock = req.socket.remoteAddress || 'unknown';
  if (!isTrustedProxy(sock)) return sock;
  const cf = req.headers['cf-connecting-ip'];
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(cf || xff || sock).slice(0, 64);
}
// For limits, an IPv6 client is its /64 network: one home connection gets billions of
// addresses, so counting them one by one would let a single attacker rotate forever.
function ipKey(ip) {
  const a = String(ip).trim().split('%')[0].replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  if (!a.includes(':')) return a;
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
function isSecure(req) {
  if (COOKIE_SECURE === 'true') return true;
  if (COOKIE_SECURE === 'false') return false;
  return isTrustedProxy(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
}

// ---------- rate limiting (per network) ----------
const buckets = new Map();
const MAX_BUCKETS = 50_000;
function hit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    if (buckets.size >= MAX_BUCKETS) {
      // drop the oldest entries only; never wipe everything
      let n = 0; for (const k of buckets.keys()) { buckets.delete(k); if (++n >= 5000) break; }
    }
    buckets.delete(key);
    b = { n: 0, reset: now + windowMs }; buckets.set(key, b);
  }
  b.n++;
  return b.n <= max ? 0 : Math.ceil((b.reset - now) / 1000);
}
function limit(req, name, max, windowMs) {
  const wait = hit(`${name}:${ipKey(clientIp(req))}`, max, windowMs);
  if (wait) throw new HttpError(429, `Too many attempts. Try again in ${waitText(wait)}.`);
}
const waitText = (s) => (s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`);

// ---------- account locks ----------
// After 5 wrong passwords an account slows down: 30 s, doubling up to 15 min.
// Stored in the database, so floods and restarts can't wipe them. Lock keys:
//   user:<name>  attempts from unknown devices (also for usernames that don't exist,
//                so locks don't reveal which accounts are real)
//   dev:<hash>   attempts from a device this account signed in on before, so an attacker
//                guessing wrong can't lock the real owner out of their own devices
//   uid:<id>     password re-checks inside the app (change password, delete account)
const failKey = (name) => String(name || '').toLowerCase().slice(0, 64);
function checkLocked(key) {
  const f = q('SELECT until FROM login_failures WHERE key = ?').get(key);
  if (f && f.until > Date.now()) {
    throw new HttpError(429, `Too many wrong passwords for this account. Try again in ${waitText(Math.ceil((f.until - Date.now()) / 1000))}.`);
  }
}
function recordFailure(key, req) {
  const now = Date.now();
  const f = q('SELECT n FROM login_failures WHERE key = ?').get(key);
  const n = (f ? f.n : 0) + 1;
  const until = n >= 5 ? now + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(n - 5, 10)) : 0;
  q(`INSERT INTO login_failures (key, n, until, updated) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET n = excluded.n, until = excluded.until, updated = excluded.updated`).run(key, n, until, now);
  if (until) secLog('account-throttled', { key, failures: n, ip: clientIp(req) });
}
const clearFailures = (key) => q('DELETE FROM login_failures WHERE key = ?').run(key);

// One password check per account at a time: parallel guesses can't slip past the lock.
const inFlight = new Set();
async function oneAtATime(key, fn) {
  if (inFlight.has(key)) throw new HttpError(429, 'Another sign-in for this account is being checked. Try again in a moment.');
  inFlight.add(key);
  try { return await fn(); } finally { inFlight.delete(key); }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

// ---------- passwords ----------
// scrypt with OWASP-recommended cost (N=2^15, r=8, p=3: 32 MiB). Runs off the main thread.
// Older hashes (N=2^14, p=1) still verify and are upgraded on the next successful login.
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 96 * 1024 * 1024 };
const LEGACY = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

// At most 3 hashes at once, so a flood of logins can't exhaust the Pi's memory or CPU.
let hashing = 0; const waiting = [];
// Sign-ins from a known device skip the queue, so a login flood can't keep owners out.
async function withHashSlot(fn, priority = false) {
  if (hashing >= 3) {
    if (waiting.length >= (priority ? 60 : 30)) throw new HttpError(503, 'The server is busy. Try again in a moment.');
    await new Promise((r) => (priority ? waiting.unshift(r) : waiting.push(r)));
  }
  hashing++;
  try { return await fn(); } finally { hashing--; const next = waiting.shift(); if (next) next(); }
}
const normPw = (pw) => String(pw).normalize('NFKC');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await withHashSlot(() => scrypt(normPw(password), salt, KEYLEN, SCRYPT));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
// A fixed hash to compare against when the username doesn't exist, so timing is identical.
let DUMMY_HASH = null;
const dummyReady = hashPassword(crypto.randomBytes(16).toString('hex')).then((h) => { DUMMY_HASH = h; });
async function verifyPassword(password, row, priority = false) {
  if (!row) {
    await dummyReady;
    await verifyPassword(password, { pass_hash: DUMMY_HASH });
    return { ok: false };
  }
  let expected, key, needsRehash = false;
  if (row.pass_hash.startsWith('scrypt$')) {
    const [, N, r, p, salt, hash] = row.pass_hash.split('$');
    expected = Buffer.from(hash, 'base64');
    key = await withHashSlot(() => scrypt(normPw(password), Buffer.from(salt, 'base64'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }), priority);
    needsRehash = Number(N) !== SCRYPT.N || Number(r) !== SCRYPT.r || Number(p) !== SCRYPT.p;
  } else {
    // legacy v1: hex hash, hex salt string, password not normalised
    expected = Buffer.from(row.pass_hash, 'hex');
    key = await withHashSlot(() => scrypt(String(password), row.salt, KEYLEN, LEGACY), priority);
    needsRehash = true;
  }
  const ok = key.length === expected.length && crypto.timingSafeEqual(key, expected);
  return { ok, needsRehash: ok && needsRehash };
}

const COMMON = new Set(`123456789012 1234567890 0123456789 password123 password1234 passwordpassword qwertyuiop
qwerty123456 1q2w3e4r5t 1qaz2wsx3edc iloveyou123 abcdefghij abc1234567 letmein123 welcome123 administrator
football123 baseball123 superman123 trustno1234 sunshine123 princess123 dragon1234 monkey12345 master1234
changeme123 starwars123 whatever123 0987654321 1111111111 0000000000 aaaaaaaaaa zaq12wsxcde qazwsxedcrfv
passw0rd123 p@ssw0rd123 p@ssword123 wachtwoord wachtwoord123 motdepasse azertyuiop azerty1234 boredbored
bored12345 boredpassword`.split(/\s+/));

async function pwnedCount(password) {
  if (!PWNED_CHECK) return 0;
  try {
    // k-anonymity: only the first 5 characters of the SHA-1 hash leave the server
    const sha = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'bored-app' }, signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return 0;
    const line = (await res.text()).split('\n').find((l) => l.startsWith(sha.slice(5)));
    return line ? Number(line.split(':')[1]) || 0 : 0;
  } catch (e) {
    secLog('pwned-check-unavailable', { reason: e.name });
    return 0; // fail open: an outage of that service shouldn't block sign-ups
  }
}
async function checkNewPassword(password, username) {
  if (typeof password !== 'string') bad('Password is missing');
  const len = [...password].length;
  if (len < PASSWORD_MIN) bad(`Password needs at least ${PASSWORD_MIN} characters. A few random words works well.`);
  if (len > PASSWORD_MAX) bad(`Password can be at most ${PASSWORD_MAX} characters`);
  const lower = password.toLowerCase();
  if (new Set(lower).size < 4) bad('That password is too repetitive');
  if (COMMON.has(lower)) bad('That password is too common. Pick something less guessable.');
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) bad('Your password can’t contain your username');
  const seen = await pwnedCount(password);
  if (seen > 0) bad('That password has shown up in a data breach, so attackers try it first. Pick a different one.');
}

// ---------- reset codes ----------
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomCode(groups) {
  // rejection sampling so every character is equally likely
  let out = '';
  while (out.length < groups * 4) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) out += KEY_CHARS[b % KEY_CHARS.length];
  }
  return out.match(/.{4}/g).join('-');
}
const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 64);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y);
}
const userCount = () => q('SELECT COUNT(*) AS n FROM users').get().n;

// ---------- input cleaning ----------
// Strips control characters and invisible text-direction tricks, normalises Unicode.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]/g;
function str(v, field, min, max) {
  if (typeof v !== 'string') bad(`${field} is missing`);
  const s = v.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if ([...s].length < min) bad(`${field} needs at least ${min} character${min === 1 ? '' : 's'}`);
  if ([...s].length > max) bad(`${field} can be at most ${max} characters`);
  return s;
}
function int(v, field, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n) bad(`${field} must be a whole number`);
  if (n < min || n > max) bad(`${field} must be between ${min} and ${max}`);
  return n;
}
const id = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : -1; };

// ---------- sessions ----------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').slice(0, 8192).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}
// Over HTTPS the cookie gets the __Host- prefix: browsers then refuse to let any other
// (sub)domain set or overwrite it.
// SameSite=Strict: browsers never send these cookies on requests started by another site.
const cookieName = (req, base) => (isSecure(req) ? `__Host-${base}` : base);
const cookieFrom = (req, base) => { const c = parseCookies(req); return c[`__Host-${base}`] || c[base] || ''; };
const tokenFrom = (req) => cookieFrom(req, 'bored_sid');
function addCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), cookie]);
}
function setCookie(req, res, base, value, maxAgeSec) {
  const secure = isSecure(req);
  addCookie(res, `${cookieName(req, base)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  if (secure) addCookie(res, `${base}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`); // clear any pre-HTTPS cookie
}
const setSessionCookie = (req, res, token, maxAgeSec) => setCookie(req, res, 'bored_sid', token, maxAgeSec);

// "Known device" cookie: proves this browser signed in to an account before. It never logs
// anyone in by itself; it only keeps the owner's devices out of locks caused by strangers.
function knownDevice(req, userId) {
  const token = cookieFrom(req, 'bored_dev');
  if (!userId || !token || token.length > 100) return null;
  const hash = sha256(token);
  return q('SELECT 1 FROM known_devices WHERE token_hash = ? AND user_id = ?').get(hash, userId) ? hash : null;
}
function rememberDevice(req, res, userId) {
  if (knownDevice(req, userId)) return;
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO known_devices (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now());
  q(`DELETE FROM known_devices WHERE user_id = ? AND token_hash NOT IN
     (SELECT token_hash FROM known_devices WHERE user_id = ? ORDER BY created_at DESC LIMIT 20)`).run(userId, userId);
  setCookie(req, res, 'bored_dev', token, 400 * 86400);
}
function deviceLabel(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${br} on ${os}` : os;
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q('INSERT INTO auth_sessions (token_hash, user_id, expires_at, sid, created_at, last_seen, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now + SESSION_MAX_AGE, crypto.randomBytes(8).toString('hex'), now, now, deviceLabel(req.headers['user-agent']));
  setSessionCookie(req, res, token, SESSION_MAX_AGE / 1000);
}
function currentSession(req) {
  const token = tokenFrom(req);
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = q(`SELECT u.id, u.username, u.hours_per_unlock, u.is_admin, u.monthly_goal, s.expires_at, s.last_seen, s.sid
                 FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || now - row.last_seen > SESSION_IDLE) {
    q('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - row.last_seen > 10 * 60_000) q('UPDATE auth_sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
  return row;
}

// ---------- body & response ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // keep draining, but don't store anything
      size += c.length;
      if (size > 32 * 1024) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'Request too large')); } else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ---------- app helpers ----------
function ownItem(user, itemId) {
  const item = q('SELECT * FROM items WHERE id = ? AND user_id = ?').get(id(itemId), user.id);
  if (!item) throw new HttpError(404, 'That item no longer exists');
  return item;
}
// Saves a session with its points; returns what was earned, for the app to celebrate.
function addLog(user, item, minutes, endedAt, source, fromSpin = false, note = '') {
  if (q('SELECT COUNT(*) AS n FROM time_logs WHERE user_id = ?').get(user.id).n >= 20_000) bad('You’ve reached the maximum number of sessions');
  const now = Date.now();
  const e = score.scoreSession({ userId: user.id, item, minutes, endedAt, source, fromSpin, now });
  const r = q(`INSERT INTO time_logs (user_id, item_id, minutes, ended_at, source, points, scored_minutes, multiplier, bonuses, created_at, from_spin, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, item.id, minutes, endedAt, source, e.points, e.scoredMinutes, e.multiplier, JSON.stringify(e.bonuses), now, fromSpin ? 1 : 0, note);
  const milestone = score.milestone(user.id, endedAt, now);
  return { ...e, logId: Number(r.lastInsertRowid), minutes, base: e.scoredMinutes * 10, milestone, total: e.points + (milestone ? milestone.points : 0) };
}
function fmtH(min) { return `${Math.round((min / 60) * 10) / 10} h`; }

function buildState(user) {
  awardChallenge(user);
  const items = q(`SELECT i.id, i.name, i.kind, i.archived, i.created_at, i.quick, i.chill, i.snoozed_until,
                     COALESCE(SUM(l.minutes), 0) AS minutes, MAX(l.ended_at) AS last_at, COUNT(l.id) AS sessions,
                     (SELECT COUNT(*) FROM project_steps s WHERE s.item_id = i.id) AS steps_total,
                     (SELECT COUNT(*) FROM project_steps s WHERE s.item_id = i.id AND s.done_at IS NOT NULL) AS steps_done,
                     (SELECT text FROM project_steps s WHERE s.item_id = i.id AND s.done_at IS NULL ORDER BY position LIMIT 1) AS next_step
                   FROM items i LEFT JOIN time_logs l ON l.item_id = i.id
                   WHERE i.user_id = ? GROUP BY i.id ORDER BY i.created_at`).all(user.id);
  const earned = q('SELECT COALESCE(SUM(minutes), 0) AS m FROM time_logs WHERE user_id = ?').get(user.id).m;
  const spent = q('SELECT COALESCE(SUM(cost_minutes), 0) AS m FROM purchases WHERE user_id = ?').get(user.id).m;
  const cost = Math.round(user.hours_per_unlock * 60);
  const balance = earned - spent;
  return {
    now: Date.now(),
    user: {
      username: user.username,
      hoursPerUnlock: user.hours_per_unlock,
      isAdmin: !!user.is_admin,
      monthlyGoal: user.monthly_goal,
      prefs: prefsOf(q('SELECT prefs FROM users WHERE id = ?').get(user.id).prefs),
      ...(user.is_admin ? { userCount: userCount() } : {}),
    },
    items,
    score: score.summary(user.id),
    friendRequests: q('SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ?').get(user.id).n,
    highFives: q(`SELECT u.username AS "from", e.kind, e.label, h.created_at AS at FROM high_fives h
                  JOIN score_events e ON e.id = h.event_id JOIN users u ON u.id = h.from_id
                  WHERE e.user_id = ? AND h.seen = 0 ORDER BY h.created_at DESC LIMIT 10`).all(user.id)
      .map((h) => ({ from: h.from, text: momentText(h.kind, true), at: h.at })),
    nudges: q(`SELECT u.username AS "from", n.created_at AS at FROM nudges n JOIN users u ON u.id = n.from_id
               WHERE n.to_id = ? AND n.seen = 0 ORDER BY n.created_at DESC LIMIT 10`).all(user.id),
    timer: q(`SELECT t.item_id, t.started_at, t.from_spin, t.paused_at, t.paused_ms, i.name AS item_name FROM timers t
              JOIN items i ON i.id = t.item_id WHERE t.user_id = ?`).get(user.id) || null,
    bank: {
      earnedMinutes: earned,
      spentMinutes: spent,
      costMinutes: cost,
      unlocks: balance > 0 ? Math.floor(balance / cost) : 0,
      progressMinutes: balance > 0 ? balance % cost : 0,
      purchasesCount: q('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ?').get(user.id).n,
    },
    logs: q(`SELECT l.id, l.item_id, l.minutes, l.ended_at, l.source, l.points, l.note, l.edited, i.name AS item_name
             FROM time_logs l JOIN items i ON i.id = l.item_id
             WHERE l.user_id = ? AND l.ended_at > ? ORDER BY l.ended_at DESC LIMIT 2000`).all(user.id, Date.now() - 70 * DAY),
    wishes: q('SELECT id, name, price, created_at, bought_at FROM wishes WHERE user_id = ? ORDER BY bought_at IS NOT NULL, created_at DESC').all(user.id),
    purchases: q('SELECT id, name, cost_minutes, created_at FROM purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id),
  };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, auth, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([0-9a-f]{1,32})'; }) + '$');
  routes.push({ method, re, keys, auth, handler });
};
const requireAdmin = (user) => { if (!user.is_admin) throw new HttpError(403, 'Only the admin can do that'); };

// What's new: CHANGELOG.md (and the Dutch CHANGELOG.nl.md), parsed once at startup.
// Unreleased notes only show in dev builds.
function parseChangelog(file) {
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, file), 'utf8'); } catch { return null; }
  const versions = []; let cur = null, group = null;
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^## (.+?)\s*$/))) {
      const [version, date] = m[1].split(/\s+[—–-]\s+/);
      cur = { version: version.trim(), date: date ? date.trim() : null, intro: '', groups: [] }; group = null;
      versions.push(cur); continue;
    }
    if (!cur) continue;
    if ((m = line.match(/^### (.+?)\s*$/))) { group = { title: m[1], items: [] }; cur.groups.push(group); continue; }
    if ((m = line.match(/^- (.+)$/))) {
      if (!group) { group = { title: '', items: [] }; cur.groups.push(group); }
      group.items.push(m[1].trim()); continue;
    }
    if (line.trim() && !group) cur.intro = (cur.intro ? `${cur.intro} ` : '') + line.trim();
  }
  return versions.filter((v) => v.version !== 'Unreleased' || APP_VERSION === 'dev')
    .map((v) => (v.version === 'Unreleased' ? { ...v, version: 'Next version', upcoming: true } : v));
}
const CHANGELOGS = { en: parseChangelog('CHANGELOG.md') || [] };
CHANGELOGS.nl = parseChangelog('CHANGELOG.nl.md') || CHANGELOGS.en;
route('GET', '/api/changelog', false, (req) => {
  const lang = new URL(req.url, 'http://local').searchParams.get('lang');
  return { release: APP_RELEASE, commit: APP_VERSION, versions: CHANGELOGS[lang === 'nl' ? 'nl' : 'en'] };
});

route('GET', '/api/config', false, () => ({ firstUser: userCount() === 0, privacyContact: PRIVACY_CONTACT, defaultHours: DEFAULT_HOURS, release: APP_RELEASE, version: APP_VERSION, buildDate: BUILD_DATE, passwordMin: PASSWORD_MIN }));

// --- auth
route('POST', '/api/register', false, async (req, res, body) => {
  limit(req, 'register', 10, 3600_000);
  const username = str(body.username, 'Username', 3, 32);
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) bad('Username can only use letters, numbers, dots, dashes and underscores');
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
  // anti-spam: a cap on new accounts per day for the whole site
  if (q('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').get(Date.now() - DAY).n >= MAX_SIGNUPS_PER_DAY) {
    secLog('signup-cap-reached', { ip: clientIp(req) });
    throw new HttpError(503, 'Sign-ups are paused for today. Try again tomorrow.');
  }
  await checkNewPassword(body.password, username);
  const passHash = await hashPassword(body.password);
  // Inside a transaction, so two sign-ups racing can't both become the admin.
  const userId = tx(() => {
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    const first = userCount() === 0;
    const r = q('INSERT INTO users (username, pass_hash, salt, hours_per_unlock, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, passHash, '', DEFAULT_HOURS, first ? 1 : 0, Date.now());
    return Number(r.lastInsertRowid);
  });
  secLog('account-created', { user: username, ip: clientIp(req) });
  startSession(req, res, userId);
  rememberDevice(req, res, userId);
  return { ok: true };
});

route('POST', '/api/login', false, async (req, res, body) => {
  limit(req, 'login', 20, 15 * 60_000);
  const username = String(body.username || '').trim().slice(0, 64);
  const password = String(body.password || '').slice(0, PASSWORD_MAX * 4);
  const u = q('SELECT id, username, pass_hash, salt FROM users WHERE username = ?').get(username);
  const dev = knownDevice(req, u && u.id);
  const key = dev ? `dev:${dev}` : `user:${failKey(username)}`;
  return oneAtATime(key, async () => {
    checkLocked(key);
    const { ok, needsRehash } = await verifyPassword(password, u, !!dev);
    if (!ok) {
      recordFailure(key, req);
      secLog('login-failed', { user: username, ip: clientIp(req), device: dev ? 'known' : 'new' });
      countVisit('signins_failed');
      throw new HttpError(401, 'Wrong username or password');
    }
    clearFailures(key);
    if (needsRehash) q('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(await hashPassword(password), '', u.id);
    startSession(req, res, u.id);
    countVisit('signins');
    rememberDevice(req, res, u.id);
    return { ok: true };
  });
});

route('POST', '/api/logout', false, (req, res) => {
  const token = tokenFrom(req);
  if (token) q('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
  return { ok: true };
});

route('POST', '/api/reset-password', false, async (req, res, body) => {
  limit(req, 'reset', 10, 3600_000);
  const username = String(body.username || '').trim().slice(0, 64);
  const key = `reset:${failKey(username)}`;
  return oneAtATime(key, async () => {
    checkLocked(key);
    const u = q('SELECT id, username FROM users WHERE username = ?').get(username);
    const codeHash = sha256(normKey(body.code));
    const r = u && q('SELECT * FROM password_resets WHERE user_id = ?').get(u.id);
    if (!(r && r.expires_at > Date.now() && safeEqual(codeHash, r.code_hash))) {
      recordFailure(key, req);
      secLog('reset-failed', { user: username, ip: clientIp(req) });
      throw new HttpError(401, 'That reset code isn’t valid or has expired. Ask the admin for a new one.');
    }
    await checkNewPassword(body.password, u.username);
    const passHash = await hashPassword(body.password);
    tx(() => {
      // use the code up atomically: if it's gone by now, someone else already used it
      const used = q('DELETE FROM password_resets WHERE user_id = ? AND code_hash = ? AND expires_at > ?').run(u.id, r.code_hash, Date.now());
      if (!used.changes) throw new HttpError(401, 'That reset code isn’t valid or has expired. Ask the admin for a new one.');
      q('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(passHash, '', u.id);
      q('DELETE FROM auth_sessions WHERE user_id = ?').run(u.id);
    });
    clearFailures(key);
    clearFailures(`user:${failKey(u.username)}`);
    secLog('password-reset-used', { user: u.username, ip: clientIp(req) });
    startSession(req, res, u.id);
    rememberDevice(req, res, u.id);
    return { ok: true };
  });
});

// --- account
route('GET', '/api/state', true, (req, res, body, user) => buildState(user));

async function requirePassword(req, user, password, label = 'Password is wrong') {
  limit(req, 'password', 10, 15 * 60_000);
  const key = `uid:${user.id}`;
  await oneAtATime(key, async () => {
    checkLocked(key);
    const row = q('SELECT pass_hash, salt FROM users WHERE id = ?').get(user.id);
    const { ok } = await verifyPassword(String(password || '').slice(0, PASSWORD_MAX * 4), row);
    if (!ok) { recordFailure(key, req); throw new HttpError(401, label); }
    clearFailures(key);
  });
}

route('POST', '/api/password', true, async (req, res, body, user) => {
  await requirePassword(req, user, body.current, 'Current password is wrong');
  await checkNewPassword(body.next, user.username);
  const passHash = await hashPassword(body.next);
  tx(() => {
    q('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(passHash, '', user.id);
    q('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
    q('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  });
  secLog('password-changed', { user: user.username, ip: clientIp(req) });
  startSession(req, res, user.id);
  return { ok: true };
});

route('GET', '/api/sessions', true, (req, res, body, user) => ({
  sessions: q('SELECT sid, created_at, last_seen, device FROM auth_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC')
    .all(user.id, Date.now()).map((s) => ({ id: s.sid, createdAt: s.created_at, lastSeen: s.last_seen, device: s.device || 'Unknown device', current: s.sid === user.sid })),
}));
route('POST', '/api/sessions/revoke', true, (req, res, body, user) => {
  const sid = String(body.id || '');
  if (body.others) {
    const r = q('DELETE FROM auth_sessions WHERE user_id = ? AND sid != ?').run(user.id, user.sid);
    secLog('sessions-revoked', { user: user.username, count: r.changes });
  } else {
    q('DELETE FROM auth_sessions WHERE user_id = ? AND sid = ? AND sid != ?').run(user.id, sid, user.sid);
  }
  return { ok: true };
});

route('PATCH', '/api/settings', true, (req, res, body, user) => {
  if (body.hoursPerUnlock !== undefined) {
    const h = Number(body.hoursPerUnlock);
    if (!Number.isFinite(h) || h < 1 || h > 500) bad('Hours per unlock must be between 1 and 500');
    q('UPDATE users SET hours_per_unlock = ? WHERE id = ?').run(Math.round(h * 4) / 4, user.id);
  }
  if (body.prefs !== undefined) {
    if (!body.prefs || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) bad('Settings must be a list of choices');
    const current = prefsOf(q('SELECT prefs FROM users WHERE id = ?').get(user.id).prefs);
    for (const [k, v] of Object.entries(body.prefs)) {
      if (!Object.hasOwn(PREFS, k)) bad('That setting doesn’t exist');
      if (!PREFS[k].includes(v)) bad('That choice isn’t allowed for this setting');
      current[k] = v;
    }
    q('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(current), user.id);
  }
  if (body.monthlyGoalHours !== undefined) {
    const h = Number(body.monthlyGoalHours);
    if (!Number.isFinite(h) || h < 0 || h > 300) bad('A monthly goal must be between 0 and 300 hours');
    q('UPDATE users SET monthly_goal = ? WHERE id = ?').run(Math.round(h * 60), user.id);
  }
  return buildState(currentSession(req));
});

route('POST', '/api/account/delete', true, async (req, res, body, user) => {
  if (user.is_admin) bad('The admin account can’t be deleted, because it runs the site.');
  await requirePassword(req, user, body.password);
  q('DELETE FROM users WHERE id = ?').run(user.id);
  secLog('account-deleted', { user: user.username, ip: clientIp(req) });
  setSessionCookie(req, res, '', 0);
  return { ok: true };
});

route('GET', '/api/export', true, (req, res, body, user) => {
  res.setHeader('Content-Disposition', 'attachment; filename="bored-export.json"');
  return {
    exportedAt: new Date().toISOString(),
    ...buildState(user),
    logs: q('SELECT l.id, l.item_id, l.minutes, l.ended_at, l.source, l.points, l.multiplier, l.bonuses, i.name AS item_name FROM time_logs l JOIN items i ON i.id = l.item_id WHERE l.user_id = ? ORDER BY ended_at').all(user.id),
    bonuses: q('SELECT kind, points, label, created_at FROM score_events WHERE user_id = ? ORDER BY created_at').all(user.id),
  };
});

// --- friends
// Friends see each other's points, hours and streak. Nothing else: not what you play,
// not your wishlist. You add people by their exact username.
const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);
const areFriends = (x, y) => !!q('SELECT 1 FROM friendships WHERE a = ? AND b = ?').get(...pairOf(x, y));
function friendIds(userId) {
  return q('SELECT b AS id FROM friendships WHERE a = ? UNION SELECT a AS id FROM friendships WHERE b = ?').all(userId, userId).map((r) => r.id);
}
function otherUser(user, username) {
  const name = String(username || '').trim().slice(0, 64);
  const u = name && q('SELECT id, username FROM users WHERE username = ?').get(name);
  if (!u) throw new HttpError(404, 'Nobody here has that username');
  if (u.id === user.id) bad('That’s you');
  return u;
}
// ---------- preferences ----------
// Each setting has a fixed list of allowed values; anything else is refused.
const PREFS = {
  theme: ['system', 'light', 'dark'],
  skin: ['none', 'walnut', 'doodle'],   // the secret themes
  accent: ['indigo', 'teal', 'rose', 'amber', 'green', 'plum'],
  textSize: ['normal', 'small', 'large'],
  sound: [true, false], haptics: [true, false], confetti: [true, false],
  spin: ['normal', 'quick', 'dramatic'],
  wakeLock: [false, true], tabTitle: [false, true],
  neglect: ['normal', 'off', 'gentle', 'strong'],
  autoTimer: [false, true],
  currency: ['EUR', 'USD', 'GBP'],
  timeFormat: ['decimal', 'hm'],
  private: [false, true], shareMoments: [true, false], allowNudges: [true, false],
  popups: [true, false],
  tourDone: [false, true],
};
const PREF_DEFAULTS = Object.fromEntries(Object.entries(PREFS).map(([k, v]) => [k, v[0]]));
function prefsOf(raw) {
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { /* broken: defaults */ }
  const out = { ...PREF_DEFAULTS };
  for (const k of Object.keys(PREFS)) if (PREFS[k].includes(p[k])) out[k] = p[k];
  return out;
}
const prefsById = (ids) => new Map(ids.length
  ? q(`SELECT id, prefs FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => [r.id, prefsOf(r.prefs)])
  : []);
// Friends who chose private mode don't show up for others: not on leaderboards, in feeds or in challenges.
const visibleFriendIds = (userId) => { const ids = friendIds(userId); const p = prefsById(ids); return ids.filter((id) => !p.get(id).private); };

// ---------- weekly challenge ----------
// One challenge a week for everyone, in turn. You play it against your friends; whoever is on top
// when the week ends gets 500 points. Only time that earned points counts (no backfilling).
const CHALLENGE_POINTS = 500;
const inWeek = 'user_id = ? AND ended_at >= ? AND ended_at < ?';
const CHALLENGES = [
  { key: 'rediscover', unit: 'minutes', sql: `SELECT COALESCE(SUM(scored_minutes), 0) AS v FROM time_logs WHERE ${inWeek} AND bonuses LIKE '%"key":"rediscovered"%'` },
  { key: 'variety', unit: 'count', sql: `SELECT COUNT(DISTINCT item_id) AS v FROM time_logs WHERE ${inWeek} AND scored_minutes >= 15` },
  { key: 'days', unit: 'count', sql: `SELECT COUNT(*) AS v FROM (SELECT date(ended_at / 1000, 'unixepoch', 'localtime') AS d, SUM(scored_minutes) AS m FROM time_logs WHERE ${inWeek} GROUP BY d HAVING m >= 15)` },
  { key: 'focus', unit: 'minutes', sql: `SELECT COALESCE(MAX(scored_minutes), 0) AS v FROM time_logs WHERE ${inWeek} AND source = 'timer'` },
  { key: 'projects', unit: 'minutes', sql: `SELECT COALESCE(SUM(l.scored_minutes), 0) AS v FROM time_logs l JOIN items i ON i.id = l.item_id WHERE l.${inWeek.replace(/ ended_at/g, ' l.ended_at')} AND i.kind = 'project'` },
  { key: 'live', unit: 'minutes', sql: `SELECT COALESCE(SUM(scored_minutes), 0) AS v FROM time_logs WHERE ${inWeek} AND source = 'timer'` },
];
const challengeOf = (weekStart) => CHALLENGES[Math.round(weekStart / (7 * DAY)) % CHALLENGES.length];
const nextWeek = (ws) => { const d = new Date(ws); d.setDate(d.getDate() + 7); return d.getTime(); };
function challengeStandings(ids, weekStart) {
  const c = challengeOf(weekStart), end = nextWeek(weekStart), stmt = q(c.sql);
  return { challenge: c, values: ids.map((id) => ({ id, value: stmt.get(id, weekStart, end).v || 0 })) };
}
const challengeChecked = new Map();
function awardChallenge(user, now = Date.now()) {
  const lastWeek = score.startOfWeek(score.startOfWeek(now) - 1);
  if (challengeChecked.get(user.id) === lastWeek) return;
  if (challengeChecked.size > 50_000) challengeChecked.clear();
  challengeChecked.set(user.id, lastWeek);
  const day = dayKey(lastWeek);
  if (q("SELECT 1 FROM score_events WHERE user_id = ? AND kind = 'challenge' AND day = ?").get(user.id, day)) return;
  const ids = [user.id, ...visibleFriendIds(user.id)];
  if (ids.length < 2) return;
  const { challenge, values } = challengeStandings(ids, lastWeek);
  const mine = values[0].value, top = Math.max(...values.map((v) => v.value));
  if (mine > 0 && mine >= top) {
    q('INSERT OR IGNORE INTO score_events (user_id, kind, day, points, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, 'challenge', day, CHALLENGE_POINTS, challenge.key, nextWeek(lastWeek));
  }
}
function challengeView(user, ids, names, now = Date.now()) {
  const weekStart = score.startOfWeek(now);
  const { challenge, values } = challengeStandings(ids, weekStart);
  return {
    key: challenge.key, unit: challenge.unit, ends: nextWeek(weekStart), points: CHALLENGE_POINTS,
    wins: q("SELECT COUNT(*) AS n FROM score_events WHERE user_id = ? AND kind = 'challenge'").get(user.id).n,
    standings: values.map((v) => ({ username: names.get(v.id), value: v.value, you: v.id === user.id }))
      .sort((a, b) => b.value - a.value || a.username.localeCompare(b.username)),
  };
}

function friendsView(user) {
  const now = Date.now();
  const ids = [user.id, ...visibleFriendIds(user.id)];
  const prefs = prefsById(ids);
  const names = new Map(q(`SELECT id, username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => [r.id, r.username]));
  const periods = { week: score.startOfWeek(now), month: score.startOfMonth(now), all: 0 };
  const streaks = new Map(ids.map((id) => [id, score.currentStreak(id, now)]));
  const nudged = new Set(q('SELECT to_id FROM nudges WHERE from_id = ? AND day = ?').all(user.id, dayKey(now)).map((r) => r.to_id));
  const board = {};
  for (const [period, since] of Object.entries(periods)) {
    board[period] = ids.map((id) => {
      const p = score.pointsSince(id, since);
      const st = streaks.get(id);
      return { username: names.get(id), points: p.points, minutes: p.minutes, streak: st.days, you: id === user.id,
        ...(id !== user.id && st.days > 0 && !st.doneToday && prefs.get(id).allowNudges ? { atRisk: true, nudged: nudged.has(id) } : {}) };
    }).sort((x, y) => y.points - x.points || y.minutes - x.minutes || x.username.localeCompare(y.username))
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }
  return {
    board,
    feed: feedFor(user, ids.filter((id) => id === user.id || prefs.get(id).shareMoments)),
    challenge: challengeView(user, ids, names, now),
    friends: friendIds(user.id).map((id) => names.get(id) || q('SELECT username FROM users WHERE id = ?').get(id).username).sort((x, y) => x.localeCompare(y)),
    incoming: q('SELECT u.username, r.created_at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC').all(user.id)
      .map((r) => ({ username: r.username, createdAt: r.created_at })),
    outgoing: q('SELECT u.username, r.created_at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC').all(user.id)
      .map((r) => ({ username: r.username, createdAt: r.created_at })),
  };
}
route('GET', '/api/friends', true, (req, res, body, user) => friendsView(user));
route('POST', '/api/friends/request', true, (req, res, body, user) => {
  limit(req, 'friend-request', 30, 3600_000);
  if (hit(`friend-request-user:${user.id}`, 50, DAY)) throw new HttpError(429, 'You’ve sent a lot of friend requests today. Try again tomorrow.');
  const other = otherUser(user, body.username);
  if (areFriends(user.id, other.id)) throw new HttpError(409, `You and ${other.username} are already friends`);
  if (q('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(other.id, user.id)) {
    // they already asked you: that's a yes
    tx(() => {
      q('INSERT OR IGNORE INTO friendships (a, b, created_at) VALUES (?, ?, ?)').run(...pairOf(user.id, other.id), Date.now());
      q('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(user.id, other.id, other.id, user.id);
    });
    try { ach.check(other.id); } catch (e) { console.error('achievements', e); }
    return { ...friendsView(user), accepted: other.username };
  }
  if (friendIds(user.id).length >= 100) bad('You can have up to 100 friends');
  if (q('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?').get(user.id).n >= 50) bad('You have too many open requests. Cancel a few first.');
  q('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').run(user.id, other.id, Date.now());
  return { ...friendsView(user), sent: other.username };
});
route('POST', '/api/friends/accept', true, (req, res, body, user) => {
  const other = otherUser(user, body.username);
  if (!q('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(other.id, user.id)) throw new HttpError(404, 'That request no longer exists');
  if (friendIds(user.id).length >= 100) bad('You can have up to 100 friends');
  tx(() => {
    q('INSERT OR IGNORE INTO friendships (a, b, created_at) VALUES (?, ?, ?)').run(...pairOf(user.id, other.id), Date.now());
    q('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(user.id, other.id, other.id, user.id);
  });
  try { ach.check(other.id); } catch (e) { console.error('achievements', e); }
  return friendsView(user);
});
route('POST', '/api/friends/decline', true, (req, res, body, user) => {
  const other = otherUser(user, body.username);
  q('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(other.id, user.id);
  return friendsView(user);
});
route('POST', '/api/friends/cancel', true, (req, res, body, user) => {
  const other = otherUser(user, body.username);
  q('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(user.id, other.id);
  return friendsView(user);
});
route('POST', '/api/friends/remove', true, (req, res, body, user) => {
  const other = otherUser(user, body.username);
  q('DELETE FROM friendships WHERE a = ? AND b = ?').run(...pairOf(user.id, other.id));
  return friendsView(user);
});

// --- project checklists
function ownSteps(user, itemId) {
  return q('SELECT id, text, done_at, position FROM project_steps WHERE item_id = ? AND user_id = ? ORDER BY position, id').all(itemId, user.id)
    .map((x) => ({ id: x.id, text: x.text, done: !!x.done_at }));
}
// --- nudges: a friend's streak is waiting for today's 15 minutes
route('POST', '/api/nudge', true, (req, res, body, user) => {
  limit(req, 'nudge', 60, 3600_000);
  const other = otherUser(user, body.username);
  if (!areFriends(user.id, other.id)) throw new HttpError(403, 'You can only nudge your friends');
  const op = prefsById([other.id]).get(other.id);
  if (op.private || !op.allowNudges) throw new HttpError(403, 'They’ve turned off nudges');
  const st = score.currentStreak(other.id);
  if (!st.days || st.doneToday) bad('Their streak is safe today');
  const r = q('INSERT OR IGNORE INTO nudges (from_id, to_id, day, created_at) VALUES (?, ?, ?, ?)').run(user.id, other.id, dayKey(Date.now()), Date.now());
  if (!r.changes) throw new HttpError(409, 'You already nudged them today');
  return friendsView(user);
});
route('POST', '/api/nudges/seen', true, (req, res, body, user) => {
  q('UPDATE nudges SET seen = 1 WHERE to_id = ?').run(user.id);
  q('DELETE FROM nudges WHERE created_at < ?').run(Date.now() - 30 * DAY);
  return { ok: true };
});

route('GET', '/api/items/:id/steps', true, (req, res, body, user, p) => ({ steps: ownSteps(user, ownItem(user, p.id).id) }));
route('POST', '/api/items/:id/steps', true, (req, res, body, user, p) => {
  const item = ownItem(user, p.id);
  const text = str(body.text, 'Step', 1, 120);
  const n = q('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS m FROM project_steps WHERE item_id = ?').get(item.id);
  if (n.n >= 100) bad('A project can have up to 100 steps');
  q('INSERT INTO project_steps (user_id, item_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, item.id, text, n.m + 1, Date.now());
  return { ...buildState(user), steps: ownSteps(user, item.id) };
});
route('PATCH', '/api/steps/:id', true, (req, res, body, user, p) => {
  const st = q('SELECT * FROM project_steps WHERE id = ? AND user_id = ?').get(id(p.id), user.id);
  if (!st) throw new HttpError(404, 'That step no longer exists');
  const text = body.text !== undefined ? str(body.text, 'Step', 1, 120) : st.text;
  const done = typeof body.done === 'boolean' ? (body.done ? (st.done_at || Date.now()) : null) : st.done_at;
  q('UPDATE project_steps SET text = ?, done_at = ? WHERE id = ?').run(text, done, st.id);
  return { ...buildState(user), steps: ownSteps(user, st.item_id) };
});
route('DELETE', '/api/steps/:id', true, (req, res, body, user, p) => {
  const st = q('SELECT * FROM project_steps WHERE id = ? AND user_id = ?').get(id(p.id), user.id);
  if (!st) throw new HttpError(404, 'That step no longer exists');
  q('DELETE FROM project_steps WHERE id = ?').run(st.id);
  return { ...buildState(user), steps: ownSteps(user, st.item_id) };
});

// --- spins (counted for achievements; one per 2 seconds at most)
const lastSpin = new Map();
route('POST', '/api/spin', true, (req, res, body, user) => {
  const now = Date.now();
  if (now - (lastSpin.get(user.id) || 0) >= 2000) { lastSpin.set(user.id, now); ach.bump(user.id, 'spins'); }
  if (lastSpin.size > 10_000) lastSpin.clear();
  return { ok: true };
});

// --- achievements
route('GET', '/api/achievements', true, (req, res, body, user) => ({ achievements: ach.list(user.id) }));

// --- high-fives on friends' moments
// Moments are streak milestones, finished projects and achievements, shown without item names.
function momentText(kind, own) {
  let m;
  if ((m = kind.match(/^streak-(\d+)$/))) return `${own ? 'your' : 'a'} ${m[1]}-day streak`;
  if (kind.startsWith('finish-')) return `${own ? 'your' : 'a'} finished project`;
  if ((m = kind.match(/^ach-(.+)$/))) { const a = ach.BY_KEY.get(m[1]); return `${own ? 'your' : 'an'} “${a ? a.name : 'achievement'}” badge`; }
  if (kind === 'challenge') return own ? 'your weekly challenge win' : 'a weekly challenge win';
  return 'a moment';
}
function feedFor(user, ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return q(`SELECT e.id, e.kind, e.created_at, e.user_id, u.username,
              (SELECT COUNT(*) FROM high_fives h WHERE h.event_id = e.id) AS fives,
              (SELECT 1 FROM high_fives h WHERE h.event_id = e.id AND h.from_id = ?) AS mine
            FROM score_events e JOIN users u ON u.id = e.user_id
            WHERE e.user_id IN (${marks}) AND e.created_at > ? ORDER BY e.created_at DESC LIMIT 80`)
    .all(user.id, ...ids, Date.now() - 14 * DAY)
    .filter((e) => { const m = e.kind.match(/^ach-(.+)$/); return !m || (ach.BY_KEY.get(m[1]) || {}).tier !== 'bronze'; })
    .slice(0, 40)
    .map((e) => {
      const you = e.user_id === user.id;
      let m; let text;
      if ((m = e.kind.match(/^streak-(\d+)$/))) text = `hit a ${m[1]}-day streak`;
      else if (e.kind.startsWith('finish-')) text = 'finished a project';
      else if ((m = e.kind.match(/^ach-(.+)$/))) { const a = ach.BY_KEY.get(m[1]); text = `unlocked “${a ? a.name : 'an achievement'}”`; }
      else if (e.kind === 'challenge') text = 'won the weekly challenge';
      else text = 'did something great';
      return { id: e.id, username: e.username, you, text, at: e.created_at, fives: e.fives, fived: !!e.mine };
    });
}
route('POST', '/api/high-five', true, (req, res, body, user) => {
  limit(req, 'high-five', 120, 3600_000);
  const e = q('SELECT id, user_id, created_at FROM score_events WHERE id = ?').get(id(body.eventId));
  const owner = e && prefsById([e.user_id]).get(e.user_id);
  if (!e || e.user_id === user.id || !areFriends(user.id, e.user_id) || Date.now() - e.created_at > 30 * DAY || owner.private || !owner.shareMoments) {
    throw new HttpError(404, 'You can only high-five your friends’ recent moments');
  }
  q('INSERT OR IGNORE INTO high_fives (from_id, event_id, created_at) VALUES (?, ?, ?)').run(user.id, e.id, Date.now());
  try { ach.check(e.user_id); } catch (err) { console.error('achievements', err); }
  return friendsView(user);
});
route('POST', '/api/high-fives/seen', true, (req, res, body, user) => {
  q('UPDATE high_fives SET seen = 1 WHERE seen = 0 AND event_id IN (SELECT id FROM score_events WHERE user_id = ?)').run(user.id);
  return { ok: true };
});

// --- weekly recap: the last finished week
function pointsBetween(userId, start, end) {
  const a = q('SELECT COALESCE(SUM(points), 0) AS p, COALESCE(SUM(minutes), 0) AS m, COUNT(*) AS n FROM time_logs WHERE user_id = ? AND ended_at >= ? AND ended_at < ?').get(userId, start, end);
  const b = q('SELECT COALESCE(SUM(points), 0) AS p FROM score_events WHERE user_id = ? AND created_at >= ? AND created_at < ?').get(userId, start, end).p;
  return { points: a.p + b, minutes: a.m, sessions: a.n };
}
route('GET', '/api/recap', true, (req, res, body, user) => {
  const end = score.startOfWeek(Date.now());
  const back = (t, days) => { const d = new Date(t); d.setDate(d.getDate() - days); return d.getTime(); };
  const start = back(end, 7), prevStart = back(end, 14);
  const week = pointsBetween(user.id, start, end);
  const prev = pointsBetween(user.id, prevStart, start);
  const perDay = new Map();
  for (const r of q('SELECT ended_at, minutes FROM time_logs WHERE user_id = ? AND ended_at >= ? AND ended_at < ?').all(user.id, start, end)) {
    const k = new Date(r.ended_at).toDateString(); perDay.set(k, (perDay.get(k) || 0) + r.minutes);
  }
  const bestDay = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const ids = [user.id, ...friendIds(user.id)];
  const standings = ids.map((uid) => ({ uid, ...pointsBetween(uid, start, end) })).sort((a, b) => b.points - a.points || b.minutes - a.minutes);
  return {
    start, end,
    minutes: week.minutes, points: week.points, sessions: week.sessions, daysActive: perDay.size,
    prevMinutes: prev.minutes, prevPoints: prev.points,
    bestDay: bestDay ? { day: new Date(bestDay[0]).getTime(), minutes: bestDay[1] } : null,
    top: q(`SELECT i.name, i.kind, SUM(l.minutes) AS minutes FROM time_logs l JOIN items i ON i.id = l.item_id
            WHERE l.user_id = ? AND l.ended_at >= ? AND l.ended_at < ? GROUP BY i.id ORDER BY minutes DESC LIMIT 3`).all(user.id, start, end),
    rank: ids.length > 1 ? standings.findIndex((x) => x.uid === user.id) + 1 : null,
    people: ids.length,
    achievements: q('SELECT key FROM user_achievements WHERE user_id = ? AND unlocked_at >= ? AND unlocked_at < ?').all(user.id, start, end)
      .map((r) => { const a = ach.BY_KEY.get(r.key); return a ? { name: a.name, tier: a.tier, cat: a.cat } : null; }).filter(Boolean),
    highFives: q('SELECT COUNT(*) AS n FROM high_fives h JOIN score_events e ON e.id = h.event_id WHERE e.user_id = ? AND h.created_at >= ? AND h.created_at < ?').get(user.id, start, end).n,
    buys: q('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND created_at >= ? AND created_at < ?').get(user.id, start, end).n,
  };
});

// --- admin
route('GET', '/api/admin/users', true, (req, res, body, user) => {
  requireAdmin(user);
  return {
    users: q(`SELECT u.id, u.username, u.is_admin, u.created_at, MAX(s.last_seen) AS last_seen,
                (SELECT expires_at FROM password_resets r WHERE r.user_id = u.id AND r.expires_at > ?) AS reset_pending
              FROM users u LEFT JOIN auth_sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.created_at`).all(Date.now())
      .map((u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin, createdAt: u.created_at, lastSeen: u.last_seen, resetPending: !!u.reset_pending, you: u.id === user.id })),
  };
});
// Site stats for the admin: totals and per-day numbers, never anything about one person.
const STARTED_AT = Date.now();
route('GET', '/api/admin/stats', true, (req, res, body, user) => {
  requireAdmin(user);
  flushTraffic();
  const asked = Number(new URL(req.url, 'http://local').searchParams.get('days'));
  const days = [7, 30, 90, 365].includes(asked) ? asked : 30;
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
  const from = start.getTime(), now = Date.now();
  const one = (sql, ...a) => q(sql).get(...a).n || 0;
  // one row per day, oldest first
  const list = [];
  for (const d = new Date(from); d.getTime() <= now; d.setDate(d.getDate() + 1)) list.push({ day: localDay(d.getTime()) });
  const byDay = new Map(list.map((r) => [r.day, r]));
  const put = (rows, key) => { for (const r of rows) { const d = byDay.get(r.day); if (d) d[key] = (d[key] || 0) + r.n; } };
  const dayOf = (col) => `date(${col} / 1000, 'unixepoch', 'localtime')`;
  put(q(`SELECT ${dayOf('ended_at')} AS day, SUM(minutes) AS n FROM time_logs WHERE ended_at >= ? GROUP BY day`).all(from), 'minutes');
  put(q(`SELECT ${dayOf('ended_at')} AS day, COUNT(*) AS n FROM time_logs WHERE ended_at >= ? GROUP BY day`).all(from), 'sessions');
  put(q(`SELECT ${dayOf('ended_at')} AS day, SUM(points) AS n FROM time_logs WHERE ended_at >= ? GROUP BY day`).all(from), 'points');
  put(q(`SELECT ${dayOf('created_at')} AS day, SUM(points) AS n FROM score_events WHERE created_at >= ? GROUP BY day`).all(from), 'points');
  put(q(`SELECT ${dayOf('created_at')} AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day`).all(from), 'signups');
  for (const r of q('SELECT day, key, value FROM site_daily WHERE day >= ?').all(localDay(from))) {
    const d = byDay.get(r.day); if (d) d[r.key] = r.value;
  }
  const keys = ['minutes', 'sessions', 'points', 'signups', 'page_views', 'requests', 'api', 'active', 'signins', 'signins_failed', 'blocked', 'errors'];
  const daily = list.map((d) => Object.fromEntries([['day', d.day], ...keys.map((k) => [k, d[k] || 0])]));
  const sum = (k) => daily.reduce((a, d) => a + d[k], 0);
  let dbBytes = 0;
  for (const f of ['bored.db', 'bored.db-wal']) { try { dbBytes += fs.statSync(path.join(DATA_DIR, f)).size; } catch { /* no wal yet */ } }
  return {
    days,
    totals: {
      accounts: one('SELECT COUNT(*) AS n FROM users'),
      active7: one('SELECT COUNT(DISTINCT user_id) AS n FROM auth_sessions WHERE last_seen > ?', now - 7 * DAY),
      active30: one('SELECT COUNT(DISTINCT user_id) AS n FROM auth_sessions WHERE last_seen > ?', now - 30 * DAY),
      minutes: one('SELECT COALESCE(SUM(minutes), 0) AS n FROM time_logs'),
      sessions: one('SELECT COUNT(*) AS n FROM time_logs'),
      points: one('SELECT COALESCE(SUM(points), 0) AS n FROM time_logs') + one('SELECT COALESCE(SUM(points), 0) AS n FROM score_events'),
      items: one('SELECT COUNT(*) AS n FROM items'),
      wishes: one('SELECT COUNT(*) AS n FROM wishes'),
      purchases: one('SELECT COUNT(*) AS n FROM purchases'),
      friendships: one('SELECT COUNT(*) AS n FROM friendships'),
      achievements: one("SELECT COUNT(*) AS n FROM score_events WHERE kind LIKE 'ach-%'"),
      highFives: one('SELECT COUNT(*) AS n FROM high_fives'),
      spins: one("SELECT COALESCE(SUM(value), 0) AS n FROM user_counters WHERE key = 'spins'"),
      timersRunning: one('SELECT COUNT(*) AS n FROM timers'),
    },
    period: Object.fromEntries(keys.map((k) => [k, sum(k)])),
    daily,
    server: { release: APP_RELEASE, version: APP_VERSION, upSince: STARTED_AT, dbBytes, memoryBytes: process.memoryUsage().rss, node: process.version },
  };
});
route('POST', '/api/admin/users/:id/reset', true, (req, res, body, user, p) => {
  requireAdmin(user);
  const target = q('SELECT id, username FROM users WHERE id = ?').get(id(p.id));
  if (!target) throw new HttpError(404, 'That account no longer exists');
  if (target.id === user.id) bad('Change your own password in Settings instead');
  const code = randomCode(3);
  q(`INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
    .run(target.id, sha256(normKey(code)), Date.now() + RESET_CODE_TTL);
  clearFailures(`user:${failKey(target.username)}`);
  clearFailures(`reset:${failKey(target.username)}`);
  secLog('reset-code-created', { by: user.username, for: target.username });
  return { code, username: target.username, expiresAt: Date.now() + RESET_CODE_TTL };
});
route('POST', '/api/admin/users/:id/delete', true, (req, res, body, user, p) => {
  requireAdmin(user);
  const target = q('SELECT id, username FROM users WHERE id = ?').get(id(p.id));
  if (!target) throw new HttpError(404, 'That account no longer exists');
  if (target.id === user.id) bad('You can’t remove the admin account');
  q('DELETE FROM users WHERE id = ?').run(target.id);
  secLog('account-removed-by-admin', { by: user.username, user: target.username });
  return { ok: true };
});

// --- items
route('POST', '/api/items', true, (req, res, body, user) => {
  const name = str(body.name, 'Name', 1, 60);
  const kind = KINDS.includes(body.kind) ? body.kind : 'hobby';
  if (q('SELECT COUNT(*) AS n FROM items WHERE user_id = ?').get(user.id).n >= 200) bad('You can have up to 200 things');
  q('INSERT INTO items (user_id, name, kind, created_at, quick, chill) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, name, kind, Date.now(), body.quick === true ? 1 : 0, body.chill === true ? 1 : 0);
  return buildState(user);
});
route('PATCH', '/api/items/:id', true, (req, res, body, user, p) => {
  const item = ownItem(user, p.id);
  const name = body.name !== undefined ? str(body.name, 'Name', 1, 60) : item.name;
  const kind = KINDS.includes(body.kind) ? body.kind : item.kind;
  const archived = body.archived !== undefined ? (body.archived ? 1 : 0) : item.archived;
  const quick = typeof body.quick === 'boolean' ? (body.quick ? 1 : 0) : item.quick;
  const chill = typeof body.chill === 'boolean' ? (body.chill ? 1 : 0) : item.chill;
  const snoozed = body.snoozeDays !== undefined ? (int(body.snoozeDays, 'Days', 0, 30) ? Date.now() + Number(body.snoozeDays) * DAY : 0) : item.snoozed_until;
  q('UPDATE items SET name = ?, kind = ?, archived = ?, quick = ?, chill = ?, snoozed_until = ? WHERE id = ?').run(name, kind, archived, quick, chill, snoozed, item.id);
  if (archived) q('DELETE FROM timers WHERE user_id = ? AND item_id = ?').run(user.id, item.id);
  const bonus = archived && !item.archived ? score.finishBonus(user.id, { ...item, name, kind }) : null;
  return { ...buildState(user), bonus };
});
route('DELETE', '/api/items/:id', true, (req, res, body, user, p) => {
  const item = ownItem(user, p.id);
  q('DELETE FROM items WHERE id = ?').run(item.id);
  return buildState(user);
});

// --- timer & logs
// Offline devices replay what happened with the time it happened (startedAt, endedAt, at).
// Those times must sit between `min` and now, so nobody can backdate a timer by days.
function clientTime(v, min) {
  const now = Date.now();
  if (v === undefined || v === null) return now;
  const t = Number(v);
  if (!Number.isFinite(t)) bad('That date is not valid');
  return Math.min(Math.max(Math.round(t), min), now);
}
const OFFLINE_WINDOW = 12 * 3600_000;
const note = (v) => (v === undefined || v === null ? '' : str(v, 'Note', 0, 200));
const timerElapsed = (t, end) => end - t.started_at - t.paused_ms - (t.paused_at ? end - t.paused_at : 0);

route('POST', '/api/timer/start', true, (req, res, body, user) => {
  const item = ownItem(user, body.itemId);
  if (item.archived) bad('Put it back on the wheel first');
  if (q('SELECT 1 FROM timers WHERE user_id = ?').get(user.id)) bad('A timer is already running. Stop it first.');
  const startedAt = clientTime(body.startedAt, Date.now() - OFFLINE_WINDOW);
  q('INSERT INTO timers (user_id, item_id, started_at, from_spin) VALUES (?, ?, ?, ?)').run(user.id, item.id, startedAt, body.fromSpin === true ? 1 : 0);
  return buildState(user);
});
route('POST', '/api/timer/pause', true, (req, res, body, user) => {
  const t = q('SELECT * FROM timers WHERE user_id = ?').get(user.id);
  if (!t) bad('No timer is running');
  if (!t.paused_at) q('UPDATE timers SET paused_at = ? WHERE user_id = ?').run(clientTime(body.at, t.started_at), user.id);
  return buildState(user);
});
route('POST', '/api/timer/resume', true, (req, res, body, user) => {
  const t = q('SELECT * FROM timers WHERE user_id = ?').get(user.id);
  if (!t) bad('No timer is running');
  if (t.paused_at) {
    const at = clientTime(body.at, t.paused_at);
    q('UPDATE timers SET paused_at = 0, paused_ms = paused_ms + ? WHERE user_id = ?').run(at - t.paused_at, user.id);
  }
  return buildState(user);
});
route('POST', '/api/timer/stop', true, (req, res, body, user) => {
  const t = q('SELECT * FROM timers WHERE user_id = ?').get(user.id);
  if (!t) bad('No timer is running');
  const end = clientTime(body.endedAt, t.started_at);
  const elapsed = Math.max(0, Math.round(timerElapsed(t, end) / 60000));
  let minutes = Math.min(elapsed, 24 * 60);
  if (body.minutes !== undefined) minutes = Math.min(int(body.minutes, 'Minutes', 0, 24 * 60), Math.max(elapsed, 1));
  const text = note(body.note);
  const before = buildState(user).bank.unlocks;
  const item = q('SELECT * FROM items WHERE id = ?').get(t.item_id);
  const earned = tx(() => {
    q('DELETE FROM timers WHERE user_id = ?').run(user.id);
    return minutes >= 1 && item ? addLog(user, item, minutes, end, 'timer', !!t.from_spin, text) : null;
  });
  const state = buildState(user);
  return { ...state, logged: minutes, newUnlocks: state.bank.unlocks - before, earned };
});
route('POST', '/api/timer/cancel', true, (req, res, body, user) => {
  q('DELETE FROM timers WHERE user_id = ?').run(user.id);
  return buildState(user);
});
route('POST', '/api/logs', true, (req, res, body, user) => {
  const item = ownItem(user, body.itemId);
  const minutes = int(body.minutes, 'Minutes', 1, 24 * 60);
  let endedAt = Date.now();
  if (body.endedAt !== undefined) {
    const d = Number(body.endedAt);
    if (!Number.isFinite(d) || d < Date.now() - 5 * 365 * DAY) bad('That date is not valid');
    if (d > Date.now() + DAY) bad('You can’t log time in the future');
    endedAt = Math.min(Math.round(d), Date.now());
  }
  const text = note(body.note);
  const before = buildState(user).bank.unlocks;
  const earned = tx(() => addLog(user, item, minutes, endedAt, 'manual', false, text));
  const state = buildState(user);
  return { ...state, logged: minutes, newUnlocks: state.bank.unlocks - before, earned };
});
// Edit a session: its note any time, its length too (points are worked out again as if it was
// logged like that at the time). Making a timed session longer turns it into time added by hand.
route('PATCH', '/api/logs/:id', true, (req, res, body, user, p) => {
  const log = q('SELECT * FROM time_logs WHERE id = ? AND user_id = ?').get(id(p.id), user.id);
  if (!log) throw new HttpError(404, 'That entry no longer exists');
  const text = body.note !== undefined ? note(body.note) : log.note;
  const minutes = body.minutes !== undefined ? int(body.minutes, 'Minutes', 1, 24 * 60) : log.minutes;
  tx(() => {
    q('UPDATE time_logs SET note = ? WHERE id = ?').run(text, log.id);
    if (minutes === log.minutes) return;
    const item = q('SELECT * FROM items WHERE id = ?').get(log.item_id);
    const source = minutes > log.minutes ? 'manual' : log.source;
    q('UPDATE time_logs SET scored_minutes = 0 WHERE id = ?').run(log.id);   // so the daily cap only counts the others
    const e = score.scoreSession({ userId: user.id, item, minutes, endedAt: log.ended_at, source, fromSpin: !!log.from_spin, now: log.created_at || log.ended_at });
    q(`UPDATE time_logs SET minutes = ?, source = ?, points = ?, scored_minutes = ?, multiplier = ?, bonuses = ?, edited = 1 WHERE id = ?`)
      .run(minutes, source, e.points, e.scoredMinutes, e.multiplier, JSON.stringify(e.bonuses), log.id);
    score.milestone(user.id, log.ended_at);
  });
  return buildState(user);
});
route('DELETE', '/api/logs/:id', true, (req, res, body, user, p) => {
  const r = q('DELETE FROM time_logs WHERE id = ? AND user_id = ?').run(id(p.id), user.id);
  if (!r.changes) throw new HttpError(404, 'That entry no longer exists');
  return buildState(user);
});

// --- wishlist & purchases
route('POST', '/api/wishes', true, (req, res, body, user) => {
  const name = str(body.name, 'Name', 1, 80);
  let price = null;
  if (body.price !== undefined && body.price !== null && body.price !== '') {
    price = Number(body.price);
    if (!Number.isFinite(price) || price < 0 || price > 1e7) bad('Price must be a positive number');
    price = Math.round(price * 100) / 100;
  }
  if (q('SELECT COUNT(*) AS n FROM wishes WHERE user_id = ?').get(user.id).n >= 500) bad('Your wishlist is full');
  q('INSERT INTO wishes (user_id, name, price, created_at) VALUES (?, ?, ?, ?)').run(user.id, name, price, Date.now());
  return buildState(user);
});
route('DELETE', '/api/wishes/:id', true, (req, res, body, user, p) => {
  const w = q('SELECT * FROM wishes WHERE id = ? AND user_id = ?').get(id(p.id), user.id);
  if (w && !w.bought_at && Date.now() - w.created_at >= 3 * DAY) {
    ach.bump(user.id, 'wishes_resisted');
    if (w.price) ach.bump(user.id, 'money_saved', w.price);
  }
  q('DELETE FROM wishes WHERE id = ? AND user_id = ?').run(id(p.id), user.id);
  return buildState(user);
});
route('POST', '/api/purchases', true, (req, res, body, user) => {
  const state = buildState(user);
  if (state.bank.unlocks < 1) bad(`Not unlocked yet. Log ${fmtH(state.bank.costMinutes - state.bank.progressMinutes)} more first.`);
  let name; let wishId = null;
  if (body.wishId !== undefined) {
    const w = q('SELECT * FROM wishes WHERE id = ? AND user_id = ?').get(id(body.wishId), user.id);
    if (!w) throw new HttpError(404, 'That wish no longer exists');
    if (w.bought_at) bad('You already bought that');
    name = w.name; wishId = w.id;
  } else {
    name = str(body.name, 'Name', 1, 80);
  }
  const now = Date.now();
  tx(() => {
    q('INSERT INTO purchases (user_id, name, cost_minutes, wish_id, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, name, state.bank.costMinutes, wishId, now);
    if (wishId) q('UPDATE wishes SET bought_at = ? WHERE id = ?').run(now, wishId);
  });
  return buildState(user);
});
route('DELETE', '/api/purchases/:id', true, (req, res, body, user, p) => {
  const pur = q('SELECT * FROM purchases WHERE id = ? AND user_id = ?').get(id(p.id), user.id);
  if (!pur) throw new HttpError(404, 'That purchase no longer exists');
  tx(() => {
    q('DELETE FROM purchases WHERE id = ?').run(pur.id);
    if (pur.wish_id) q('UPDATE wishes SET bought_at = NULL WHERE id = ?').run(pur.wish_id);
  });
  return buildState(user);
});

// ---------- security headers ----------
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'",
  "font-src 'self'", "img-src 'self'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ');
function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), display-capture=()');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
// Only files that exist in public/ at startup can ever be served.
const STATIC = new Map();
(function load(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) load(full, `${prefix}${e.name}/`);
    else if (MIME[path.extname(e.name)]) STATIC.set(`/${prefix}${e.name}`, { file: full, type: MIME[path.extname(e.name)] });
  }
})(PUBLIC_DIR, '');
// The page asks for its scripts and styles with the version in the address (/app.js?v=…).
// Cloudflare and browsers may keep those files for hours, so a new address per version is
// the only reliable way to make every device pick up an update straight away.
{
  const v = encodeURIComponent(APP_VERSION === 'dev' ? String(Date.now()) : APP_VERSION);
  const page = STATIC.get('/index.html');
  page.body = Buffer.from(fs.readFileSync(page.file, 'utf8')
    .replace(/(src|href)="(\/(?:app|i18n)\.js|\/style\.css|\/fonts\/fonts\.css)"/g, (m, attr, url) => `${attr}="${url}?v=${v}"`));
}
function serveStatic(req, res, pathname) {
  const entry = STATIC.get(pathname) || (path.extname(pathname) ? null : STATIC.get('/index.html'));
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  if (entry === STATIC.get('/index.html') && req.method === 'GET') countVisit('page_views');
  if (entry.body) {
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : entry.body);
  }
  fs.readFile(entry.file, (err, data) => {
    if (err) { res.writeHead(500); return res.end(); }
    const longCache = /\.(png|svg|woff2)$/.test(entry.file);
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- server ----------
// Achievements are checked after every change, and on loading the app at most every 10 minutes
// (for ones that depend on time passing or on friends).
const lastStateCheck = new Map();
function wantsAchievementCheck(req, pathname, user) {
  if (['/api/logout', '/api/account/delete', '/api/password', '/api/high-fives/seen'].includes(pathname)) return false;
  if (req.method !== 'GET') return 'full';
  if (pathname !== '/api/state') return false;
  const now = Date.now();
  if (now - (lastStateCheck.get(user.id) || 0) < 10 * 60_000) return 'deliver';
  if (lastStateCheck.size > 10_000) lastStateCheck.clear();
  lastStateCheck.set(user.id, now);
  return 'full';
}

async function handle(req, res) {
  securityHeaders(req, res);
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = '/'; }

  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  countVisit('requests');
  res.once('finish', () => {
    if (res.statusCode === 429) countVisit('blocked');
    else if (res.statusCode >= 500) countVisit('errors');
  });
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    return serveStatic(req, res, pathname);
  }

  try {
    // Overall per-IP cap on API use, to protect the Pi.
    countVisit('api');
    const wait = hit(`api:${ipKey(clientIp(req))}`, 600, 5 * 60_000);
    if (wait) throw new HttpError(429, `Slow down a little. Try again in ${waitText(wait)}.`);

    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET') {
      // CSRF: state changes must be same-origin JSON requests.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site requests aren’t allowed');
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send JSON');
    }
    const m = pathname.match(r.re);
    const params = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    let user = null;
    if (r.auth) {
      user = currentSession(req);
      if (!user) throw new HttpError(401, 'Sign in to continue');
      markActive(user.id);
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler(req, res, body, user, params);
    const mode = user && out && typeof out === 'object' ? wantsAchievementCheck(req, pathname, user) : false;
    if (mode) {
      try {
        if (mode === 'full') ach.check(user.id);
        const unseen = ach.deliver(user.id);
        if (unseen.length) out.achievements = unseen;
      } catch (e) { console.error('achievements', e); }
    }
    send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (e.status === 413) res.setHeader('Connection', 'close');
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something broke on the server. Try again.' });
  }
}

const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
  handle(req, res).catch((e) => { console.error(e); try { res.writeHead(500); res.end(); } catch { /* closed */ } });
});
server.requestTimeout = 20_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 60;
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

// Housekeeping: drop expired sessions and reset codes.
const cleanup = () => {
  q('DELETE FROM auth_sessions WHERE expires_at < ? OR last_seen < ?').run(Date.now(), Date.now() - SESSION_IDLE);
  q('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());
  q('DELETE FROM login_failures WHERE until < ? AND updated < ?').run(Date.now() - 3600_000, Date.now() - 3600_000);
  q('DELETE FROM site_active_today WHERE day <> ?').run(localDay());
  q('DELETE FROM site_daily WHERE day < ?').run(localDay(Date.now() - 400 * DAY));
};
cleanup();
setInterval(cleanup, 3600_000).unref();

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); process.exit(1); });

server.listen(PORT, () => console.log(`bored? ${APP_RELEASE} (${APP_VERSION}) listening on :${PORT} (data in ${DATA_DIR}, trust proxy: ${TRUST_PROXY})`));
const shutdown = () => { server.close(); try { flushTraffic(); } catch { /* closing anyway */ } db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
