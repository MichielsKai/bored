'use strict';
// 50 achievements. Each one pays bonus points once (they count on the leaderboard):
//   bronze 100, silver 300, gold 1,000, legendary 10,000.
// The five legendary ones are meant to be absurd.

const DAY = 86400_000;
const TIER_POINTS = { bronze: 100, silver: 300, gold: 1000, legendary: 10000 };
const H = 60; // minutes per hour

// cat: icon/category shown in the app. test(s) gets a stats snapshot; progress(s) -> [current, goal].
const LIST = [
  // getting started
  { key: 'first-spin', name: 'First spin', desc: 'Spin the wheel', cat: 'wheel', tier: 'bronze', progress: (s) => [s.spins, 1] },
  { key: 'day-one', name: 'Day one', desc: 'Log your first session', cat: 'time', tier: 'bronze', progress: (s) => [s.sessions, 1] },
  { key: 'on-the-clock', name: 'On the clock', desc: 'Finish a session with the live timer', cat: 'time', tier: 'bronze', progress: (s) => [s.timerSessions, 1] },
  { key: 'trust-the-wheel', name: 'Trust the wheel', desc: 'Start the timer straight from a spin', cat: 'wheel', tier: 'bronze', progress: (s) => [s.wheelPicks, 1] },
  { key: 'the-collection', name: 'The collection', desc: 'Have 5 things on your wheel', cat: 'wheel', tier: 'bronze', progress: (s) => [s.activeItems, 5] },
  { key: 'patience', name: 'Patience', desc: 'Put something on your wishlist instead of buying it', cat: 'money', tier: 'bronze', progress: (s) => [s.wishes, 1] },
  { key: 'better-together', name: 'Better together', desc: 'Make your first friend', cat: 'social', tier: 'bronze', progress: (s) => [s.friends, 1] },
  { key: 'up-top', name: 'Up top', desc: 'Give someone a high-five', cat: 'social', tier: 'bronze', progress: (s) => [s.hfGiven, 1] },
  { key: 'one-step', name: 'One step at a time', desc: 'Tick off a project step', cat: 'project', tier: 'bronze', progress: (s) => [s.steps, 1] },
  { key: 'earned-it', name: 'Earned it', desc: 'Buy something with an unlock', cat: 'money', tier: 'bronze', progress: (s) => [s.purchases, 1] },

  // hours
  { key: 'warming-up', name: 'Warming up', desc: 'Spend 10 hours on your stuff', cat: 'time', tier: 'bronze', progress: (s) => [s.hours, 10] },
  { key: 'committed', name: 'Committed', desc: 'Spend 50 hours on your stuff', cat: 'time', tier: 'silver', progress: (s) => [s.hours, 50] },
  { key: 'centurion', name: 'Centurion', desc: 'Spend 100 hours on your stuff', cat: 'time', tier: 'silver', progress: (s) => [s.hours, 100] },
  { key: 'devoted', name: 'Devoted', desc: 'Spend 250 hours on your stuff', cat: 'time', tier: 'gold', progress: (s) => [s.hours, 250] },
  { key: 'lifer', name: 'Lifer', desc: 'Spend 1,000 hours on your stuff', cat: 'time', tier: 'gold', progress: (s) => [s.hours, 1000] },

  // sessions
  { key: 'in-the-zone', name: 'In the zone', desc: 'One session of an hour or more', cat: 'time', tier: 'bronze', progress: (s) => [s.longest, 60] },
  { key: 'lost-track', name: 'Lost track of time', desc: 'One session of 3 hours or more', cat: 'time', tier: 'silver', progress: (s) => [s.longest, 180] },
  { key: 'regular', name: 'Regular', desc: 'Log 25 sessions', cat: 'time', tier: 'bronze', progress: (s) => [s.sessions, 25] },
  { key: 'creature-of-habit', name: 'Creature of habit', desc: 'Log 100 sessions', cat: 'time', tier: 'silver', progress: (s) => [s.sessions, 100] },
  { key: 'stopwatch', name: 'Stopwatch', desc: 'Finish 50 sessions with the live timer', cat: 'time', tier: 'silver', progress: (s) => [s.timerSessions, 50] },

  // streaks
  { key: 'hat-trick', name: 'Hat trick', desc: 'Reach a 3-day streak', cat: 'streak', tier: 'bronze', progress: (s) => [s.bestStreak, 3] },
  { key: 'a-whole-week', name: 'A whole week', desc: 'Reach a 7-day streak', cat: 'streak', tier: 'silver', progress: (s) => [s.bestStreak, 7] },
  { key: 'fortnight', name: 'Fortnight', desc: 'Reach a 14-day streak', cat: 'streak', tier: 'silver', progress: (s) => [s.bestStreak, 14] },
  { key: 'monthly', name: 'Every day for a month', desc: 'Reach a 30-day streak', cat: 'streak', tier: 'gold', progress: (s) => [s.bestStreak, 30] },
  { key: 'unstoppable', name: 'Unstoppable', desc: 'Reach a 100-day streak', cat: 'streak', tier: 'gold', progress: (s) => [s.bestStreak, 100] },

  // rediscovery & variety
  { key: 'blast-from-the-past', name: 'Blast from the past', desc: 'Pick up something untouched for 2+ weeks', cat: 'rediscover', tier: 'bronze', progress: (s) => [s.rediscovered, 1] },
  { key: 'archaeologist', name: 'Archaeologist', desc: 'Pick up something untouched for a month or more', cat: 'rediscover', tier: 'silver', progress: (s) => [s.dustedOff, 1] },
  { key: 'second-chances', name: 'Second chances', desc: 'Rediscover 10 neglected things', cat: 'rediscover', tier: 'gold', progress: (s) => [s.rediscovered, 10] },
  { key: 'variety-pack', name: 'Variety pack', desc: 'Spend time on 5 different things within 7 days', cat: 'rediscover', tier: 'silver', progress: (s) => [s.weekVariety, 5] },
  { key: 'renaissance', name: 'Renaissance', desc: 'Spend time on a hobby, game, project, learning and other', cat: 'rediscover', tier: 'silver', progress: (s) => [s.kindsPlayed, 5] },
  { key: 'no-one-left-behind', name: 'No one left behind', desc: 'With 5+ things on your wheel, touch every one within 30 days', cat: 'rediscover', tier: 'gold', progress: (s) => [s.activeItems >= 5 ? s.playedRecently : 0, Math.max(5, s.activeItems)] },

  // projects
  { key: 'done-and-dusted', name: 'Done and dusted', desc: 'Finish a project you put 2+ hours into', cat: 'project', tier: 'silver', progress: (s) => [s.finished, 1] },
  { key: 'finisher', name: 'Finisher', desc: 'Finish 5 projects', cat: 'project', tier: 'gold', progress: (s) => [s.finished, 5] },
  { key: 'step-by-step', name: 'Step by step', desc: 'Tick off 25 project steps', cat: 'project', tier: 'silver', progress: (s) => [s.steps, 25] },
  { key: 'staircase', name: 'Staircase', desc: 'Tick off 100 project steps', cat: 'project', tier: 'gold', progress: (s) => [s.steps, 100] },

  // money
  { key: 'treat-yourself', name: 'Treat yourself', desc: 'Earn and use 3 unlocks', cat: 'money', tier: 'silver', progress: (s) => [s.purchases, 3] },
  { key: 'changed-my-mind', name: 'Changed my mind', desc: 'Remove 3 wishes you no longer want (after 3+ days on the list)', cat: 'money', tier: 'bronze', progress: (s) => [s.resisted, 3] },
  { key: 'savings-account', name: 'Savings account', desc: 'Decide not to buy €500 worth of wishes', cat: 'money', tier: 'gold', progress: (s) => [Math.floor(s.saved), 500] },
  { key: 'worth-the-wait', name: 'Worth the wait', desc: 'Buy a wish that was on your list for 30+ days', cat: 'money', tier: 'silver', progress: (s) => [s.longWaitBuys, 1] },

  // wheel
  { key: 'spin-doctor', name: 'Spin doctor', desc: 'Spin the wheel 100 times', cat: 'wheel', tier: 'silver', progress: (s) => [s.spins, 100] },
  { key: 'the-wheel-knows', name: 'The wheel knows', desc: 'Start the timer from a spin 25 times', cat: 'wheel', tier: 'gold', progress: (s) => [s.wheelPicks, 25] },

  // social
  { key: 'squad', name: 'Squad', desc: 'Have 5 friends', cat: 'social', tier: 'silver', progress: (s) => [s.friends, 5] },
  { key: 'popular', name: 'Popular', desc: 'Receive 10 high-fives', cat: 'social', tier: 'silver', progress: (s) => [s.hfReceived, 10] },
  { key: 'top-of-the-week', name: 'Top of the week', desc: 'Finish a week #1 among your friends', cat: 'social', tier: 'gold', progress: (s) => [s.weeklyWins, 1] },

  // points
  { key: 'five-figures', name: 'Five figures', desc: 'Earn 10,000 points', cat: 'points', tier: 'silver', progress: (s) => [s.points, 10000] },

  // legendary: stupidly difficult on purpose
  { key: 'eternal-flame', name: 'The eternal flame', desc: 'A 365-day streak. Every single day for a year.', cat: 'legendary', tier: 'legendary', progress: (s) => [s.bestStreak, 365] },
  { key: 'ten-thousand-hours', name: 'Ten thousand hours', desc: 'Earn points for 10,000 hours. At the daily maximum, that’s over 3 years.', cat: 'legendary', tier: 'legendary', progress: (s) => [s.scoredHours, 10000] },
  { key: 'untouchable', name: 'Untouchable', desc: '#1 among 3+ friends for 26 weeks in a row', cat: 'legendary', tier: 'legendary', progress: (s) => [s.topRun, 26] },
  { key: 'the-completionist', name: 'The completionist', desc: 'Finish 100 projects, each with 2+ hours of work', cat: 'legendary', tier: 'legendary', progress: (s) => [s.finished, 100] },
  { key: 'the-monk', name: 'The monk', desc: 'Go a full year and 500 hours without buying anything', cat: 'legendary', tier: 'legendary', progress: (s) => [Math.min(s.monkDays / 365, s.monkHours / 500) >= 1 ? 1 : Math.floor(Math.min(s.monkDays / 365, s.monkHours / 500) * 100) / 100, 1] },
];
if (LIST.length !== 50) throw new Error(`expected 50 achievements, have ${LIST.length}`);
const BY_KEY = new Map(LIST.map((a) => [a.key, a]));

