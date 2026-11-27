'use strict';
// Points for time spent on your own stuff.
//
//   points = minutes x 10 x multiplier
//   multiplier = 1 + every bonus that applies:
//     streak        +10% per day in a row before today (max +100%)
//     rediscovered  +50% if untouched for 14+ days, +100% for 30+ days
//     wheel's pick  +25% when the timer was started from a spin
//     live timer    +20% for timed sessions (vs. adding time by hand)
//     focus         +20% for 1 h+, +40% for 2 h+ in one session
//   plus one-off bonuses: streak milestones and finishing a project.
//
// Fair play: at most 8 h a day earns points, and time added more than 2 days after it
// happened earns none (so streaks can't be backfilled). Points are stored with each
// session when it's logged, so the leaderboard is just a sum.

const DAY = 86400_000;
const POINTS_PER_MIN = 10;
const DAILY_CAP_MIN = 8 * 60;
const STREAK_DAY_MIN = 15;           // minutes on a day for it to count toward a streak
const BACKDATE_LIMIT = 2 * DAY;
const MILESTONES = { 3: 250, 7: 750, 14: 2000, 30: 5000, 60: 10000, 100: 20000, 365: 50000 };
const FINISH_BONUS = 1000;
const FINISH_MIN_MINUTES = 120;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const prevDay = (dayStartTs) => { const d = new Date(dayStartTs); d.setDate(d.getDate() - 1); return d.getTime(); };
function startOfWeek(ts) { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function startOfMonth(ts) { const d = new Date(startOfDay(ts)); d.setDate(1); return d.getTime(); }

function scoring(db) {
  const q = (sql) => db.prepare(sql);

  // ---- schema
  const hasColumn = (t, c) => !!q(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c);
  for (const [col, def] of [['points', 'INTEGER NOT NULL DEFAULT 0'], ['scored_minutes', 'INTEGER NOT NULL DEFAULT 0'],
    ['multiplier', 'REAL NOT NULL DEFAULT 1'], ['bonuses', "TEXT NOT NULL DEFAULT ''"],
    ['created_at', 'INTEGER NOT NULL DEFAULT 0'], ['from_spin', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!hasColumn('time_logs', col)) db.exec(`ALTER TABLE time_logs ADD COLUMN ${col} ${def}`);
  }
  if (!hasColumn('timers', 'from_spin')) db.exec('ALTER TABLE timers ADD COLUMN from_spin INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('items', 'finish_bonus')) db.exec('ALTER TABLE items ADD COLUMN finish_bonus INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS score_events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      points INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, day)
    );
    CREATE INDEX IF NOT EXISTS idx_events_user ON score_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_logs_item ON time_logs(item_id, ended_at);
  `);
  // Sessions logged before points existed get base points (no bonuses), capped per day.
  if (!q("SELECT 1 FROM app_settings WHERE key = 'scoring_v1'").get()) {
    const rows = q('SELECT id, user_id, minutes, ended_at FROM time_logs ORDER BY user_id, ended_at').all();
    const used = new Map();
    const upd = q('UPDATE time_logs SET created_at = ended_at, scored_minutes = ?, points = ?, multiplier = 1, bonuses = ? WHERE id = ?');
    db.exec('BEGIN');
    for (const r of rows) {
      const k = `${r.user_id}:${dayKey(r.ended_at)}`;
      const scored = Math.max(0, Math.min(r.minutes, DAILY_CAP_MIN - (used.get(k) || 0)));
      used.set(k, (used.get(k) || 0) + scored);
      upd.run(scored, scored * POINTS_PER_MIN, '[]', r.id);
    }
    q("INSERT INTO app_settings (key, value) VALUES ('scoring_v1', ?)").run(String(Date.now()));
    db.exec('COMMIT');
  }

  // ---- days & streaks
  // Scored minutes per day for a user, from `since` onward.
  function daily(userId, since) {
    const m = new Map();
    for (const r of q('SELECT ended_at, scored_minutes FROM time_logs WHERE user_id = ? AND ended_at >= ?').iterate(userId, since)) {
      const k = dayKey(r.ended_at); m.set(k, (m.get(k) || 0) + r.scored_minutes);
    }
    return m;
  }
  // Days in a row with 15+ minutes, ending the day before `ts`.
  function streakBefore(userId, ts, days = daily(userId, startOfDay(ts) - 400 * DAY)) {
    let n = 0; let d = prevDay(startOfDay(ts));
    while ((days.get(dayKey(d)) || 0) >= STREAK_DAY_MIN && n < 400) { n++; d = prevDay(d); }
    return n;
  }
  // The streak as it stands now: alive if today or yesterday counted.
  function currentStreak(userId, now = Date.now()) {
    const days = daily(userId, startOfDay(now) - 401 * DAY);
    const today = days.get(dayKey(now)) || 0;
    const before = streakBefore(userId, now, days);
    if (today >= STREAK_DAY_MIN) return { days: before + 1, doneToday: true, todayMinutes: today };
    return { days: before, doneToday: false, todayMinutes: today };
  }
  function best(userId) {
    const days = [...daily(userId, 0).entries()].filter(([, m]) => m >= STREAK_DAY_MIN).map(([k]) => k).sort();
    let bestRun = 0, run = 0, last = null;
    for (const k of days) {
      const t = new Date(`${k}T12:00:00`).getTime();
      run = last && Math.round((t - last) / DAY) === 1 ? run + 1 : 1;
      bestRun = Math.max(bestRun, run); last = t;
    }
    return bestRun;
  }

  // ---- scoring one session (call before inserting it)
  function scoreSession({ userId, item, minutes, endedAt, source, fromSpin, now = Date.now() }) {
    const result = { points: 0, scoredMinutes: 0, multiplier: 1, bonuses: [], note: null };
    if (now - endedAt > BACKDATE_LIMIT) { result.note = 'Time from more than 2 days ago doesn’t earn points'; return result; }
    const dayFrom = startOfDay(endedAt);
    const usedToday = q('SELECT COALESCE(SUM(scored_minutes), 0) AS m FROM time_logs WHERE user_id = ? AND ended_at >= ? AND ended_at < ?')
      .get(userId, dayFrom, dayFrom + DAY + 3600_000).m; // +1 h covers DST
    const scored = Math.max(0, Math.min(minutes, DAILY_CAP_MIN - usedToday));
    if (scored < minutes) result.note = scored ? 'Only the first 8 hours a day earn points' : 'You’ve hit today’s 8 hours of points';

    const streak = streakBefore(userId, endedAt);
    if (streak > 0) result.bonuses.push({ key: 'streak', label: `${streak + 1}-day streak`, pct: Math.min(10 * streak, 100) });

    const startedAt = endedAt - minutes * 60_000;
    const last = q('SELECT MAX(ended_at) AS t FROM time_logs WHERE item_id = ? AND ended_at <= ?').get(item.id, startedAt).t;
    const ref = last || item.created_at;
    const gapDays = Math.floor((startedAt - ref) / DAY);
    if (gapDays >= 30) result.bonuses.push({ key: 'rediscovered', label: `Dusted off after ${gapDays} days`, pct: 100 });
    else if (gapDays >= 14) result.bonuses.push({ key: 'rediscovered', label: `Rediscovered after ${gapDays} days`, pct: 50 });

    if (fromSpin) result.bonuses.push({ key: 'wheel', label: 'Wheel’s pick', pct: 25 });
    if (source === 'timer') result.bonuses.push({ key: 'live', label: 'Live timer', pct: 20 });
    if (minutes >= 120) result.bonuses.push({ key: 'focus', label: 'Deep focus, 2 h+', pct: 40 });
    else if (minutes >= 60) result.bonuses.push({ key: 'focus', label: 'Focus, 1 h+', pct: 20 });

    result.scoredMinutes = scored;
    result.multiplier = 1 + result.bonuses.reduce((a, b) => a + b.pct, 0) / 100;
    result.points = Math.round(scored * POINTS_PER_MIN * result.multiplier);
    return result;
  }

  // After a session is saved: did it complete a streak milestone?
  function milestone(userId, endedAt, now = Date.now()) {
    if (now - endedAt > BACKDATE_LIMIT) return null;
    const days = daily(userId, startOfDay(endedAt) - 401 * DAY);
    if ((days.get(dayKey(endedAt)) || 0) < STREAK_DAY_MIN) return null;
    const streak = streakBefore(userId, endedAt, days) + 1;
    const pts = MILESTONES[streak];
    if (!pts) return null;
    const r = q(`INSERT OR IGNORE INTO score_events (user_id, kind, day, points, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, `streak-${streak}`, dayKey(endedAt), pts, `${streak}-day streak`, now);
    return r.changes ? { days: streak, points: pts } : null;
  }

  // Finishing a project with 2 h+ logged pays once per project.
  function finishBonus(userId, item, now = Date.now()) {
    if (item.kind !== 'project' || item.finish_bonus) return null;
    const total = q('SELECT COALESCE(SUM(minutes), 0) AS m FROM time_logs WHERE item_id = ?').get(item.id).m;
    if (total < FINISH_MIN_MINUTES) return null;
    q('UPDATE items SET finish_bonus = 1 WHERE id = ?').run(item.id);
    q('INSERT OR IGNORE INTO score_events (user_id, item_id, kind, day, points, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, item.id, `finish-${item.id}`, dayKey(now), FINISH_BONUS, `Finished ${item.name}`, now);
    return { points: FINISH_BONUS, label: `Finished ${item.name}` };
  }

  // ---- totals
  function pointsSince(userId, since) {
    const a = q('SELECT COALESCE(SUM(points), 0) AS p, COALESCE(SUM(minutes), 0) AS m FROM time_logs WHERE user_id = ? AND ended_at >= ?').get(userId, since);
    const b = q('SELECT COALESCE(SUM(points), 0) AS p FROM score_events WHERE user_id = ? AND created_at >= ?').get(userId, since).p;
    return { points: a.p + b, minutes: a.m };
  }
  function summary(userId, now = Date.now()) {
    const streak = currentStreak(userId, now);
    const week = pointsSince(userId, startOfWeek(now));
    const today = pointsSince(userId, startOfDay(now));
    return {
      week: week.points, weekMinutes: week.minutes,
      month: pointsSince(userId, startOfMonth(now)).points,
      total: pointsSince(userId, 0).points,
      today: today.points,
      streak: streak.days, streakDoneToday: streak.doneToday, todayMinutes: streak.todayMinutes,
      streakGoal: STREAK_DAY_MIN,
      bestStreak: best(userId),
      streakBonus: Math.min(10 * streakBefore(userId, now), 100),
      nextMilestone: (() => { const d = Object.keys(MILESTONES).map(Number).find((x) => x > streak.days); return d ? { days: d, points: MILESTONES[d] } : null; })(),
      weekStart: startOfWeek(now),
    };
  }

  return { scoreSession, milestone, finishBonus, pointsSince, summary, currentStreak, best, startOfWeek, startOfMonth };
}

module.exports = { scoring, startOfWeek, dayKey, POINTS_PER_MIN, MILESTONES, DAILY_CAP_MIN, STREAK_DAY_MIN };
