'use strict';
// Checks the Dutch translation: every English text in app.js has a Dutch line, placeholders match,
// and every message the server can send (errors, bonus labels, feed lines, devices) comes out Dutch.
// Run: node test/i18n.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('public/app.js');
const server = read('server.js');
const scoreSrc = read('score.js');

// Load i18n.js as the browser would, with Dutch picked.
const ctx = { localStorage: { getItem: () => JSON.stringify('nl') }, navigator: { language: 'nl-BE' }, document: { documentElement: {} }, Intl };
vm.createContext(ctx);
vm.runInContext(read('public/i18n.js') + '\n;this.T = T; this.TS = TS; this.NL = NL; this.LANG = LANG;', ctx);
const { T, TS, NL } = ctx;

let failed = 0;
const fail = (msg) => { failed++; console.log('  ✗ ' + msg); };
const lit = String.raw`'((?:[^'\\]|\\.)*)'`;
const unq = (s) => s.replace(/\\'/g, "'");

// 1. every T('…') and Tn(n, '…', '…') in app.js
const keys = new Set();
for (const m of app.matchAll(new RegExp(String.raw`\bT\(\s*` + lit, 'g'))) keys.add(unq(m[1]));
for (const m of app.matchAll(new RegExp(String.raw`\bTn\([^,]+,\s*` + lit + String.raw`\s*,\s*` + lit, 'g'))) { keys.add(unq(m[1])); keys.add(unq(m[2])); }
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
for (const k of keys) {
  if (NL[k] === undefined) { fail(`no Dutch for: ${k}`); continue; }
  const extra = k.startsWith('1 ') || /\b1 /.test(k) ? ph(NL[k]).replace('{n}', '') : ph(NL[k]);
  if (ph(k) !== ph(NL[k]) && ph(k) !== extra) fail(`placeholders differ: ${k} → ${NL[k]}`);
  if (NL[k].includes('"')) fail(`straight double quote (breaks attributes): ${k}`);
  if (/<b>/.test(k) !== /<b>/.test(NL[k])) fail(`bold markup differs: ${k}`);
}
console.log(`app texts: ${keys.size}`);

// 2. server messages
const samples = new Set();
for (const m of server.matchAll(/(?:HttpError\(\d+,\s*|bad\()'([^']+)'/g)) samples.add(m[1]);
for (const m of scoreSrc.matchAll(/note = (?:scored \? )?'([^']+)'(?: : '([^']+)')?/g)) { samples.add(m[1]); if (m[2]) samples.add(m[2]); }
for (const f of ['Name', 'Step', 'Username', 'Minutes']) {
  ['can be at most 60 characters', 'is missing', 'must be a whole number', 'must be between 1 and 1440', 'needs at least 1 character', 'needs at least 3 characters']
    .forEach((s) => samples.add(`${f} ${s}`));
}
[
  'Password can be at most 256 characters', 'Password needs at least 10 characters. A few random words works well.',
  'Not unlocked yet. Log 12.5 h more first.', 'Slow down a little. Try again in 30 seconds.', 'Too many attempts. Try again in 5 minutes.',
  'Too many wrong passwords for this account. Try again in 15 minutes.', 'You and kai are already friends',
  '8-day streak', 'Dusted off after 41 days', 'Rediscovered after 15 days', 'Wheel’s pick', 'Live timer', 'Deep focus, 2 h+', 'Focus, 1 h+',
  'your 7-day streak', 'a 30-day streak', 'your finished project', 'a finished project', 'your “Hat trick” badge', 'an “The monk” badge', 'a moment',
  'hit a 7-day streak', 'finished a project', 'unlocked “Spin doctor”', 'did something great',
  'Safari on iPhone', 'Chrome on Android', 'Firefox on Windows', 'Edge on Mac', 'Linux', 'Unknown device', 'Chrome on Unknown device',
].forEach((s) => samples.add(s));
// achievement names and descriptions
const achSrc = read('achievements.js');
for (const m of achSrc.matchAll(/name: '((?:[^'\\]|\\.)*)', desc: '((?:[^'\\]|\\.)*)'/g)) { samples.add(unq(m[1])); samples.add(unq(m[2])); }
const sameInBoth = new Set(['Linux', 'Live timer', 'Hobby', 'Game', 'Project', 'Centurion', 'Stopwatch', 'Renaissance']);
for (const s of samples) {
  const out = TS(s);
  if (out === s && !sameInBoth.has(s)) fail(`server text stays English: ${s}`);
  if (/\b(the|your|and|you|with|after|more)\b/i.test(out) && !/Have I Been Pwned/.test(out)) fail(`looks half English: ${s} → ${out}`);
}
console.log(`server texts: ${samples.size}`);

// 3. a few spot checks of the formatting
const eq = (a, b) => { if (a !== b) fail(`expected “${b}”, got “${a}”`); };
eq(T('{h} h {m} min', { h: 2, m: 5 }), '2 u 5 min');
eq(TS('Not unlocked yet. Log 12.5 h more first.'), 'Nog niet vrijgespeeld. Noteer eerst nog 12,5 u.');
eq(TS('Safari on iPhone'), 'Safari op iPhone');
eq(TS('Chrome on Unknown device'), 'Chrome op Onbekend toestel');
eq(TS('your “Hat trick” badge'), 'je badge “Hattrick”');

// 4. both changelogs have the same versions
const versions = (f) => [...read(f).matchAll(/^## (\S+)/gm)].map((m) => m[1]).join(' ');
if (versions('CHANGELOG.md') !== versions('CHANGELOG.nl.md')) fail(`changelog versions differ: ${versions('CHANGELOG.md')} / ${versions('CHANGELOG.nl.md')}`);

console.log(failed ? `\n${failed} problem(s)` : '\nDutch translation complete');
process.exit(failed ? 1 : 0);