function achievements(db, score) {
  const q = (sql) => db.prepare(sql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS user_counters (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, key)
    );
  `);
  if (!q("SELECT 1 FROM pragma_table_info('user_achievements') WHERE name = 'seen'").get()) {
    db.exec('ALTER TABLE user_achievements ADD COLUMN seen INTEGER NOT NULL DEFAULT 0');
  }
  const counter = (userId, key) => (q('SELECT value FROM user_counters WHERE user_id = ? AND key = ?').get(userId, key) || { value: 0 }).value;
  const bump = (userId, key, by = 1) => q(`INSERT INTO user_counters (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = value + excluded.value`).run(userId, key, by);

  const friendIds = (userId) => q('SELECT b AS id FROM friendships WHERE a = ? UNION SELECT a AS id FROM friendships WHERE b = ?').all(userId, userId).map((r) => r.id);

  // Weekly standings among you + friends, for the last `weeks` finished weeks (newest first).
  const weeklyCache = new Map();
  function weeklyStandings(userId, weeks = 52) {
    const cacheKey = `${userId}:${new Date().toDateString()}`;
    if (weeklyCache.has(cacheKey)) return weeklyCache.get(cacheKey);
    const ids = [userId, ...friendIds(userId)];
    const marks = ids.map(() => '?').join(',');
    const out = [];
    let end = score.startOfWeek(Date.now());
    for (let w = 0; w < weeks; w++) {
      const d = new Date(end); d.setDate(d.getDate() - 7); const start = d.getTime();
      const pts = new Map(ids.map((id) => [id, 0]));
      for (const r of q(`SELECT user_id, SUM(points) AS p FROM time_logs WHERE user_id IN (${marks}) AND ended_at >= ? AND ended_at < ? GROUP BY user_id`).all(...ids, start, end)) pts.set(r.user_id, pts.get(r.user_id) + r.p);
      for (const r of q(`SELECT user_id, SUM(points) AS p FROM score_events WHERE user_id IN (${marks}) AND created_at >= ? AND created_at < ? GROUP BY user_id`).all(...ids, start, end)) pts.set(r.user_id, pts.get(r.user_id) + r.p);
      const mine = pts.get(userId);
      const top = mine > 0 && [...pts.entries()].every(([id, p]) => id === userId || p < mine);
      out.push({ start, end, top, people: ids.length });
      end = start;
    }
    if (weeklyCache.size > 500) weeklyCache.clear();
    weeklyCache.set(cacheKey, out);
    return out;
  }

  function stats(userId) {
    const now = Date.now();
    const logs = q('SELECT COUNT(*) AS n, COALESCE(SUM(minutes),0) AS m, COALESCE(SUM(scored_minutes),0) AS sm, COALESCE(MAX(minutes),0) AS mx FROM time_logs WHERE user_id = ?').get(userId);
    const one = (sql, ...a) => q(sql).get(...a).n;
    const lastPurchase = q('SELECT MAX(created_at) AS t FROM purchases WHERE user_id = ?').get(userId).t;
    const since = lastPurchase || q('SELECT created_at AS t FROM users WHERE id = ?').get(userId).t;
    const s = {
      sessions: logs.n, hours: logs.m / H, scoredHours: logs.sm / H, longest: logs.mx,
      timerSessions: one("SELECT COUNT(*) AS n FROM time_logs WHERE user_id = ? AND source = 'timer'", userId),
      wheelPicks: one("SELECT COUNT(*) AS n FROM time_logs WHERE user_id = ? AND source = 'timer' AND from_spin = 1", userId),
      rediscovered: one(`SELECT COUNT(*) AS n FROM time_logs WHERE user_id = ? AND bonuses LIKE '%"rediscovered"%'`, userId),
      dustedOff: one(`SELECT COUNT(*) AS n FROM time_logs WHERE user_id = ? AND bonuses LIKE '%Dusted off after%'`, userId),
      activeItems: one('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND archived = 0', userId),
      playedRecently: one('SELECT COUNT(DISTINCT i.id) AS n FROM items i JOIN time_logs l ON l.item_id = i.id WHERE i.user_id = ? AND i.archived = 0 AND l.ended_at > ?', userId, now - 30 * DAY),
      weekVariety: one('SELECT COUNT(DISTINCT item_id) AS n FROM time_logs WHERE user_id = ? AND ended_at > ?', userId, now - 7 * DAY),
      kindsPlayed: one('SELECT COUNT(DISTINCT i.kind) AS n FROM items i JOIN time_logs l ON l.item_id = i.id WHERE i.user_id = ?', userId),
      finished: one('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND finish_bonus = 1', userId),
      // steps only count if ticked 10+ minutes after they were written, so they can't be farmed
      steps: one('SELECT COUNT(*) AS n FROM project_steps WHERE user_id = ? AND done_at IS NOT NULL AND done_at - created_at >= 600000', userId),
      wishes: one('SELECT COUNT(*) AS n FROM wishes WHERE user_id = ?', userId) + counter(userId, 'wishes_resisted') + one('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND wish_id IS NOT NULL', userId),
      purchases: one('SELECT COUNT(*) AS n FROM purchases WHERE user_id = ?', userId),
      longWaitBuys: one('SELECT COUNT(*) AS n FROM purchases p JOIN wishes w ON w.id = p.wish_id WHERE p.user_id = ? AND p.created_at - w.created_at >= ?', userId, 30 * DAY),
      resisted: counter(userId, 'wishes_resisted'),
      saved: counter(userId, 'money_saved'),
      spins: counter(userId, 'spins'),
      friends: friendIds(userId).length,
      hfGiven: one('SELECT COUNT(*) AS n FROM high_fives WHERE from_id = ?', userId),
      hfReceived: one('SELECT COUNT(*) AS n FROM high_fives h JOIN score_events e ON e.id = h.event_id WHERE e.user_id = ?', userId),
      points: score.pointsSince(userId, 0).points,
      bestStreak: score.best(userId),
      monkDays: (now - since) / DAY,
      monkHours: q('SELECT COALESCE(SUM(scored_minutes),0) AS m FROM time_logs WHERE user_id = ? AND ended_at > ?').get(userId, since).m / H,
      weeklyWins: 0, topRun: 0,
    };
    return s;
  }
  // social weekly ones are the expensive part: only compute when they could still unlock
  function addWeekly(userId, s, unlocked) {
    if (unlocked.has('top-of-the-week') && unlocked.has('untouchable')) return;
    if (s.friends < 1) return;
    const weeks = weeklyStandings(userId);
    s.weeklyWins = weeks.filter((w) => w.top && w.people >= 2).length;
    let run = 0;
    for (const w of weeks) { if (w.top && w.people >= 4) { run++; s.topRun = Math.max(s.topRun, run); } else run = 0; }
  }

  const unlockedSet = (userId) => new Set(q('SELECT key FROM user_achievements WHERE user_id = ?').all(userId).map((r) => r.key));

  // Unlock anything newly earned. Returns the new ones, for the app to celebrate.
  function check(userId) {
    const have = unlockedSet(userId);
    if (have.size === LIST.length) return [];
    const s = stats(userId);
    addWeekly(userId, s, have);
    const now = Date.now();
    const fresh = [];
    for (const a of LIST) {
      if (have.has(a.key)) continue;
      const [cur, goal] = a.progress(s);
      if (cur < goal) continue;
      const r = q('INSERT OR IGNORE INTO user_achievements (user_id, key, unlocked_at) VALUES (?, ?, ?)').run(userId, a.key, now);
      if (!r.changes) continue;
      const pts = TIER_POINTS[a.tier];
      q('INSERT OR IGNORE INTO score_events (user_id, kind, day, points, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, `ach-${a.key}`, 'once', pts, a.name, now);
      fresh.push({ key: a.key, name: a.name, desc: a.desc, tier: a.tier, cat: a.cat, points: pts });
    }
    return fresh;
  }

  // Everything for the achievements screen.
  function list(userId) {
    const have = new Map(q('SELECT key, unlocked_at FROM user_achievements WHERE user_id = ?').all(userId).map((r) => [r.key, r.unlocked_at]));
    const s = stats(userId);
    addWeekly(userId, s, new Set(have.keys()));
    return LIST.map((a) => {
      const [cur, goal] = a.progress(s);
      return { key: a.key, name: a.name, desc: a.desc, tier: a.tier, cat: a.cat, points: TIER_POINTS[a.tier],
        unlockedAt: have.get(a.key) || null, progress: Math.min(1, goal ? cur / goal : 0), current: Math.floor(Math.min(cur, goal) * 10) / 10, goal };
    });
  }

  // Unlocks the app hasn't shown yet (including ones earned through friends while you were away).
  function deliver(userId) {
    const rows = q('SELECT key FROM user_achievements WHERE user_id = ? AND seen = 0 ORDER BY unlocked_at').all(userId);
    if (!rows.length) return [];
    q('UPDATE user_achievements SET seen = 1 WHERE user_id = ? AND seen = 0').run(userId);
    return rows.map((r) => BY_KEY.get(r.key)).filter(Boolean)
      .map((a) => ({ key: a.key, name: a.name, desc: a.desc, tier: a.tier, cat: a.cat, points: TIER_POINTS[a.tier] }));
  }

  return { check, deliver, list, bump, counter, weeklyStandings, BY_KEY, TIER_POINTS };
}

module.exports = { achievements, LIST, TIER_POINTS };
