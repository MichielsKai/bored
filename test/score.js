'use strict';
// Streak freezes and streaks, checked straight against the scoring engine.
// Run: node --experimental-sqlite test/score.js
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { scoring } = require('../score');

const DAY = 86400_000;
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  ✗   ${name}\n      ${e.message}`); }
}
// A fresh database with one user and one thing, active on the given days (0 = today, 1 = yesterday…)
function setup(activeDaysAgo) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, kind TEXT, archived INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE time_logs (id INTEGER PRIMARY KEY, user_id INTEGER, item_id INTEGER, minutes INTEGER, ended_at INTEGER, source TEXT);
    CREATE TABLE timers (user_id INTEGER PRIMARY KEY, item_id INTEGER, started_at INTEGER);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO app_settings VALUES ('scoring_v1', '1');
    INSERT INTO users VALUES (1, 'kai');
    INSERT INTO items VALUES (1, 1, 'Guitar', 'hobby', 0, 0);`);
  const score = scoring(db);
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const ins = db.prepare("INSERT INTO time_logs (user_id, item_id, minutes, ended_at, source, scored_minutes, created_at) VALUES (1, 1, 30, ?, 'manual', 30, ?)");
  for (const n of activeDaysAgo) { const d = new Date(noon); d.setDate(d.getDate() - n); ins.run(d.getTime(), d.getTime()); }
  return { db, score };
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);   // days ago, inclusive

check('6 days in a row, then a missed day: no freeze yet, so the streak is gone', () => {
  const { score } = setup(range(2, 7));
  const s = score.currentStreak(1);
  assert.equal(s.days, 0); assert.equal(s.freezes, 0);
});
check('7 days in a row earns a freeze, which saves a missed yesterday', () => {
  const { score } = setup(range(2, 8));
  const s = score.currentStreak(1);
  assert.equal(s.days, 7); assert.equal(s.freezes, 0); assert.equal(s.frozeYesterday, true); assert.equal(s.doneToday, false);
});
check('after a freeze the streak carries on from where it was', () => {
  const { score } = setup([0, ...range(2, 8)]);
  const s = score.currentStreak(1);
  assert.equal(s.days, 8); assert.equal(s.doneToday, true);
});
check('14 days earns 2 freezes, enough for two missed days, not three', () => {
  let s = setup(range(3, 16)).score.currentStreak(1);
  assert.equal(s.days, 14); assert.equal(s.freezes, 0);
  s = setup(range(4, 17)).score.currentStreak(1);
  assert.equal(s.days, 0, 'three missed days with two freezes');
});
check('you can hold at most 2 freezes', () => {
  const s = setup(range(1, 21)).score.currentStreak(1);
  assert.equal(s.days, 21); assert.equal(s.freezes, 2);
});
check('the 7th day today shows its new freeze straight away', () => {
  const s = setup(range(0, 6)).score.currentStreak(1);
  assert.equal(s.days, 7); assert.equal(s.freezes, 1);
});
check('the streak bonus on a session counts days saved by a freeze', () => {
  const { score } = setup(range(2, 8));
  const e = score.scoreSession({ userId: 1, item: { id: 1, created_at: 0 }, minutes: 30, endedAt: Date.now(), source: 'manual' });
  const b = e.bonuses.find((x) => x.key === 'streak');
  assert.ok(b, 'no streak bonus'); assert.equal(b.label, '8-day streak'); assert.equal(b.pct, 70);
});
check('best streak and the summary agree', () => {
  const { score } = setup([...range(0, 2), ...range(10, 19)]);
  const sum = score.summary(1);
  assert.equal(sum.bestStreak, 10); assert.equal(sum.streak, 3); assert.equal(sum.freezeMax, 2);
  assert.ok(sum.monthMinutes >= 0);
});
check('nothing logged: no streak, no freezes', () => {
  const s = setup([]).score.currentStreak(1);
  assert.equal(s.days, 0); assert.equal(s.freezes, 0); assert.equal(s.best, 0);
});

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
