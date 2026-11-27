'use strict';
// bored? — spin the wheel, do your stuff, earn your next purchase.
// Zero dependencies: Node's built-in http, crypto and sqlite.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_HOURS = Number(process.env.DEFAULT_HOURS_PER_UNLOCK || 20);
const COOKIE_SECURE = process.env.COOKIE_SECURE; // 'true' | 'false' | undefined (auto)
const SESSION_DAYS = 90;
const PUBLIC_DIR = path.join(__dirname, 'public');
const KINDS = ['hobby', 'game', 'project', 'learning', 'other'];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'bored.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
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
CREATE INDEX IF NOT EXISTS idx_logs_user ON time_logs(user_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
`);

// migration: admin flag (the first account is the admin)
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'is_admin'").get()) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
  db.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
}

const q = (sql) => db.prepare(sql);
const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ---------- invite key ----------
// One shared key with unlimited uses. Regenerating replaces it; existing accounts are unaffected.
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newInviteKey() {
  const bytes = crypto.randomBytes(16);
  const chars = [...bytes].map((b) => KEY_CHARS[b % KEY_CHARS.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
function getInviteKey() {
  let row = db.prepare("SELECT value FROM app_settings WHERE key = 'invite_key'").get();
  if (!row) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('invite_key', ?)").run(newInviteKey());
    row = db.prepare("SELECT value FROM app_settings WHERE key = 'invite_key'").get();
  }
  return row.value;
}
function regenInviteKey() {
  const key = newInviteKey();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('invite_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key);
  return key;
}
const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function inviteMatches(given) {
  const a = Buffer.from(normKey(given)), b = Buffer.from(normKey(getInviteKey()));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function str(v, field, min, max) {
  if (typeof v !== 'string') bad(`${field} is missing`);
  const s = v.trim();
  if (s.length < min) bad(`${field} needs at least ${min} character${min === 1 ? '' : 's'}`);
  if (s.length > max) bad(`${field} can be at most ${max} characters`);
  return s;
}
function int(v, field, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n) bad(`${field} must be a whole number`);
  if (n < min || n > max) bad(`${field} must be between ${min} and ${max}`);
  return n;
}

function clientIp(req) {
  return req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress;
}

// Simple in-memory limiter for login/register.
const attempts = new Map();
function rateLimit(req, key, max = 10, windowMs = 15 * 60 * 1000) {
  const k = key + ':' + clientIp(req);
  const now = Date.now();
  let a = attempts.get(k);
  if (!a || a.reset < now) { a = { n: 0, reset: now + windowMs }; attempts.set(k, a); }
  a.n++;
  if (a.n > max) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k); }, 60_000).unref();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecure(req) {
  if (COOKIE_SECURE === 'true') return true;
  if (COOKIE_SECURE === 'false') return false;
  return req.headers['x-forwarded-proto'] === 'https';
}
function sessionCookie(req, token, maxAge) {
  return `bored_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
}

