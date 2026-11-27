'use strict';
// Attack tests for bored?. Starts a throwaway server and tries to break in.
// Run: node test/security.js   (CI runs this before every build)

const { spawn } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const PORT = 3900 + Math.floor(Math.random() * 90);
let DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bored-test-'));
const ROOT = path.join(__dirname, '..');
const EXTERNAL = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
const externalIsTrusted = !EXTERNAL || /^172\.(1[6-9]|2\d|3[01])\./.test(EXTERNAL);
const STRONG = 'cactus-lamp-tuesday-river-' + crypto.randomBytes(3).toString('hex');
const STRONG2 = 'orbit-mango-velvet-anchor-' + crypto.randomBytes(3).toString('hex');

let server;
function start(env = {}) {
  server = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', '--disallow-code-generation-from-strings', 'server.js'],
    { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, PWNED_CHECK: 'false', TRUST_PROXY: 'auto', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(d); });
  server.stderr.on('data', (d) => process.stderr.write(d));
  return waitUp();
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await req('GET', '/healthz')).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}
function stop() { return new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); }); }

// Each test step acts as a different visitor arriving through Cloudflare (which sends
// cf-connecting-ip), so per-IP limits from one step don't spill into the next.
let visitor = 1;
function req(method, p, { body, cookie, headers = {}, host = '127.0.0.1', raw } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host === '127.0.0.1' && !h['cf-connecting-ip']) h['cf-connecting-ip'] = `10.9.${visitor >> 8}.${visitor & 255}`;
    if (cookie) h.cookie = cookie;
    let data = raw;
    if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = h['content-type'] || 'application/json'; }
    if (data !== undefined) h['content-length'] = Buffer.byteLength(data);
    const r = http.request({ host, port: PORT, method, path: p, headers: h }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const setCookie = res.headers['set-cookie'] || [];
        const pairs = setCookie.map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c));
        const sid = pairs.find((c) => /bored_sid=./.test(c));
        const dev = pairs.find((c) => /bored_dev=./.test(c));
        resolve({ status: res.statusCode, headers: res.headers, text: buf, json, cookie: sid, device: dev, setCookie });
      });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}
const post = (p, body, opts = {}) => req('POST', p, { body, ...opts });

let passed = 0, skipped = 0;
async function check(name, fn) {
  visitor++;
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); process.exitCode = 1; }
}
const skip = (name, why) => { skipped++; console.log(`  --  ${name} (skipped: ${why})`); };