function currentUser(req) {
  const token = parseCookies(req).bored_sid;
  if (!token) return null;
  const row = q(`SELECT u.id, u.username, u.hours_per_unlock, u.is_admin, s.expires_at FROM auth_sessions s
                 JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function ownItem(user, id) {
  const item = q('SELECT * FROM items WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!item) throw new HttpError(404, 'That item no longer exists');
  return item;
}

function addLog(user, itemId, minutes, endedAt, source) {
  q('INSERT INTO time_logs (user_id, item_id, minutes, ended_at, source) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, itemId, minutes, endedAt, source);
}

// ---------- state ----------
function buildState(user) {
  const items = q(`SELECT i.id, i.name, i.kind, i.archived, i.created_at,
                     COALESCE(SUM(l.minutes), 0) AS minutes, MAX(l.ended_at) AS last_at, COUNT(l.id) AS sessions
                   FROM items i LEFT JOIN time_logs l ON l.item_id = i.id
                   WHERE i.user_id = ? GROUP BY i.id ORDER BY i.created_at`).all(user.id);
  const earned = q('SELECT COALESCE(SUM(minutes), 0) AS m FROM time_logs WHERE user_id = ?').get(user.id).m;
  const spent = q('SELECT COALESCE(SUM(cost_minutes), 0) AS m FROM purchases WHERE user_id = ?').get(user.id).m;
  const cost = Math.round(user.hours_per_unlock * 60);
  const balance = earned - spent;
  const logs = q(`SELECT l.id, l.item_id, l.minutes, l.ended_at, l.source, i.name AS item_name
                  FROM time_logs l JOIN items i ON i.id = l.item_id
                  WHERE l.user_id = ? AND l.ended_at > ? ORDER BY l.ended_at DESC`)
    .all(user.id, Date.now() - 120 * 86400_000);
  return {
    now: Date.now(),
    user: {
      username: user.username,
      hoursPerUnlock: user.hours_per_unlock,
      isAdmin: !!user.is_admin,
      ...(user.is_admin ? { inviteKey: getInviteKey(), userCount: userCount() } : {}),
    },
    items,
    timer: q(`SELECT t.item_id, t.started_at, i.name AS item_name FROM timers t
              JOIN items i ON i.id = t.item_id WHERE t.user_id = ?`).get(user.id) || null,
    bank: {
      earnedMinutes: earned,
      spentMinutes: spent,
      costMinutes: cost,
      unlocks: balance > 0 ? Math.floor(balance / cost) : 0,
      progressMinutes: balance > 0 ? balance % cost : 0,
      purchasesCount: q('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ?').get(user.id).n,
    },
    logs,
    wishes: q('SELECT id, name, price, created_at, bought_at FROM wishes WHERE user_id = ? ORDER BY bought_at IS NOT NULL, created_at DESC').all(user.id),
    purchases: q('SELECT id, name, cost_minutes, created_at FROM purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id),
  };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, auth, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, auth, handler });
};

const APP_VERSION = process.env.APP_VERSION || 'dev';
const BUILD_DATE = process.env.BUILD_DATE || '';
route('GET', '/api/config', false, () => ({ needsInvite: userCount() > 0, defaultHours: DEFAULT_HOURS, version: APP_VERSION, buildDate: BUILD_DATE }));

route('POST', '/api/register', false, (req, res, body) => {
  rateLimit(req, 'register', 10, 60 * 60 * 1000);
  const username = str(body.username, 'Username', 3, 32);
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) bad('Username can only use letters, numbers, dots, dashes and underscores');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) bad('Password needs at least 8 characters');
  if (password.length > 200) bad('Password is too long');
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
  const first = userCount() === 0;
  if (!first && !inviteMatches(body.invite)) throw new HttpError(403, 'That invite key isn’t valid. Ask the admin for the current one.');
  const salt = crypto.randomBytes(16).toString('hex');
  const { lastInsertRowid } = q('INSERT INTO users (username, pass_hash, salt, hours_per_unlock, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, hashPassword(password, salt), salt, DEFAULT_HOURS, first ? 1 : 0, Date.now());
  if (first) getInviteKey();
  startSession(req, res, Number(lastInsertRowid));
  return { ok: true };
});

route('POST', '/api/login', false, (req, res, body) => {
  rateLimit(req, 'login');
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const u = q('SELECT id, pass_hash, salt FROM users WHERE username = ?').get(username);
  const hash = hashPassword(password, u ? u.salt : 'no-user-salt');
  if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.pass_hash, 'hex'))) {
    throw new HttpError(401, 'Wrong username or password');
  }
  startSession(req, res, u.id);
  return { ok: true };
});

route('POST', '/api/logout', false, (req, res) => {
  const token = parseCookies(req).bored_sid;
  if (token) q('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return { ok: true };
});

route('GET', '/api/state', true, (req, res, body, user) => buildState(user));

route('POST', '/api/items', true, (req, res, body, user) => {
  const name = str(body.name, 'Name', 1, 60);
  const kind = KINDS.includes(body.kind) ? body.kind : 'hobby';
  const count = q('SELECT COUNT(*) AS n FROM items WHERE user_id = ?').get(user.id).n;
  if (count >= 200) bad('You can have up to 200 things');
  q('INSERT INTO items (user_id, name, kind, created_at) VALUES (?, ?, ?, ?)').run(user.id, name, kind, Date.now());
  return buildState(user);
});

route('PATCH', '/api/items/:id', true, (req, res, body, user, p) => {
  const item = ownItem(user, p.id);
  const name = body.name !== undefined ? str(body.name, 'Name', 1, 60) : item.name;
  const kind = KINDS.includes(body.kind) ? body.kind : item.kind;
  const archived = body.archived !== undefined ? (body.archived ? 1 : 0) : item.archived;
  q('UPDATE items SET name = ?, kind = ?, archived = ? WHERE id = ?').run(name, kind, archived, item.id);
  if (archived) q('DELETE FROM timers WHERE user_id = ? AND item_id = ?').run(user.id, item.id);
  return buildState(user);
});

route('DELETE', '/api/items/:id', true, (req, res, body, user, p) => {
  const item = ownItem(user, p.id);
  q('DELETE FROM items WHERE id = ?').run(item.id);
  return buildState(user);
});

route('POST', '/api/timer/start', true, (req, res, body, user) => {
  const item = ownItem(user, body.itemId);
  if (q('SELECT 1 FROM timers WHERE user_id = ?').get(user.id)) bad('A timer is already running. Stop it first.');
  q('INSERT INTO timers (user_id, item_id, started_at) VALUES (?, ?, ?)').run(user.id, item.id, Date.now());
  return buildState(user);
});

route('POST', '/api/timer/stop', true, (req, res, body, user) => {
  const t = q('SELECT * FROM timers WHERE user_id = ?').get(user.id);
  if (!t) bad('No timer is running');
  const now = Date.now();
  const elapsed = Math.round((now - t.started_at) / 60000);
  let minutes = Math.min(elapsed, 24 * 60);
  if (body.minutes !== undefined) minutes = Math.min(int(body.minutes, 'Minutes', 0, 24 * 60), Math.max(elapsed, 1));
  const before = buildState(user).bank.unlocks;
  tx(() => {
    q('DELETE FROM timers WHERE user_id = ?').run(user.id);
    if (minutes >= 1) addLog(user, t.item_id, minutes, now, 'timer');
  });
  const state = buildState(user);
  return { ...state, logged: minutes, newUnlocks: state.bank.unlocks - before };
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
    if (!Number.isFinite(d) || d < Date.now() - 5 * 365 * 86400_000) bad('That date is not valid');
    if (d > Date.now() + 86400_000) bad('You can’t log time in the future');
    endedAt = Math.min(d, Date.now());
  }
  const before = buildState(user).bank.unlocks;
  addLog(user, item.id, minutes, endedAt, 'manual');
  const state = buildState(user);
  return { ...state, logged: minutes, newUnlocks: state.bank.unlocks - before };
});

route('DELETE', '/api/logs/:id', true, (req, res, body, user, p) => {
  const r = q('DELETE FROM time_logs WHERE id = ? AND user_id = ?').run(Number(p.id), user.id);
  if (!r.changes) throw new HttpError(404, 'That entry no longer exists');
  return buildState(user);
});

route('POST', '/api/wishes', true, (req, res, body, user) => {
  const name = str(body.name, 'Name', 1, 80);
  let price = null;
  if (body.price !== undefined && body.price !== null && body.price !== '') {
    price = Number(body.price);
    if (!Number.isFinite(price) || price < 0 || price > 1e7) bad('Price must be a positive number');
    price = Math.round(price * 100) / 100;
  }
  q('INSERT INTO wishes (user_id, name, price, created_at) VALUES (?, ?, ?, ?)').run(user.id, name, price, Date.now());
  return buildState(user);
});

route('DELETE', '/api/wishes/:id', true, (req, res, body, user, p) => {
  q('DELETE FROM wishes WHERE id = ? AND user_id = ?').run(Number(p.id), user.id);
  return buildState(user);
});

route('POST', '/api/purchases', true, (req, res, body, user) => {
  const state = buildState(user);
  if (state.bank.unlocks < 1) bad(`Not unlocked yet. Log ${fmtH(state.bank.costMinutes - state.bank.progressMinutes)} more first.`);
  let name; let wishId = null;
  if (body.wishId !== undefined) {
    const w = q('SELECT * FROM wishes WHERE id = ? AND user_id = ?').get(Number(body.wishId), user.id);
    if (!w) throw new HttpError(404, 'That wish no longer exists');
    if (w.bought_at) bad('You already bought that');
    name = w.name; wishId = w.id;
  } else {
    name = str(body.name, 'Name', 1, 80);
  }
  const now = Date.now();
  tx(() => {
    q('INSERT INTO purchases (user_id, name, cost_minutes, wish_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, name, state.bank.costMinutes, wishId, now);
    if (wishId) q('UPDATE wishes SET bought_at = ? WHERE id = ?').run(now, wishId);
  });
  return buildState(user);
});

route('DELETE', '/api/purchases/:id', true, (req, res, body, user, p) => {
  const pur = q('SELECT * FROM purchases WHERE id = ? AND user_id = ?').get(Number(p.id), user.id);
  if (!pur) throw new HttpError(404, 'That purchase no longer exists');
  tx(() => {
    q('DELETE FROM purchases WHERE id = ?').run(pur.id);
    if (pur.wish_id) q('UPDATE wishes SET bought_at = NULL WHERE id = ?').run(pur.wish_id);
  });
  return buildState(user);
});

route('PATCH', '/api/settings', true, (req, res, body, user) => {
  if (body.hoursPerUnlock !== undefined) {
    const h = Number(body.hoursPerUnlock);
    if (!Number.isFinite(h) || h < 1 || h > 500) bad('Hours per unlock must be between 1 and 500');
    q('UPDATE users SET hours_per_unlock = ? WHERE id = ?').run(Math.round(h * 4) / 4, user.id);
  }
  return buildState(currentUser(req));
});

route('POST', '/api/password', true, (req, res, body, user) => {
  rateLimit(req, 'password');
  const u = q('SELECT pass_hash, salt FROM users WHERE id = ?').get(user.id);
  const cur = hashPassword(String(body.current || ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(cur, 'hex'), Buffer.from(u.pass_hash, 'hex'))) throw new HttpError(401, 'Current password is wrong');
  const next = String(body.next || '');
  if (next.length < 8 || next.length > 200) bad('New password needs at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  tx(() => {
    q('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(next, salt), salt, user.id);
    q('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
  });
  startSession(req, res, user.id);
  return { ok: true };
});

route('POST', '/api/admin/invite', true, (req, res, body, user) => {
  if (!user.is_admin) throw new HttpError(403, 'Only the admin can do that');
  regenInviteKey();
  return buildState(user);
});

route('POST', '/api/account/delete', true, (req, res, body, user) => {
  if (user.is_admin) bad('The admin account can’t be deleted, because it holds the invite key.');
  rateLimit(req, 'password');
  const u = q('SELECT pass_hash, salt FROM users WHERE id = ?').get(user.id);
  const cur = hashPassword(String(body.password || ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(cur, 'hex'), Buffer.from(u.pass_hash, 'hex'))) throw new HttpError(401, 'Password is wrong');
  q('DELETE FROM users WHERE id = ?').run(user.id);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return { ok: true };
});

route('GET', '/api/export', true, (req, res, body, user) => {
  res.setHeader('Content-Disposition', 'attachment; filename="bored-export.json"');
  return {
    exportedAt: new Date().toISOString(),
    ...buildState(user),
    logs: q('SELECT l.*, i.name AS item_name FROM time_logs l JOIN items i ON i.id = l.item_id WHERE l.user_id = ? ORDER BY ended_at').all(user.id),
  };
});

function fmtH(min) { const h = min / 60; return (Math.round(h * 10) / 10) + ' h'; }

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.png' || ext === '.svg' || ext === '.woff2' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  if (pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }

  try {
    const r = routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!r) throw new HttpError(404, 'Not found');
    // CSRF guard: state-changing requests must be JSON (cross-site forms can't send that without CORS).
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Send JSON');
    }
    const m = pathname.match(r.re);
    const params = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    let user = null;
    if (r.auth) {
      user = currentUser(req);
      if (!user) throw new HttpError(401, 'Sign in to continue');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler(req, res, body, user, params);
    send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something broke on the server. Try again.' });
  }
});

// Housekeeping: drop expired sessions daily.
setInterval(() => q('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now()), 86400_000).unref();
q('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());

server.listen(PORT, () => console.log(`bored? ${process.env.APP_VERSION || 'dev'} listening on :${PORT} (data in ${DATA_DIR}, ${DEFAULT_HOURS} h per unlock)`));
const shutdown = () => { server.close(); db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