(async () => {
  // Seed a legacy-format account before first start, to test hash upgrades.
  {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'bored.db'));
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
             salt TEXT NOT NULL, hours_per_unlock REAL NOT NULL DEFAULT 20, created_at INTEGER NOT NULL)`);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('old-password-1', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)').run('legacy', hash, salt, Date.now());
    db.close();
  }
  await start();
  console.log(`bored? security tests (port ${PORT})`);
  let admin;

  console.log('\nCrash resistance');
  await check('malformed URL encoding does not crash the server', async () => {
    for (const p of ['/%E0%A4%A', '/%', '/api/%ZZ', '/%c0%ae%c0%ae/server.js']) await req('GET', p);
    assert.equal((await req('GET', '/healthz')).status, 200);
  });
  await check('malformed cookies are ignored', async () => {
    const r = await req('GET', '/api/state', { cookie: 'bored_sid=%E0%A4%A; x=%' });
    assert.equal(r.status, 401);
  });
  await check('oversized and broken bodies are rejected', async () => {
    assert.equal((await req('POST', '/api/login', { raw: 'x'.repeat(40_000), headers: { 'content-type': 'application/json' } })).status, 413);
    assert.equal((await req('POST', '/api/login', { raw: '{not json', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await req('GET', '/healthz')).status, 200);
  });

  console.log('\nFiles & headers');
  await check('path traversal cannot read server files', async () => {
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/fonts/../../server.js', '/server.js', '/package.json', '/pi/setup.sh']) {
      const r = await req('GET', p);
      assert.ok(!r.text.includes('require('), `${p} leaked source`);
      assert.ok(!r.text.includes('"scripts"'), `${p} leaked package.json`);
    }
  });
  await check('security headers are set', async () => {
    const r = await req('GET', '/');
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.ok(r.headers['permissions-policy']);
  });
  await check('the page asks for this version’s scripts, so updates aren’t stuck in a cache', async () => {
    const html = (await req('GET', '/')).text;
    for (const f of ['/app.js', '/i18n.js', '/style.css']) assert.match(html, new RegExp(`"${f.replace('.', '\\.')}\\?v=[\\w%-]+"`), `${f} has no version`);
    const js = await req('GET', html.match(/"(\/app\.js\?v=[^"]+)"/)[1]);
    assert.equal(js.status, 200);
    assert.match(js.text, /renderAuth/);
  });
  await check('API responses are never cached', async () => {
    assert.equal((await req('GET', '/api/config')).headers['cache-control'], 'no-store');
  });

  console.log('\nSign-up');
  await check('the oldest account becomes the admin', async () => {
    // a legacy account exists from before admins existed: it becomes the admin
    const r = await post('/api/login', { username: 'legacy', password: 'old-password-1' });
    assert.equal(r.status, 200, r.text);
    admin = r.cookie;
    const st = await req('GET', '/api/state', { cookie: admin });
    assert.equal(st.json.user.isAdmin, true);
    assert.equal((await req('GET', '/api/config')).json.firstUser, false);
  });
  await check('old password hashes are upgraded on login', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'bored.db'), { readOnly: true });
    const row = db.prepare("SELECT pass_hash, salt FROM users WHERE username = 'legacy'").get();
    db.close();
    assert.match(row.pass_hash, /^scrypt\$32768\$8\$3\$/);
    assert.equal(row.salt, '');
    assert.equal((await post('/api/login', { username: 'legacy', password: 'old-password-1' })).status, 200);
  });
  await check('invite keys are gone: no key in state, no route to make one', async () => {
    const st = await req('GET', '/api/state', { cookie: admin });
    assert.equal(st.json.user.inviteKey, undefined);
    assert.equal((await post('/api/admin/invite', {}, { cookie: admin })).status, 404);
  });
  await check('taken usernames are refused, whatever the case', async () => {
    for (const username of ['legacy', 'LEGACY']) {
      const r = await post('/api/register', { username, password: STRONG });
      assert.equal(r.status, 409, `${username} gave ${r.status}`);
    }
  });
  await check('odd usernames are refused', async () => {
    for (const username of ['ab', 'x'.repeat(33), 'bad name', '<script>', 'émile', '../admin', '']) {
      assert.equal((await post('/api/register', { username, password: STRONG })).status, 400, `“${username}” was accepted`);
    }
  });
  await check('weak passwords are refused', async () => {
    for (const pw of ['short', 'password123', 'aaaaaaaaaaaa', 'abababababab', 'bob-the-builder-xyz', 'Password123']) {
      const r = await post('/api/register', { username: 'bob-the-builder', password: pw });
      assert.equal(r.status, 400, `"${pw}" was accepted`);
    }
  });
  let bob;
  await check('anyone can sign up with a strong password, as a normal user', async () => {
    // an old client might still send an invite field: it's ignored
    const r = await post('/api/register', { username: 'bob', password: STRONG, invite: 'old-key' });
    assert.equal(r.status, 200, r.text);
    bob = r.cookie;
    const st = await req('GET', '/api/state', { cookie: bob });
    assert.equal(st.json.user.isAdmin, false);
    assert.equal(st.json.user.userCount, undefined, 'non-admin can see the account count');
  });
  await check('new hashes use OWASP scrypt settings and unique salts', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'bored.db'), { readOnly: true });
    const rows = db.prepare('SELECT pass_hash FROM users').all();
    db.close();
    for (const r of rows) assert.match(r.pass_hash, /^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    assert.ok(!rows.some((r) => r.pass_hash.includes(STRONG)));
  });

  console.log('\nLogin & brute force');
  await check('session cookie is HttpOnly and SameSite', async () => {
    const r = await post('/api/login', { username: 'bob', password: STRONG });
    const c = r.setCookie.join(' ');
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.doesNotMatch(c, /SameSite=Lax/);
  });
  await check('behind HTTPS proxy the cookie is Secure with __Host- prefix, plus HSTS', async () => {
    const r = await post('/api/login', { username: 'bob', password: STRONG }, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(r.setCookie[0], /^__Host-bored_sid=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    assert.ok(r.headers['strict-transport-security']);
  });
  await check('wrong password and unknown user give the same answer', async () => {
    const a = await post('/api/login', { username: 'bob', password: 'nope-nope-nope' });
    const b = await post('/api/login', { username: 'nobody-here', password: 'nope-nope-nope' });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
  });
  await check('an account locks after 5 wrong passwords, even for the right password', async () => {
    for (let i = 0; i < 4; i++) await post('/api/login', { username: 'bob', password: `wrong-${i}-wrong` });
    const locked = await post('/api/login', { username: 'bob', password: STRONG });
    assert.equal(locked.status, 429, `got ${locked.status}`);
  });
  await check('unknown usernames lock the same way (no account probing)', async () => {
    for (let i = 0; i < 4; i++) await post('/api/login', { username: 'nobody-here', password: `wrong-${i}-wrong` });
    assert.equal((await post('/api/login', { username: 'nobody-here', password: 'x' })).status, 429);
  });
  if (externalIsTrusted) skip('spoofed IP headers from the network are ignored', `test host address ${EXTERNAL} is in the proxy range`);
  else {
    await check('spoofed IP headers from the network are ignored', async () => {
      let limited = false;
      for (let i = 0; i < 24; i++) {
        const r = await post('/api/login', { username: `probe${i}`, password: 'x-x-x-x-x-x' },
          { host: EXTERNAL, headers: { 'cf-connecting-ip': `203.0.113.${i}`, 'x-forwarded-for': `198.51.100.${i}` } });
        if (r.status === 429) limited = true;
      }
      assert.ok(limited, 'rotating fake IP headers bypassed the per-IP limit');
    });
    await check('spoofed HTTPS header from the network does not change cookies', async () => {
      const r = await post('/api/login', { username: 'nobody2', password: 'x' }, { host: EXTERNAL, headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(r.headers['strict-transport-security'], undefined);
    });
  }

  console.log('\nAttacks found in the pen test (regression checks)');
  await check('parallel guesses can’t get past the lock', async () => {
    await post('/api/register', { username: 'pat', password: STRONG });
    const tries = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      post('/api/login', { username: 'pat', password: `parallel-${i}-guess` }, { headers: { 'cf-connecting-ip': `198.18.${i}.1` } })));
    const checked = tries.filter((t) => t.status === 401).length;
    assert.ok(checked <= 5, `${checked} parallel guesses were checked`);
  });
  await check('strangers guessing wrong can’t lock the owner out of their own device', async () => {
    const reg = await post('/api/register', { username: 'dana', password: STRONG });
    const myDevice = reg.device;
    assert.ok(myDevice, 'no known-device cookie was set');
    for (let i = 0; i < 6; i++) await post('/api/login', { username: 'dana', password: `attacker-${i}-guess` }, { headers: { 'cf-connecting-ip': `198.19.${i}.1` } });
    assert.equal((await post('/api/login', { username: 'dana', password: STRONG })).status, 429, 'unknown device should be locked');
    const mine = await post('/api/login', { username: 'dana', password: STRONG }, { cookie: myDevice });
    assert.equal(mine.status, 200, `owner on known device got ${mine.status}`);
  });
  await check('a known-device cookie only works for its own account', async () => {
    const other = (await post('/api/register', { username: 'eve', password: STRONG2 })).device;
    for (let i = 0; i < 6; i++) await post('/api/login', { username: 'dana', password: `x-${i}-guess-x` }, { headers: { 'cf-connecting-ip': `198.20.${i}.1` } });
    assert.equal((await post('/api/login', { username: 'dana', password: STRONG }, { cookie: other })).status, 429);
  });
  await check('locks survive a restart (and can’t be flushed by floods)', async () => {
    assert.equal((await post('/api/login', { username: 'dana', password: STRONG })).status, 429);
    await stop(); await start();
    assert.equal((await post('/api/login', { username: 'dana', password: STRONG })).status, 429);
  });
  await check('rotating IPv6 addresses within one /64 doesn’t escape the per-IP limit', async () => {
    let blocked = 0;
    for (let i = 1; i <= 25; i++) {
      const r = await post('/api/login', { username: `v6probe${i}`, password: 'x-x-x-x-x' }, { headers: { 'cf-connecting-ip': `2001:db8:abcd:12::${i.toString(16)}` } });
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked >= 5, `only ${blocked} of 25 blocked`);
  });
  await check('a reset code can’t be used twice, even at the same moment', async () => {
    const users = (await req('GET', '/api/admin/users', { cookie: admin })).json.users;
    const patId = users.find((u) => u.username === 'pat').id;
    const { code } = (await post(`/api/admin/users/${patId}/reset`, {}, { cookie: admin })).json;
    const res = await Promise.all(['one-two-three-four-a', 'five-six-seven-eight-b'].map((pw, i) =>
      post('/api/reset-password', { username: 'pat', code, password: pw }, { headers: { 'cf-connecting-ip': `198.21.${i}.1` } })));
    assert.equal(res.filter((r) => r.status === 200).length, 1, res.map((r) => r.status).join(','));
  });

  console.log('\nCross-site requests');
  await check('form-style (non-JSON) requests are refused', async () => {
    const r = await req('POST', '/api/items', { cookie: bob, raw: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
  });
  await check('requests from another site are refused', async () => {
    const r = await post('/api/items', { name: 'csrf' }, { cookie: bob, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403);
    const r2 = await post('/api/items', { name: 'ok' }, { cookie: bob, headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(r2.status, 200);
  });

  console.log('\nAccess control');
  let adminItemId;
  await check('users cannot see or change each other’s data', async () => {
    const a = await post('/api/items', { name: 'admin secret' }, { cookie: admin });
    adminItemId = a.json.items.find((i) => i.name === 'admin secret').id;
    const st = await req('GET', '/api/state', { cookie: bob });
    assert.ok(!st.text.includes('admin secret'));
    assert.equal((await req('PATCH', `/api/items/${adminItemId}`, { cookie: bob, body: { name: 'pwned' } })).status, 404);
    assert.equal((await req('DELETE', `/api/items/${adminItemId}`, { cookie: bob, body: {} })).status, 404);
    assert.equal((await post('/api/logs', { itemId: adminItemId, minutes: 60 }, { cookie: bob })).status, 404);
    assert.equal((await post('/api/timer/start', { itemId: adminItemId }, { cookie: bob })).status, 404);
  });
  await check('non-admins cannot use admin features', async () => {
    assert.equal((await req('GET', '/api/admin/users', { cookie: bob })).status, 403);
    assert.equal((await req('GET', '/api/admin/stats', { cookie: bob })).status, 403);
    assert.equal((await req('GET', '/api/admin/stats')).status, 401);
    assert.equal((await post('/api/admin/users/1/reset', {}, { cookie: bob })).status, 403);
    assert.equal((await post('/api/admin/users/1/delete', {}, { cookie: bob })).status, 403);
  });
  await check('not signed in means no access', async () => {
    for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/export'], ['GET', '/api/sessions'], ['POST', '/api/items']]) {
      assert.equal((await req(m, p, m === 'POST' ? { body: {} } : {})).status, 401, `${m} ${p}`);
    }
    assert.equal((await req('GET', '/api/state', { cookie: 'bored_sid=' + 'A'.repeat(43) })).status, 401);
  });

  console.log('\nInput handling');
  await check('hidden control characters are stripped from names', async () => {
    const r = await post('/api/items', { name: 'evil‮txt.exe\u0000​' }, { cookie: bob });
    assert.ok(r.json.items.some((i) => i.name === 'eviltxt.exe'));
  });
  await check('HTML in names is stored as text, served as JSON', async () => {
    const r = await post('/api/items', { name: '<img src=x onerror=alert(1)>' }, { cookie: bob });
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
  await check('nonsense numbers are refused', async () => {
    const st = await req('GET', '/api/state', { cookie: bob });
    const itemId = st.json.items[0].id;
    for (const minutes of [-5, 0, 1e9, 'abc', 1.5, null]) {
      assert.equal((await post('/api/logs', { itemId, minutes }, { cookie: bob })).status, 400, `minutes=${minutes}`);
    }
    assert.equal((await post('/api/purchases', { name: 'free stuff' }, { cookie: bob })).status, 400, 'bought without an unlock');
  });

  console.log('\nSessions & passwords');
  await check('signing out other devices revokes them', async () => {
    const phone = (await post('/api/login', { username: 'legacy', password: 'old-password-1' })).cookie;
    assert.equal((await req('GET', '/api/state', { cookie: phone })).status, 200);
    const s = await req('GET', '/api/sessions', { cookie: admin });
    assert.ok(s.json.sessions.length >= 2);
    await post('/api/sessions/revoke', { others: true }, { cookie: admin });
    assert.equal((await req('GET', '/api/state', { cookie: phone })).status, 401);
    assert.equal((await req('GET', '/api/state', { cookie: admin })).status, 200);
  });
  await check('signing out kills the session on the server', async () => {
    const c = (await post('/api/login', { username: 'legacy', password: 'old-password-1' })).cookie;
    await post('/api/logout', {}, { cookie: c });
    assert.equal((await req('GET', '/api/state', { cookie: c })).status, 401);
  });
  let carol;
  await check('changing password needs the current one and signs out other devices', async () => {
    carol = (await post('/api/register', { username: 'carol', password: STRONG })).cookie;
    const other = (await post('/api/login', { username: 'carol', password: STRONG })).cookie;
    assert.equal((await post('/api/password', { current: 'wrong-wrong', next: STRONG2 }, { cookie: carol })).status, 401);
    const r = await post('/api/password', { current: STRONG, next: STRONG2 }, { cookie: carol });
    assert.equal(r.status, 200, r.text);
    carol = r.cookie;
    assert.equal((await req('GET', '/api/state', { cookie: other })).status, 401);
    assert.equal((await post('/api/login', { username: 'carol', password: STRONG2 })).status, 200);
  });
  await check('admin reset code works once, then never again', async () => {
    const users = (await req('GET', '/api/admin/users', { cookie: admin })).json.users;
    const carolId = users.find((u) => u.username === 'carol').id;
    const { code } = (await post(`/api/admin/users/${carolId}/reset`, {}, { cookie: admin })).json;
    assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal((await post('/api/reset-password', { username: 'legacy', code, password: 'new-pass-word-zz' })).status, 401, 'code worked for another user');
    const NEW = 'river-stone-cloud-' + crypto.randomBytes(2).toString('hex');
    const r = await post('/api/reset-password', { username: 'carol', code: code.toUpperCase(), password: NEW });
    assert.equal(r.status, 200, r.text);
    assert.equal((await req('GET', '/api/state', { cookie: carol })).status, 401, 'old sessions survived the reset');
    assert.equal((await post('/api/reset-password', { username: 'carol', code, password: NEW + 'x' })).status, 401, 'code worked twice');
    assert.equal((await post('/api/login', { username: 'carol', password: NEW })).status, 200);
  });
  await check('site stats: totals and counts only, never who', async () => {
    await req('GET', '/'); await req('GET', '/stats-page-that-is-really-the-app');
    const r = await req('GET', '/api/admin/stats?days=7', { cookie: admin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.days, 7);
    assert.equal(r.json.daily.length, 7);
    assert.ok(r.json.totals.accounts >= 3);
    assert.ok(r.json.period.page_views >= 2, 'page views not counted');
    assert.ok(r.json.period.signins >= 1, 'sign-ins not counted');
    assert.ok(r.json.period.signins_failed >= 1, 'failed sign-ins not counted');
    assert.ok(r.json.daily.at(-1).active >= 1, 'active people not counted');
    for (const name of ['bob', 'legacy', 'carol', 'mallory']) assert.ok(!r.text.includes(name), `stats mention ${name}`);
    assert.equal((await req('GET', '/api/admin/stats?days=99999', { cookie: admin })).json.days, 30);
    assert.equal((await req('GET', "/api/admin/stats?days=7'--", { cookie: admin })).json.days, 30);
  });
  await check('the admin account cannot be deleted', async () => {
    assert.equal((await post('/api/account/delete', { password: 'old-password-1' }, { cookie: admin })).status, 400);
  });

  console.log('\nFriends & points');
  let f1, f2, f3;
  await check('friends: requests, acceptance and privacy', async () => {
    f1 = (await post('/api/register', { username: 'fiona', password: STRONG })).cookie;
    f2 = (await post('/api/register', { username: 'gus', password: STRONG })).cookie;
    f3 = (await post('/api/register', { username: 'hana', password: STRONG })).cookie;
    assert.equal((await post('/api/friends/request', { username: 'fiona' }, { cookie: f1 })).status, 400, 'friended yourself');
    assert.equal((await post('/api/friends/request', { username: 'nobody-at-all' }, { cookie: f1 })).status, 404);
    assert.equal((await post('/api/friends/accept', { username: 'gus' }, { cookie: f1 })).status, 404, 'accepted a request that was never sent');
    assert.equal((await post('/api/friends/request', { username: 'gus' }, { cookie: f1 })).status, 200);
    // before gus accepts, fiona still can't see him
    let v = (await req('GET', '/api/friends', { cookie: f1 })).json;
    assert.deepEqual(v.board.week.map((e) => e.username), ['fiona']);
    assert.equal((await post('/api/friends/accept', { username: 'fiona' }, { cookie: f2 })).status, 200);
    v = (await req('GET', '/api/friends', { cookie: f1 })).json;
    assert.deepEqual(v.board.week.map((e) => e.username).sort(), ['fiona', 'gus']);
    // hana isn't anyone's friend: she sees only herself, and nobody sees her
    v = (await req('GET', '/api/friends', { cookie: f3 })).json;
    assert.deepEqual(v.board.all.map((e) => e.username), ['hana']);
    assert.ok(!JSON.stringify((await req('GET', '/api/friends', { cookie: f1 })).json).includes('hana'));
  });
  await check('friends only see points, hours and streak, never items or wishlist', async () => {
    const st = await post('/api/items', { name: 'secret-hobby-xyz' }, { cookie: f2 });
    await post('/api/logs', { itemId: st.json.items[0].id, minutes: 30 }, { cookie: f2 });
    await post('/api/wishes', { name: 'secret-wish-xyz' }, { cookie: f2 });
    const v = (await req('GET', '/api/friends', { cookie: f1 })).json;
    const gus = v.board.week.find((e) => e.username === 'gus');
    assert.deepEqual(Object.keys(gus).sort(), ['minutes', 'points', 'rank', 'streak', 'username', 'you']);
    assert.ok(gus.points > 0);
    assert.ok(!JSON.stringify(v).includes('secret'));
  });
  await check('asking someone who already asked you makes you friends', async () => {
    await post('/api/friends/request', { username: 'hana' }, { cookie: f1 });
    const r = await post('/api/friends/request', { username: 'fiona' }, { cookie: f3 });
    assert.equal(r.json.accepted, 'fiona');
    assert.equal((await post('/api/friends/request', { username: 'fiona' }, { cookie: f3 })).status, 409);
  });
  await check('removing a friend hides you from each other again', async () => {
    await post('/api/friends/remove', { username: 'hana' }, { cookie: f1 });
    assert.ok(!JSON.stringify((await req('GET', '/api/friends', { cookie: f3 })).json.board).includes('fiona'));
  });
  await check('points can’t be set by the client or farmed with old time', async () => {
    const st = await post('/api/items', { name: 'farm' }, { cookie: f3 });
    const itemId = st.json.items.find((i) => i.name === 'farm').id;
    const r = await post('/api/logs', { itemId, minutes: 60, points: 999999, multiplier: 50, endedAt: Date.now() - 3 * 86400_000 }, { cookie: f3 });
    assert.equal(r.json.earned.points, 0, 'old time earned points');
    const r2 = await post('/api/logs', { itemId, minutes: 60, points: 999999 }, { cookie: f3 });
    assert.ok(r2.json.earned.points <= 60 * 10 * 1.2, `got ${r2.json.earned.points}`);
    for (let i = 0; i < 3; i++) await post('/api/logs', { itemId, minutes: 24 * 60 }, { cookie: f3 });
    assert.equal(r2.json.score.today <= 8 * 60 * 10 * 4, true);
    const sum = (await req('GET', '/api/state', { cookie: f3 })).json.score.today;
    assert.ok(sum <= 8 * 60 * 10 * 2.6, `daily cap broken: ${sum}`);
  });
  await check('the wheel bonus only applies to a real timer started from a spin', async () => {
    const st = await post('/api/items', { name: 'wheel' }, { cookie: f3 });
    const itemId = st.json.items.find((i) => i.name === 'wheel').id;
    const r = await post('/api/logs', { itemId, minutes: 30, fromSpin: true }, { cookie: f3 });
    assert.ok(!r.json.earned.bonuses.some((b) => b.key === 'wheel'));
    await post('/api/timer/start', { itemId, fromSpin: 'yes' }, { cookie: f3 });
    const t = (await req('GET', '/api/state', { cookie: f3 })).json.timer;
    assert.equal(t.from_spin, 0, 'non-boolean fromSpin accepted');
    await post('/api/timer/cancel', {}, { cookie: f3 });
  });

  console.log('\nChecklists, high-fives, achievements, recap');
  await check('nobody can read or change someone else’s project steps', async () => {
    const st = await post('/api/items', { name: 'Shed', kind: 'project' }, { cookie: f1 });
    const itemId = st.json.items.find((i) => i.name === 'Shed').id;
    const r = await post(`/api/items/${itemId}/steps`, { text: 'Buy wood' }, { cookie: f1 });
    const stepId = r.json.steps[0].id;
    assert.equal((await req('GET', `/api/items/${itemId}/steps`, { cookie: f2 })).status, 404);
    assert.equal((await post(`/api/items/${itemId}/steps`, { text: 'pwned' }, { cookie: f2 })).status, 404);
    assert.equal((await req('PATCH', `/api/steps/${stepId}`, { cookie: f2, body: { done: true, text: 'pwned' } })).status, 404);
    assert.equal((await req('DELETE', `/api/steps/${stepId}`, { cookie: f2, body: {} })).status, 404);
    const mine = await req('GET', `/api/items/${itemId}/steps`, { cookie: f1 });
    assert.deepEqual(mine.json.steps.map((x) => [x.text, x.done]), [['Buy wood', false]]);
  });
  await check('high-fives only for friends’ moments, never your own or strangers’', async () => {
    // fiona and gus are friends; hana isn't friends with either now. Give each a 7-day streak moment.
    {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(DATA, 'bored.db'));
      for (const u of ['fiona', 'gus']) {
        db.prepare("INSERT INTO score_events (user_id, kind, day, points, label, created_at) VALUES ((SELECT id FROM users WHERE username = ?), 'streak-7', 'test', 750, '7-day streak', ?)").run(u, Date.now());
      }
      db.close();
    }
    const ev = (await req('GET', '/api/friends', { cookie: f2 })).json.feed;
    const fionaMoment = ev.find((e) => e.username === 'fiona');
    const gusMoment = ev.find((e) => e.you);
    assert.ok(fionaMoment && gusMoment, 'moments missing from the feed');
    assert.equal(fionaMoment.text, 'hit a 7-day streak');
    assert.equal((await post('/api/high-five', { eventId: gusMoment.id }, { cookie: f2 })).status, 404, 'high-fived own moment');
    assert.equal((await post('/api/high-five', { eventId: fionaMoment.id }, { cookie: f3 })).status, 404, 'stranger high-fived');
    assert.equal((await post('/api/high-five', { eventId: fionaMoment.id }, { cookie: f2 })).status, 200);
    const again = await post('/api/high-five', { eventId: fionaMoment.id }, { cookie: f2 });
    assert.equal(again.json.feed.find((e) => e.id === fionaMoment.id).fives, 1, 'counted twice');
    const fiona = (await req('GET', '/api/state', { cookie: f1 })).json;
    assert.equal(fiona.highFives[0].from, 'gus');
    assert.ok(!JSON.stringify((await req('GET', '/api/friends', { cookie: f3 })).json.feed).includes('fiona'), 'stranger sees the feed');
    assert.equal((await post('/api/high-five', { eventId: 999999 }, { cookie: f2 })).status, 404);
  });
  await check('achievements and recap only ever show your own data', async () => {
    const a = await req('GET', '/api/achievements', { cookie: f3 });
    assert.equal(a.json.achievements.length, 50);
    const r = await req('GET', '/api/recap', { cookie: f3 });
    assert.ok(!JSON.stringify(r.json).includes('secret-hobby-xyz'));
    assert.equal((await req('GET', '/api/recap')).status, 401);
  });
  await check('quickly added and removed wishes don’t count as “resisted”', async () => {
    for (let i = 0; i < 5; i++) {
      const w = await post('/api/wishes', { name: `farm-${i}`, price: 1000 }, { cookie: f3 });
      await req('DELETE', `/api/wishes/${w.json.wishes.find((x) => x.name === `farm-${i}`).id}`, { cookie: f3, body: {} });
    }
    const a = (await req('GET', '/api/achievements', { cookie: f3 })).json.achievements;
    assert.equal(a.find((x) => x.key === 'changed-my-mind').unlockedAt, null);
    assert.equal(a.find((x) => x.key === 'savings-account').current, 0);
  });
  await check('spins are counted at most once every 2 seconds', async () => {
    for (let i = 0; i < 10; i++) await post('/api/spin', {}, { cookie: f3 });
    const a = (await req('GET', '/api/achievements', { cookie: f3 })).json.achievements;
    assert.equal(a.find((x) => x.key === 'spin-doctor').current, 1);
  });

  await check('what’s new lists released versions as plain JSON', async () => {
    const r = await req('GET', '/api/changelog');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.ok(r.json.versions.some((v) => v.version === '1.0.0' && v.groups.length));
    assert.equal(r.json.release, require('../package.json').version);
  });
  await check('what’s new comes in Dutch too, with the same versions', async () => {
    const en = (await req('GET', '/api/changelog?lang=en')).json, nl = (await req('GET', '/api/changelog?lang=nl')).json;
    assert.deepEqual(nl.versions.map((v) => v.version), en.versions.map((v) => v.version));
    assert.ok(nl.versions.find((v) => v.version === '1.0.0').intro.includes('officiële'));
    assert.deepEqual((await req('GET', '/api/changelog?lang=<script>')).json.versions, en.versions);
  });

  console.log('\n1.2: sessions, timers, snoozing, goals, nudges and challenges');
  let gItem;
  await check('editing a session: only your own, notes are limited, points are worked out again', async () => {
    const st = (await post('/api/items', { name: 'Bass' }, { cookie: f2 })).json;
    gItem = st.items.find((i) => i.name === 'Bass').id;
    const r = await post('/api/logs', { itemId: gItem, minutes: 30, endedAt: Date.now() - 86400000, note: 'scales' }, { cookie: f2 });
    assert.equal(r.status, 200, r.text);
    const log = r.json.logs.find((l) => l.item_id === gItem);
    assert.equal(log.note, 'scales');
    assert.equal((await req('PATCH', `/api/logs/${log.id}`, { body: { note: 'hacked' }, cookie: f1 })).status, 404, 'edited someone else’s session');
    assert.equal((await req('PATCH', `/api/logs/${log.id}`, { body: { note: 'x'.repeat(201) }, cookie: f2 })).status, 400);
    assert.equal((await req('PATCH', `/api/logs/${log.id}`, { body: { minutes: 0 }, cookie: f2 })).status, 400);
    assert.equal((await req('PATCH', `/api/logs/${log.id}`, { body: { minutes: 1441 }, cookie: f2 })).status, 400);
    assert.equal((await post('/api/logs', { itemId: gItem, minutes: 5, note: 'y'.repeat(201) }, { cookie: f2 })).status, 400);
    const e = await req('PATCH', `/api/logs/${log.id}`, { body: { minutes: 60, note: 'scales and a song' }, cookie: f2 });
    assert.equal(e.status, 200, e.text);
    const after = e.json.logs.find((l) => l.id === log.id);
    assert.equal(after.minutes, 60); assert.equal(after.note, 'scales and a song'); assert.equal(after.edited, 1);
    assert.ok(after.points > log.points, `points not worked out again (${log.points} → ${after.points})`);
  });
  await check('timers: paused time doesn’t count, and offline times can’t reach back more than 12 hours', async () => {
    let r = await post('/api/timer/start', { itemId: gItem, startedAt: Date.now() - 3 * 86400000 }, { cookie: f2 });
    assert.equal(r.status, 200, r.text);
    const t = r.json.timer;
    assert.ok(t.started_at >= Date.now() - 12 * 3600000 - 5000, 'timer backdated by days');
    assert.equal((await post('/api/timer/pause', {}, { cookie: f1 })).status, 400, 'paused a timer that isn’t yours');
    r = await post('/api/timer/pause', { at: t.started_at + 60000 }, { cookie: f2 });
    assert.ok(r.json.timer.paused_at > 0);
    r = await post('/api/timer/stop', { endedAt: Date.now() + 86400000 }, { cookie: f2 });
    assert.equal(r.json.logged, 1, `logged ${r.json.logged} minutes for a timer paused after 1`);
    r = await post('/api/timer/start', { itemId: gItem, startedAt: 'yesterday' }, { cookie: f2 });
    assert.equal(r.status, 400);
  });
  await check('snoozing: 0 to 30 days, your own things only', async () => {
    assert.equal((await req('PATCH', `/api/items/${gItem}`, { body: { snoozeDays: 31 }, cookie: f2 })).status, 400);
    assert.equal((await req('PATCH', `/api/items/${gItem}`, { body: { snoozeDays: 7 }, cookie: f1 })).status, 404);
    const r = await req('PATCH', `/api/items/${gItem}`, { body: { snoozeDays: 7 }, cookie: f2 });
    assert.ok(r.json.items.find((i) => i.id === gItem).snoozed_until > Date.now() + 6 * 86400000);
    const back = await req('PATCH', `/api/items/${gItem}`, { body: { snoozeDays: 0 }, cookie: f2 });
    assert.equal(back.json.items.find((i) => i.id === gItem).snoozed_until, 0);
  });
  await check('monthly goal: 0 to 300 hours', async () => {
    for (const v of [-1, 301, 'lots']) assert.equal((await req('PATCH', '/api/settings', { body: { monthlyGoalHours: v }, cookie: f2 })).status, 400, `goal ${v}`);
    const r = await req('PATCH', '/api/settings', { body: { monthlyGoalHours: 15 }, cookie: f2 });
    assert.equal(r.json.user.monthlyGoal, 900);
    assert.ok(r.json.score.monthMinutes >= 61);
  });
  await check('nudges: friends only, only when their streak is at risk, once a day', async () => {
    assert.equal((await post('/api/nudge', { username: 'gus' }, { cookie: f3 })).status, 403, 'nudged a stranger');
    assert.equal((await post('/api/nudge', { username: 'nobody-at-all' }, { cookie: f1 })).status, 404);
    // put gus's sessions from today on yesterday: his streak now needs today's minutes
    {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(DATA, 'bored.db')); db.exec('PRAGMA busy_timeout = 3000');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      db.prepare("UPDATE time_logs SET ended_at = ? WHERE ended_at >= ? AND user_id = (SELECT id FROM users WHERE username = 'gus')").run(today.getTime() - 3600000, today.getTime());
      db.close();
    }
    const g = (await req('GET', '/api/friends', { cookie: f1 })).json.board.week.find((e) => e.username === 'gus');
    assert.equal(g.atRisk, true, JSON.stringify(g));
    assert.equal((await post('/api/nudge', { username: 'gus' }, { cookie: f1 })).status, 200);
    assert.equal((await post('/api/nudge', { username: 'gus' }, { cookie: f1 })).status, 409);
    let st = (await req('GET', '/api/state', { cookie: f2 })).json;
    assert.deepEqual(st.nudges.map((n) => n.from), ['fiona']);
    await post('/api/nudges/seen', {}, { cookie: f2 });
    assert.equal((await req('GET', '/api/state', { cookie: f2 })).json.nudges.length, 0);
    assert.equal((await post('/api/nudge', { username: 'fiona' }, { cookie: f2 })).status, 400, 'nudged someone without a streak');
    assert.equal((await req('GET', '/api/state', { cookie: f1 })).json.nudges.length, 0);
  });
  await check('weekly challenge: just you and your friends, and last week’s winner gets 500 points once', async () => {
    const v = (await req('GET', '/api/friends', { cookie: f1 })).json;
    assert.ok(v.challenge && v.challenge.key);
    assert.deepEqual(v.challenge.standings.map((x) => x.username).sort(), ['fiona', 'gus']);
    assert.deepEqual((await req('GET', '/api/friends', { cookie: f3 })).json.challenge.standings.map((x) => x.username), ['hana']);
    // a session for gus last week that fits every kind of challenge
    const proj = (await post('/api/items', { name: 'Shed', kind: 'project' }, { cookie: f2 })).json.items.find((i) => i.name === 'Shed').id;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'bored.db'));
    db.exec('PRAGMA busy_timeout = 3000');
    const lastWeek = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 4); return d.getTime(); })();
    db.prepare(`INSERT INTO time_logs (user_id, item_id, minutes, ended_at, source, points, scored_minutes, multiplier, bonuses, created_at)
      SELECT id, ?, 120, ?, 'timer', 1000, 120, 1, '[{"key":"rediscovered","pct":50}]', ? FROM users WHERE username = 'gus'`).run(proj, lastWeek, lastWeek);
    db.close();
    await stop(); await start();   // the server only checks last week once per run
    await req('GET', '/api/state', { cookie: f2 }); await req('GET', '/api/state', { cookie: f2 });
    const gus = (await req('GET', '/api/friends', { cookie: f2 })).json;
    assert.equal(gus.challenge.wins, 1, 'challenge win missing or paid twice');
    assert.ok(gus.feed.some((e) => e.you && e.text === 'won the weekly challenge'));
    assert.equal((await req('GET', '/api/friends', { cookie: f1 })).json.challenge.wins, 0, 'fiona won with nothing');
  });
  await check('the offline helper is served from the site root and allowed by the security policy', async () => {
    const r = await req('GET', '/sw.js?v=test');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /javascript/);
    assert.match(r.headers['content-security-policy'], /worker-src 'self'/);
    assert.doesNotMatch(r.text, /\/api\/.*cache\.put/);
  });

  console.log('\nStorage');
  await check('database files are private to the app user', async () => {
    const mode = fs.statSync(path.join(DATA, 'bored.db')).mode & 0o777;
    // the db created by this test's seeding step predates the server; check a file the server created
    const wal = fs.statSync(path.join(DATA, 'bored.db-wal')).mode & 0o777;
    assert.equal(wal & 0o077, 0, `wal mode ${wal.toString(8)}`);
    assert.equal(mode & 0o077, 0, `db mode ${mode.toString(8)}`);
  });
  await check('server still healthy after everything', async () => {
    assert.equal((await req('GET', '/healthz')).status, 200);
  });

  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });

  // A fresh, empty site with a low daily cap on new accounts.
  console.log('\nPublic sign-up (fresh site, at most 2 new accounts a day)');
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bored-test-'));
  await start({ MAX_SIGNUPS_PER_DAY: '2' });
  await check('on an empty site the first sign-up becomes the admin', async () => {
    assert.equal((await req('GET', '/api/config')).json.firstUser, true);
    const r = await post('/api/register', { username: 'founder', password: STRONG });
    assert.equal(r.status, 200, r.text);
    assert.equal((await req('GET', '/api/state', { cookie: r.cookie })).json.user.isAdmin, true);
    assert.equal((await req('GET', '/api/config')).json.firstUser, false);
  });
  await check('everyone after that is a normal user', async () => {
    const r = await post('/api/register', { username: 'second', password: STRONG });
    assert.equal(r.status, 200, r.text);
    assert.equal((await req('GET', '/api/state', { cookie: r.cookie })).json.user.isAdmin, false);
  });
  await check('the daily cap pauses new sign-ups, but sign-in keeps working', async () => {
    const r = await post('/api/register', { username: 'third', password: STRONG });
    assert.equal(r.status, 503, r.text);
    assert.match(r.json.error, /paused/);
    assert.equal((await post('/api/login', { username: 'second', password: STRONG })).status, 200);
  });
  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped` : ''}${process.exitCode ? ', SOME FAILED' : ''}`);
})().catch(async (e) => { console.error(e); process.exitCode = 1; try { await stop(); } catch { /* already down */ } });
