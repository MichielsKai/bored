'use strict';
/* bored? — client */
const TAU = Math.PI * 2;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Soft slice colors that all carry the same dark text.
const INKS = ['#FFB4A2', '#A6C8FF', '#FFD873', '#A3DFB8', '#CDBBFF', '#FFB8D2', '#93DCE0'];
const SLICE_TEXT = '#1D1E22';
const CONFETTI = [...INKS, '#5457E0'];
// i18n.js loads first; switching language reloads the page, so these can be translated once.
const KINDS = { hobby: T('Hobby'), game: T('Game'), project: T('Project'), learning: T('Learning'), other: T('Other') };
const KICKERS = [
  'The wheel has spoken.', 'Up next for you:', 'Skip the shop. Do this:', 'You already own the fun:',
  'Dust this one off:', 'Your past self bought this for a reason:', 'Here’s your plan:',
].map((k) => T(k));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');


const store = {
  get: (k, d) => { try { const v = localStorage.getItem('bored.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('bored.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- preferences ----------
// Saved with your account (so phone and laptop match) and kept on this device so the look applies at once.
const PREF_DEFAULTS = {
  theme: 'system', accent: 'indigo', textSize: 'normal', sound: true, haptics: true, confetti: true, spin: 'normal',
  skin: 'none', wakeLock: false, tabTitle: false, neglect: 'normal', autoTimer: false, currency: 'EUR', timeFormat: 'decimal',
  private: false, shareMoments: true, allowNudges: true, popups: true, tourDone: false,
};
function prefs() {
  let live = {};
  try { live = (S && S.user && S.user.prefs) || {}; } catch { /* S isn't set up yet on the first line of the app */ }
  return { ...PREF_DEFAULTS, ...store.get('prefs', {}), ...live };
}
const pref = (k) => prefs()[k];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyLook(p = prefs()) {
  const root = document.documentElement;
  const skin = p.skin && p.skin !== 'none' ? p.skin : '';
  // a secret theme brings its own colours, so light/dark and the accent step aside
  const dark = !skin && (p.theme === 'dark' || (p.theme === 'system' && darkQuery.matches));
  root.dataset.mode = dark ? 'dark' : 'light';
  if (skin) { root.dataset.skin = skin; delete root.dataset.accent; } else { delete root.dataset.skin; root.dataset.accent = p.accent; }
  root.dataset.text = p.textSize;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = skin === 'walnut' ? '#24150C' : skin === 'doodle' ? '#FFFDF6' : dark ? '#111215' : '#F3F4F7'; m.removeAttribute('media'); });
}
applyLook();
darkQuery.addEventListener?.('change', () => applyLook());

let S = null;               // server state
let config = { firstUser: false, defaultHours: 20 };
const PAGE_VERSION = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || 'dev'; } catch { return 'dev'; } })();
let view = store.get('view', 'spin');
let clockOffset = 0;
let wheelRot = store.get('rot', 0);
let spinning = false;
let selectedWeek = null;
let wheelWinner = null, wheelDim = 0;      // highlight of the slice that won
let lastPct = null, lastUnlocks = null;    // for animating the meter and pill
let freshId = null, timerJustStarted = false;

// ---------- api ----------
async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  if (method !== 'GET' && queue().length && !flushing) await flushQueue();   // keep things in order
  let res;
  try { res = await fetch(url, opts); } catch {
    if (method !== 'GET' && S) { const r = offlineDo(method, url, body || {}); if (r) return r; }
    throw Object.assign(new Error(method === 'GET' ? T('Can’t reach the server. Check your connection.') : T('You’re offline. This one has to wait until you’re back online.')), { network: true });
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && data.error === 'Sign in to continue') { S = null; forgetDevice(); closeSheet(); renderAuth(); throw Object.assign(new Error(TS(data.error)), { signedOut: true }); }
  if (!res.ok) throw new Error(data.error ? TS(data.error) : T('Request failed ({n})', { n: res.status }));
  if (data && Array.isArray(data.items)) setState(data);
  if (data && Array.isArray(data.achievements) && data.achievements.length && url !== '/api/achievements') {
    const list = data.achievements; if (pref('popups')) enqueue(() => showAchievements(list));
  }
  if (data && Array.isArray(data.nudges) && data.nudges.length) {
    const names = [...new Set(data.nudges.map((n) => n.from))];
    const streak = data.score ? data.score.streak : 0;
    setTimeout(() => {
      const who = names.length === 1 ? names[0] : Tn(names.length - 1, '{name} and 1 other', '{name} and {n} others', { name: names[0] });
      toast(streak ? T('{who} nudged you: your {n}-day streak needs 15 minutes today', { who, n: streak }) : T('{who} nudged you to get going today', { who }));
      SFX.pop(); buzz([10, 40, 10]);
    }, 1200);
    api('POST', '/api/nudges/seen').catch(() => {});
  }
  if (data && Array.isArray(data.highFives) && data.highFives.length) {
    const hf = data.highFives;
    setTimeout(() => {
      const names = [...new Set(hf.map((h) => h.from))];
      toast(hf.length === 1 ? T('{name} high-fived {what}', { name: hf[0].from, what: TS(hf[0].text) })
        : names.length === 1 ? T('{name} high-fived you {count} times', { name: names[0], count: hf.length })
          : Tn(names.length - 1, '{name} and 1 other high-fived you {count} times', '{name} and {n} others high-fived you {count} times', { name: names[0], count: hf.length }));
      SFX.pop(); FX.burstFrom($('.nav [data-v="friends"]'), { n: 14 });
    }, 700);
    api('POST', '/api/high-fives/seen').catch(() => {});
  }
  return data;
}
const now = () => Date.now() + clockOffset;
function setState(d) {
  S = d; clockOffset = d.now - Date.now();
  if (S.user && S.user.prefs) { store.set('prefs', S.user.prefs); applyLook(S.user.prefs); }
  render(); checkGoal();
  store.set('lastState', S);   // opens with this when there's no connection
}
const refresh = () => api('GET', '/api/state').catch(() => {});

// ---------- offline ----------
// The app keeps the last state on this device and opens with it when there's no connection.
// Timers and logged time go into a queue with the time they happened, and are sent in order
// once the connection is back. Everything else needs a connection.
let flushing = false;
const queue = () => store.get('queue', []);
const saveQueue = (list) => store.set('queue', list);
const itemName = (id) => (S.items.find((i) => i.id === id) || {}).name || '';
function localLog(itemId, minutes, endedAt, source, note) {
  S.logs.unshift({ id: -Date.now(), item_id: itemId, minutes, ended_at: endedAt, source, points: 0, note: note || '', edited: 0, item_name: itemName(itemId), pending: true });
  const it = S.items.find((i) => i.id === itemId);
  if (it) { it.minutes += minutes; it.sessions += 1; it.last_at = endedAt; }
  const b = S.bank; b.earnedMinutes += minutes;
  const balance = b.earnedMinutes - b.spentMinutes;
  b.unlocks = balance > 0 ? Math.floor(balance / b.costMinutes) : 0;
  b.progressMinutes = balance > 0 ? balance % b.costMinutes : 0;
}
function offlineDo(method, url, body) {
  const key = `${method} ${url}`, t = now();
  let result = {};
  if (key === 'POST /api/timer/start') {
    if (S.timer) return null;
    body = { ...body, startedAt: t };
    S.timer = { item_id: body.itemId, item_name: itemName(body.itemId), started_at: t, from_spin: body.fromSpin ? 1 : 0, paused_at: 0, paused_ms: 0 };
  } else if (key === 'POST /api/timer/pause' || key === 'POST /api/timer/resume') {
    if (!S.timer) return null;
    body = { at: t };
    if (url.endsWith('pause')) { if (!S.timer.paused_at) S.timer.paused_at = t; }
    else if (S.timer.paused_at) { S.timer.paused_ms = (S.timer.paused_ms || 0) + t - S.timer.paused_at; S.timer.paused_at = 0; }
  } else if (key === 'POST /api/timer/stop') {
    if (!S.timer) return null;
    const elapsed = Math.round(timerMs() / 60000);
    const minutes = body.minutes !== undefined ? Math.min(body.minutes, Math.max(elapsed, 1)) : Math.min(elapsed, 1440);
    body = { ...body, endedAt: t };
    const itemId = S.timer.item_id; S.timer = null;
    if (minutes >= 1) localLog(itemId, minutes, t, 'timer', body.note);
    result = { logged: minutes, newUnlocks: 0, earned: null };
  } else if (key === 'POST /api/timer/cancel') {
    S.timer = null;
  } else if (key === 'POST /api/logs') {
    body = { ...body, endedAt: body.endedAt || t };
    localLog(body.itemId, body.minutes, body.endedAt, 'manual', body.note);
    result = { logged: body.minutes, newUnlocks: 0, earned: null };
  } else return null;
  saveQueue([...queue(), { method, url, body, user: S.user.username }]);
  setState({ ...S, now: Date.now() + clockOffset });
  setOffline(true);
  return { ...result, offline: true };
}
async function flushQueue() {
  if (flushing || !S) return;
  if (!queue().length) { setOffline(false); return; }
  flushing = true;
  let sent = 0;
  try {
    while (queue().length) {
      const [job, ...rest] = queue();
      if (job.user === S.user.username) {
        let res;
        try {
          res = await fetch(job.url, { method: job.method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body) });
        } catch { setOffline(true); return; }                            // still offline: try again later
        if (res.status === 401 || res.status === 429 || res.status >= 500) return;
        if (!res.ok) { const d = await res.json().catch(() => ({})); if (d.error) toast(TS(d.error)); }   // refused: drop it
        sent++;
      }
      saveQueue(rest);
    }
    setOffline(false);
    if (sent) toast(T('Back online. Everything you did offline is saved.'));
  } finally { flushing = false; }
  if (sent) await refresh();
}
// Signed out: don't leave your data (or unsent changes) on this device.
function forgetDevice() { try { localStorage.removeItem('bored.lastState'); localStorage.removeItem('bored.queue'); } catch { /* private mode */ } setOffline(false); }
function setOffline(on) {
  let bar = $('#offline-bar');
  const n = queue().length;
  if (!on) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'offline-bar'; bar.setAttribute('role', 'status'); document.body.append(bar); }
  bar.textContent = n ? Tn(n, 'Offline: 1 change waits to sync', 'Offline: {n} changes wait to sync')
    : T('Offline: timers still work');
}
addEventListener('online', () => flushQueue());
addEventListener('offline', () => { if (S) setOffline(true); });

// ---------- formatting ----------
const nf = new Intl.NumberFormat(LOCALE);
const nf1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const round1 = (n) => nf1.format(Math.round(n * 10) / 10);   // for display only
function hrs(min) {
  if (pref('timeFormat') === 'hm' && min >= 60) return hm(min);
  return min < 60 && min > 0 ? T('{m} min', { m: min }) : T('{h} h', { h: round1(min / 60) });
}
function hm(min) { const h = Math.floor(min / 60), m = min % 60; return h ? (m ? T('{h} h {m} min', { h, m }) : T('{h} h', { h })) : T('{m} min', { m }); }
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function ago(ts) {
  if (!ts) return T('never touched');
  const d = Math.floor((now() - ts) / 86400000);
  if (d <= 0) return T('touched today');
  if (d === 1) return T('touched yesterday');
  if (d < 60) return T('touched {n} days ago', { n: d });
  return T('touched {n} months ago', { n: Math.round(d / 30) });
}
function listedFor(ts) {
  const d = Math.max(0, Math.floor((now() - ts) / 86400000));
  return d === 0 ? T('added today') : Tn(d, 'on your list for 1 day', 'on your list for {n} days');
}
const day = (ts) => new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
const money = (p) => p == null ? '' : new Intl.NumberFormat(LOCALE, { style: 'currency', currency: pref('currency'), maximumFractionDigits: p % 1 ? 2 : 0 }).format(p);
const currencySign = () => ({ EUR: '€', USD: '$', GBP: '£' })[pref('currency')] || '€';
// Slice colours: pastels normally, jewel tones in Walnut, felt-tips in Doodle.
const SKIN_INKS = {
  walnut: ['#7A1F2B', '#1F4D3A', '#1E3557', '#8A6A1F', '#4A2A4F', '#2F5D62', '#6B3A1E'],
  doodle: ['#FF6B6B', '#4ECDC4', '#FFE066', '#C49BFF', '#FF9F1C', '#7BD389', '#74B9FF'],
};
const colorOf = (item) => { const inks = SKIN_INKS[pref('skin')] || INKS; return inks[(item.id - 1) % inks.length]; };
const active = () => S.items.filter((i) => !i.archived);
const snoozed = (i) => i.snoozed_until > now();
const onWheel = () => active().filter((i) => !snoozed(i));

// Quick filters for the wheel: tags (AND) and kinds (any of).
let filters = store.get('filters', { quick: false, chill: false, kinds: [] });
const filtering = () => filters.quick || filters.chill || filters.kinds.length > 0;
function wheelItems() {
  return onWheel().filter((i) => (!filters.quick || i.quick) && (!filters.chill || i.chill) && (!filters.kinds.length || filters.kinds.includes(i.kind)));
}

// Neglected things get bigger slices: 1× if touched today, up to 3× after four weeks or never.
// The "neglect boost" setting: off (equal slices), gentle (up to 2×), normal (3×) or strong (5×).
function weightOf(item) {
  const max = { off: 1, gentle: 2, normal: 3, strong: 5 }[pref('neglect')] || 3;
  if (!item.last_at) return max;
  const days = (now() - item.last_at) / 86400000;
  return 1 + (Math.min(Math.max(days, 0), 28) / 28) * (max - 1);
}
function odds(item) {
  const list = onWheel();
  const total = list.reduce((a, i) => a + weightOf(i), 0);
  return total ? Math.round((weightOf(item) / total) * 100) : 0;
}

// ---------- icons ----------
const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  spin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.3 4.3M14.1 14.1l4.3 4.3M18.4 5.6l-4.3 4.3M9.9 14.1l-4.3 4.3"/><circle cx="12" cy="12" r="3"/></svg>',
  stuff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
  shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4.5 8h15l-1.2 11.1a2 2 0 0 1-2 1.9H7.7a2 2 0 0 1-2-1.9L4.5 8Z"/><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3"/></svg>',
  stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="5" width="3" height="12" rx="1"/><rect x="15.5" y="8" width="3" height="9" rx="1"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  friends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5.5a1.5 1.5 0 0 0 0 3H8M16 6h2.5a1.5 1.5 0 0 1 0 3H16"/><path d="M12 13v3M8.5 20h7M10 16h4l.5 4h-5l.5-4Z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.6 2.3c.4 2.6-.6 4.4-2 6-1.3 1.5-2.6 3-2.6 5.4 0 .9.2 1.7.6 2.4-.9-.6-1.6-1.6-1.9-2.8-1 1.3-1.7 3-1.7 4.7C5 21.1 8.1 24 12 24s7-2.9 7-6.6c0-4.6-3.2-6.8-4.4-10-.5-1.5-.5-3.4-2-5.1Z" transform="scale(.92) translate(1 0)"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z"/><path d="M5 19 13 11"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8.5a6.5 6.5 0 0 1-6.5 6.5h-.3a6 6 0 0 1-4.6-2.2L3.2 15a1.6 1.6 0 0 1 2.4-2.1L8 15"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2A3 3 0 0 0 12 8c-1.7 0-2.8.9-2.8 2s1.1 1.6 2.8 2 2.8.9 2.8 2-1.1 2-2.8 2a3 3 0 0 1-2.5-1.2M12 6.5V8M12 16v1.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9L12 2.8Z"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 18H5L3 7.5Z"/><rect x="5" y="19.5" width="14" height="2" rx="1"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8c0 .9 1 1.4 1.7.9l9.4-6.4c.6-.4.6-1.3 0-1.8L9.7 4.7C9 4.2 8 4.7 8 5.6Z"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/></svg>',
  pointer: '<svg viewBox="0 0 30 34"><path d="M15 32c-1 0-1.7-.6-2.2-1.4L4.2 12.8A11.5 11.5 0 1 1 25.8 12.8l-8.6 17.8c-.5.8-1.2 1.4-2.2 1.4Z" fill="currentColor"/></svg>',
};

// ---------- rendering ----------
function render() {
  if (!S) return renderAuth();
  const app = $('#app');
  const views = { spin: viewSpin, stuff: viewStuff, shop: viewShop, friends: viewFriends, stats: viewStats };
  if (!views[view]) view = 'spin';
  const tabs = [['spin', T('Spin')], ['stuff', T('My stuff')], ['shop', T('Wishlist')], ['friends', T('Friends')], ['stats', T('Stats')]];
  app.innerHTML = `
    <div class="app-wrap">
      <div class="shell">
        <header class="top">
          <h1 class="logo">bored?</h1>
          ${bankPill()}
          <button class="icon-btn" data-act="settings" aria-label="${T('Settings')}">${ICON.gear}</button>
        </header>
        ${timerBar()}
        <main class="view" id="view">${views[view]()}</main>
      </div>
      <nav class="nav" aria-label="${T('Sections')}"><div class="nav-inner">
        ${tabs.map(([k, l]) => `<button data-act="nav" data-v="${k}" ${view === k ? 'aria-current="page"' : ''}><span class="ico">${ICON[k]}${k === 'friends' && S.friendRequests ? `<i class="dot-badge" aria-label="${T('new friend request')}"></i>` : ''}</span><span>${l}</span></button>`).join('')}
      </div></nav>
    </div>`;
  if (view === 'spin') drawWheel();
  if (view === 'friends') { if (F) afterFriendsRender(); loadFriends(); }
  if (view === 'stats') loadAchievements();
  tickTimer();
  // animate progress from where it was, and bump the pill when a buy unlocks
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.meter-fill[data-to]').forEach((m) => { m.style.width = m.dataset.to + '%'; });
  }));
  lastPct = Math.min(100, (S.bank.progressMinutes / S.bank.costMinutes) * 100);
  if (lastUnlocks != null && S.bank.unlocks > lastUnlocks) $('.bankpill')?.classList.add('bump');
  lastUnlocks = S.bank.unlocks;
}

function bankPill() {
  const b = S.bank;
  const frac = b.unlocks > 0 ? 1 : b.progressMinutes / b.costMinutes;
  const r = 10, c = 2 * Math.PI * r;
  const ring = `<svg class="ring" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".15" stroke-width="4"/>
      <circle cx="13" cy="13" r="${r}" fill="none" stroke="${b.unlocks ? 'currentColor' : 'var(--accent)'}" stroke-width="4"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}" transform="rotate(-90 13 13)" stroke-linecap="round"/></svg>`;
  const label = b.unlocks > 0
    ? Tn(b.unlocks, '1 buy ready', '{n} buys ready')
    : T('{a} / {b} h', { a: round1(b.progressMinutes / 60), b: round1(b.costMinutes / 60) });
  return `<button class="bankpill ${b.unlocks ? 'ready' : ''}" data-act="nav" data-v="shop" aria-label="${esc(T('{label}, open wishlist', { label }))}">${ring}<span>${label}</span></button>`;
}

// Time on the running timer, minus pauses.
const timerMs = (t = S.timer) => (t.paused_at || now()) - t.started_at - (t.paused_ms || 0);
function timerBar() {
  if (!S.timer) return '';
  const enter = timerJustStarted; timerJustStarted = false;
  const paused = !!S.timer.paused_at;
  return `<div class="timerbar ${enter ? 'enter' : ''} ${paused ? 'paused' : ''}" role="timer">
    <div class="what"><span>${paused ? T('Paused') : T('Timing')}</span><b>${esc(S.timer.item_name)}</b></div>
    <span class="clock" id="clock">${clock(timerMs())}</span>
    <button class="icon-btn" data-act="${paused ? 'timer-resume' : 'timer-pause'}" aria-label="${paused ? T('Resume') : T('Pause')}">${paused ? ICON.play : ICON.pause}</button>
    <button class="btn small" data-act="timer-stop">${T('Stop')}</button>
    <button class="icon-btn" data-act="timer-cancel" aria-label="${T('Discard timer')}">${ICON.x}</button>
  </div>`;
}

function meter(b) {
  const pct = Math.min(100, (b.progressMinutes / b.costMinutes) * 100);
  const from = lastPct == null || lastPct > pct ? (lastPct == null ? pct : 0) : lastPct;
  return `<div class="meter-track" role="progressbar" aria-valuemin="0" aria-valuemax="${b.costMinutes}" aria-valuenow="${b.progressMinutes}" aria-label="${T('Progress to next buy')}">
    <div class="meter-fill" style="width:${from}%" data-to="${pct}"></div></div>`;
}

// --- Spin
function filterChips() {
  const kinds = [...new Set(active().map((i) => i.kind))];
  const chip = (act, v, label, on) => `<button class="fchip" data-act="${act}" data-v="${v}" aria-pressed="${on}">${label}</button>`;
  return `<div class="filters" role="group" aria-label="${T('Filter the wheel')}">
    ${chip('filter', 'quick', `${ICON.clock}${T('Under 30 min')}`, filters.quick)}
    ${chip('filter', 'chill', `${ICON.leaf}${T('Low energy')}`, filters.chill)}
    ${kinds.length > 1 ? kinds.map((k) => chip('filter-kind', k, KINDS[k], filters.kinds.includes(k))).join('') : ''}
    ${filtering() ? `<button class="fchip clear" data-act="filter-clear">${T('Clear')}</button>` : ''}
  </div>`;
}
function viewSpin() {
  const all = active();
  const list = wheelItems();
  const b = S.bank;
  if (all.length >= 2 && list.length < 2) {
    const untagged = (filters.quick && !all.some((i) => i.quick)) || (filters.chill && !all.some((i) => i.chill));
    return `<section class="wheel-area">${filterChips()}
      <div class="empty surface">
        <h2>${list.length ? T('Only one match') : T('Nothing matches')}</h2>
        <p class="muted">${untagged ? T('Tag things as “under 30 min” or “low energy” in My stuff, then they’ll show up here.') : T('Loosen a filter to get at least two things on the wheel.')}</p>
        ${list.length === 1 ? `<button class="btn primary" data-act="timer-start" data-id="${list[0].id}">${T('Just do {name}', { name: esc(list[0].name) })}</button>` : ''}
        <button class="btn" data-act="filter-clear">${T('Clear filters')}</button>
      </div></section>`;
  }
  if (list.length < 2) {
    return `<section class="empty surface">
      <h2>${list.length ? T('One more') : T('Nothing to spin yet')}</h2>
      <p class="muted">${T('Add the hobbies, games and half-finished projects you already have. You need at least two to spin.')}</p>
      <button class="btn primary" data-act="nav" data-v="stuff">${T('Add your stuff')}</button>
    </section>`;
  }
  const toGo = b.costMinutes - b.progressMinutes;
  return `<section class="wheel-area">
      ${all.length > 2 ? filterChips() : ''}
      <div class="wheel-wrap">
        <span class="pointer" id="pointer" aria-hidden="true">${ICON.pointer}</span>
        <canvas id="wheel" role="img" aria-label="${esc(T('Wheel with {n} things: {names}', { n: list.length, names: list.map((i) => i.name).join(', ') }))}"></canvas>
        <button class="hub" id="hub" data-act="spin">${T('Spin')}</button>
      </div>
      <div class="meter">
        <div class="meter-label">
          ${b.unlocks
            ? `<span><b>${Tn(b.unlocks, '1 buy unlocked.', '{n} buys unlocked.')}</b> ${T('Next one in {time}.', { time: hrs(toGo) })}</span>`
            : `<span>${T('<b>{time}</b> to go until your next buy', { time: hrs(toGo) })}</span>`}
          <span class="muted">${T('{a} / {b} h', { a: round1(b.progressMinutes / 60), b: round1(b.costMinutes / 60) })}</span>
        </div>
        ${meter(b)}
      </div>
      ${streakCard()}
      ${goalCard()}
    </section>`;
}

// --- Monthly goal: hours this month, as a ring
function goalRing(pct, size = 46) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  return `<svg class="goal-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="track"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(1, pct))}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}
function goalCard() {
  const goal = S.user.monthlyGoal, done = S.score.monthMinutes || 0;
  if (!goal) return '';
  const pct = done / goal;
  const d = new Date(now()), left = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
  const line = pct >= 1 ? T('Goal reached. Everything from here is extra.')
    : Tn(left, '{time} to go, last day of the month', '{time} to go, {n} days left', { time: hm(goal - done) });
  return `<button class="goal surface ${pct >= 1 ? 'reached' : ''}" data-act="goal">
    ${goalRing(pct)}<span class="main"><b>${T('{a} of {b} this month', { a: hm(done), b: hm(goal) })}</b><span class="muted small">${line}</span></span>
    <span class="pct">${Math.min(999, Math.round(pct * 100))}%</span></button>`;
}
function goalSheet() {
  const goal = S.user.monthlyGoal;
  openSheet(`${sheetHead(T('Monthly goal'))}
    <p class="muted">${T('How many hours do you want to spend on your own stuff each month? It’s just for you: it doesn’t change points or unlocks.')}</p>
    <form class="stack" data-form="goal">
      <div class="row"><input class="input" name="hours" type="number" inputmode="numeric" min="1" max="300" step="1" value="${goal ? Math.round(goal / 60) : 15}" aria-label="${T('Hours per month')}" style="width:110px"><span>${T('hours a month')}</span></div>
      <div class="row wrap">${[5, 10, 15, 20, 30].map((h) => `<button type="button" class="btn small" data-act="goal-pick" data-v="${h}">${T('{h} h', { h })}</button>`).join('')}</div>
      <p class="form-error"></p>
      <button class="btn primary block">${T('Save goal')}</button>
    </form>
    ${goal ? `<button class="btn ghost block" data-act="goal-remove">${T('Remove goal')}</button>` : ''}`);
}
// Confetti once a month, the first time you see you've hit it.
function checkGoal() {
  if (!S || !S.user.monthlyGoal || !S.score) return;
  const key = `goal-${S.score.monthStart}`;
  if (S.score.monthMinutes >= S.user.monthlyGoal && !store.get(key, false)) {
    store.set(key, true);
    setTimeout(() => { FX.cannons(120); SFX.fanfare(); toast(T('Monthly goal reached: {time}!', { time: hm(S.user.monthlyGoal) })); }, 900);
  }
}

function streakCard() {
  const sc = S.score; if (!sc) return '';
  const left = sc.streakDoneToday ? null : Math.max(1, sc.streakGoal - sc.todayMinutes);
  const line = sc.streak === 0
    ? T('Do {m} min today to start a streak', { m: left })
    : sc.streakDoneToday
      ? (sc.nextMilestone ? Tn(sc.nextMilestone.days - sc.streak, '1 more day to the {days}-day bonus', '{n} more days to the {days}-day bonus', { days: sc.nextMilestone.days }) : T('Legendary streak'))
      : sc.frozeYesterday ? T('A freeze saved your streak yesterday. Do {m} min today to keep it going', { m: left })
      : T('Do {m} min today to keep it going', { m: left });
  const ice = sc.freezes ? `<span class="freeze-pill" title="${esc(Tn(sc.freezes, '1 streak freeze', '{n} streak freezes'))}">${ICON.snow}${sc.freezes}</span>` : '';
  return `<button class="streak surface ${sc.streak && !sc.streakDoneToday ? 'at-risk' : ''}" data-act="nav" data-v="friends">
    <span class="flame ${sc.streak ? 'lit' : ''}">${ICON.flame}</span>
    <span class="main"><b>${sc.streak ? Tn(sc.streak, '1-day streak', '{n}-day streak') : T('No streak yet')}${sc.streakBonus ? ` <span class="pill">+${sc.streakBonus}%</span>` : ''}${ice}</b><span class="muted small">${line}</span></span>
    <span class="pts"><b>${nf.format(sc.week)}</b><span class="muted small">${T('points this week')}</span></span>
  </button>`;
}

// --- Stuff
function kindPicker(name, current) {
  return `<div class="kinds" role="radiogroup" aria-label="${T('Type')}">${Object.entries(KINDS).map(([k, l]) =>
    `<input type="radio" name="${name}" id="${name}-${k}" value="${k}" ${k === current ? 'checked' : ''}><label for="${name}-${k}">${l}</label>`).join('')}</div>`;
}
function itemRow(i) {
  const meta = i.archived
    ? T('{kind}, {time} logged', { kind: KINDS[i.kind], time: hrs(i.minutes) })
    : snoozed(i) ? T('{kind}, snoozed until {date}', { kind: KINDS[i.kind], date: day(i.snoozed_until) })
    : `${KINDS[i.kind]}${i.steps_total ? T(', {done}/{total} steps', { done: i.steps_done, total: i.steps_total }) : ''}, ${ago(i.last_at)}, ${T('{n}% odds', { n: odds(i) })}`;
  return `<li class="${i.id === freshId ? 'fresh' : ''}" data-name="${esc(i.name.toLowerCase())}"><button class="item-row ${snoozed(i) ? 'snoozed' : ''}" data-act="item" data-id="${i.id}">
    <span class="dot" style="background:${i.archived || snoozed(i) ? 'var(--surface-2)' : colorOf(i)}"></span>
    <span class="main"><span class="name">${esc(i.name)}</span><span class="meta">${meta}</span></span>
    <span class="hrs">${i.minutes ? hrs(i.minutes) : ''}</span>
    <span class="chev">${ICON.chev}</span>
  </button></li>`;
}
let stuffSort = store.get('stuffSort', 'neglected');
const STUFF_SORTS = { neglected: 'Neglected', name: 'A–Z', time: 'Most time', added: 'Newest' };
function sortStuff(list) {
  const by = {
    neglected: (a, b) => (a.last_at || 0) - (b.last_at || 0),
    name: (a, b) => a.name.localeCompare(b.name, LOCALE),
    time: (a, b) => b.minutes - a.minutes,
    added: (a, b) => b.created_at - a.created_at,
  }[stuffSort] || (() => 0);
  return list.slice().sort((a, b) => (snoozed(a) - snoozed(b)) || by(a, b));
}
function viewStuff() {
  const list = sortStuff(active());
  const tools = list.length >= 6;
  const done = S.items.filter((i) => i.archived);
  return `
    <section class="section">
      <h2>${T('Add something you already have')}</h2>
      <form class="stack surface pad" data-form="add-item">
        <div class="row">
          <input class="input grow" name="name" placeholder="${T('Unfinished puzzle, Elden Ring, guitar…')}" maxlength="60" required aria-label="${T('Name')}">
          <button class="btn primary">${T('Add')}</button>
        </div>
        ${kindPicker('kind', 'hobby')}
      </form>
    </section>
    <section class="section">
      <div class="section-head"><h2>${T('On the wheel')}</h2><span class="muted small">${Tn(list.length, '1 thing', '{n} things')}</span></div>
      ${tools ? `<div class="stuff-tools">
        <input class="input" id="stuff-search" type="search" placeholder="${T('Search your stuff')}" aria-label="${T('Search your stuff')}" autocomplete="off">
        <div class="filters" role="group" aria-label="${T('Sort')}">${Object.entries(STUFF_SORTS).map(([k, l]) =>
          `<button class="fchip" data-act="stuff-sort" data-v="${k}" aria-pressed="${k === stuffSort}">${T(l)}</button>`).join('')}</div>
      </div>` : ''}
      ${list.length
        ? `<ul class="list" id="stuff-list">${list.map(itemRow).join('')}</ul>
           <p class="muted" id="stuff-none" hidden>${T('Nothing matches that search.')}</p>
           <p class="hint">${T('Things you haven’t touched in a while get a bigger slice, up to three times bigger after four weeks.')}</p>`
        : `<p class="muted">${T('Nothing here yet. Start with whatever is gathering dust closest to you.')}</p>`}
    </section>
    ${done.length ? `<details class="more section"><summary>${T('Done or retired ({n})', { n: done.length })}</summary>
      <ul class="list">${done.map(itemRow).join('')}</ul></details>` : ''}`;
}

// --- Shop
function viewShop() {
  const b = S.bank;
  const toGo = b.costMinutes - b.progressMinutes;
  const wishes = S.wishes.filter((w) => !w.bought_at);
  const costH = round1(b.costMinutes / 60);
  return `
    <section class="unlock-card surface ${b.unlocks ? 'ready' : ''}">
      ${b.unlocks
        ? `<div><div class="big">${b.unlocks}</div><p><b>${b.unlocks > 1 ? T('new buys unlocked') : T('new buy unlocked')}</b></p></div>
           <p class="muted">${T('You earned it. Pick something from your list, or log what you bought.')}</p>`
        : `<div><div class="big">${hrs(toGo)}</div><p><b>${T('to go until your next buy')}</b></p></div>`}
      ${meter(b)}
      <p class="muted small">${T('Every {h} h you spend on stuff you already own unlocks one new purchase.', { h: costH })}</p>
    </section>
    <section class="section">
      <h2>${T('Wishlist')}</h2>
      <form class="row surface pad" data-form="add-wish">
        <input class="input grow" name="name" placeholder="${T('What are you craving?')}" maxlength="80" required aria-label="${T('Wish')}">
        <input class="input" name="price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${currencySign()}" aria-label="${T('Price')}" style="width:84px">
        <button class="btn primary">${T('Add')}</button>
      </form>
      ${wishes.length ? `<ul class="list">${wishes.map((w) => `<li><div class="plain-row">
          <div class="main"><div class="name">${esc(w.name)}</div>
            <div class="muted small">${w.price != null ? money(w.price) + ', ' : ''}${listedFor(w.created_at)}</div></div>
          <button class="btn small ${b.unlocks ? 'primary' : ''}" data-act="buy" data-id="${w.id}" ${b.unlocks ? '' : 'disabled'}>${b.unlocks ? T('Buy it') : T('Locked')}</button>
          <button class="icon-btn" data-act="wish-del" data-id="${w.id}" aria-label="${T('Remove {name}', { name: esc(w.name) })}">${ICON.x}</button>
        </div></li>`).join('')}</ul>
        <p class="hint">${T('Still want it after a few weeks? Then it’s probably worth it.')}</p>`
      : `<p class="muted">${T('Park the things you want here instead of in a shopping cart.')}</p>`}
      ${b.unlocks ? `<button class="btn block" data-act="buy-other">${T('I bought something else')}</button>` : ''}
    </section>
    ${S.purchases.length ? `<section class="section"><h2>${T('Bought')}</h2><ul class="list">
      ${S.purchases.map((p) => `<li><div class="plain-row">
        <div class="main"><div class="name">${esc(p.name)}</div><div class="muted small">${T('{date}, earned with {time}', { date: day(p.created_at), time: hrs(p.cost_minutes) })}</div></div>
        <button class="icon-btn" data-act="purchase-del" data-id="${p.id}" aria-label="${T('Undo purchase of {name}', { name: esc(p.name) })}">${ICON.x}</button>
      </div></li>`).join('')}</ul></section>` : ''}`;
}

// --- Friends & leaderboard
let F = null, friendsLoadedAt = 0, boardPeriod = store.get('board', 'week');
const PERIODS = [['week', T('This week')], ['month', T('This month')], ['all', T('All time')]];
// Each person keeps one colour everywhere: their place in the alphabetical list of you + friends.
const avatarColor = (name) => {
  const people = F ? [S.user.username, ...F.friends].sort((a, b) => a.localeCompare(b)) : [];
  const i = people.indexOf(name);
  return INKS[(i >= 0 ? i : [...name].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)) % INKS.length];
};
const avatar = (name) => `<span class="avatar" style="background:${avatarColor(name)}">${esc(name.slice(0, 1).toUpperCase())}</span>`;

async function loadFriends(force = false) {
  if (!force && Date.now() - friendsLoadedAt < 4000) return;
  friendsLoadedAt = Date.now();
  try {
    F = await api('GET', '/api/friends');
    if (S) S.friendRequests = F.incoming.length;
    if (view === 'friends' && $('#view')) { $('#view').innerHTML = viewFriends(); afterFriendsRender(); }
  } catch { /* shown on next try */ }
}
// --- Weekly challenge
const CHALLENGE_TEXT = {
  rediscover: ['Rediscover week', 'Most time on things you hadn’t touched for 2 weeks or more'],
  variety: ['Variety week', 'Most different things, 15 minutes or more each'],
  days: ['Every day counts', 'Most days with 15 minutes or more'],
  focus: ['Deep focus week', 'Longest single session with the live timer'],
  projects: ['Project week', 'Most time on projects'],
  live: ['Timer week', 'Most time with the live timer'],
};
function challengeValue(c, v) {
  if (c.unit === 'minutes') return hm(v);
  return c.key === 'days' ? Tn(v, '1 day', '{n} days') : Tn(v, '1 thing', '{n} things');
}
function challengeCard() {
  const c = F && F.challenge; if (!c) return '';
  const [title, desc] = CHALLENGE_TEXT[c.key] || ['Weekly challenge', ''];
  const daysLeft = Math.max(1, Math.ceil((c.ends - now()) / 86400000));
  const solo = c.standings.length < 2;
  const top = Math.max(1, ...c.standings.map((x) => x.value));
  return `<section class="challenge surface">
    <div class="challenge-head"><span class="trophy">${ICON.trophy}</span>
      <div class="main"><span class="muted small">${T('This week’s challenge')}</span><b>${T(title)}</b></div>
      <span class="muted small">${daysLeft === 1 ? T('ends today') : T('{n} days left', { n: daysLeft })}</span></div>
    <p class="muted">${T(desc)}. ${T('The winner gets +{n} points.', { n: nf.format(c.points) })}</p>
    ${solo ? `<p class="hint">${T('Add a friend to play: it’s you against your friends.')}</p>`
      : !c.standings.some((x) => x.value) ? `<p class="hint">${T('Nobody’s on the board yet. Be the first.')}</p>`
      : `<ol class="challenge-list">${c.standings.slice(0, 5).map((x, i) => `<li class="${x.you ? 'me' : ''}">
          <span class="rank">${i + 1}</span><span class="name">${x.you ? T('You') : esc(x.username)}</span>
          <span class="bar"><span style="width:${(x.value / top) * 100}%"></span></span><b>${esc(challengeValue(c, x.value))}</b></li>`).join('')}</ol>`}
    ${c.wins ? `<p class="muted small">${Tn(c.wins, 'You’ve won 1 weekly challenge.', 'You’ve won {n} weekly challenges.')}</p>` : ''}
  </section>`;
}

function viewFriends() {
  if (!F) return `<section class="surface pad"><p class="muted">${T('Loading the leaderboard…')}</p></section>`;
  const board = F.board[boardPeriod] || [];
  const me = board.find((e) => e.you) || { points: 0, rank: 1 };
  const sc = S.score;
  const hasFriends = F.friends.length > 0;
  return `
    <section class="hero surface">
      <div class="hero-top">
        <div><p class="muted small">${PERIODS.find((p) => p[0] === boardPeriod)[1]}</p>
          <div class="hero-num" id="hero-num" data-to="${me.points}">${nf.format(me.points)}</div>
          <p class="muted small">${T('points')}</p></div>
        <div class="hero-rank">${hasFriends ? `<span class="rank-big">#${me.rank}</span><span class="muted small">${T('of {n}', { n: board.length })}</span><span id="rank-move"></span>` : ''}</div>
      </div>
      <div class="hero-stats">
        <span><span class="flame ${sc.streak ? 'lit' : ''}">${ICON.flame}</span>${Tn(sc.streak, '<b>1</b> day streak', '<b>{n}</b> day streak')}</span>
        <span>${T('<b>{pct}</b> streak bonus', { pct: `+${sc.streakBonus || 0}%` })}</span>
        ${sc.nextMilestone ? `<span>${T('<b>+{points}</b> at {days} days', { points: nf.format(sc.nextMilestone.points), days: sc.nextMilestone.days })}</span>` : ''}
        <span><span class="mini-ice">${ICON.snow}</span>${T('<b>{n}</b> of {max} freezes', { n: sc.freezes || 0, max: sc.freezeMax || 2 })}</span>
      </div>
    </section>

    ${challengeCard()}
    ${F.incoming.length ? `<section class="section"><h2>${T('Friend requests')}</h2><ul class="list">${F.incoming.map((r) => `<li><div class="plain-row">
        ${avatar(r.username)}<div class="main"><div class="name">${esc(r.username)}</div><div class="muted small">${T('wants to be friends')}</div></div>
        <button class="btn small primary" data-act="friend-accept" data-name="${esc(r.username)}">${T('Accept')}</button>
        <button class="icon-btn" data-act="friend-decline" data-name="${esc(r.username)}" aria-label="${T('Decline {name}', { name: esc(r.username) })}">${ICON.x}</button>
      </div></li>`).join('')}</ul></section>` : ''}

    <section class="section">
      <div class="seg" role="tablist" aria-label="${T('Leaderboard period')}">${PERIODS.map(([k, l]) => `<button role="tab" aria-selected="${k === boardPeriod}" data-act="board" data-v="${k}">${l}</button>`).join('')}</div>
      ${hasFriends ? `<ol class="board">${board.map((e) => `<li class="${e.atRisk ? 'with-nudge' : ''}">
          <button class="board-row ${e.you ? 'me' : ''}" ${e.you ? 'disabled' : `data-act="friend" data-name="${esc(e.username)}"`}>
            <span class="rank r${e.rank}">${e.rank}</span>
            ${avatar(e.username)}
            <span class="main"><span class="name">${e.you ? T('You') : esc(e.username)}</span>
              <span class="muted small">${hm(e.minutes)}${e.streak ? ` <span class="mini-flame">${ICON.flame}</span>${e.streak}` : ''}</span></span>
            <b class="score">${nf.format(e.points)}</b>
          </button>
          ${e.atRisk ? `<button class="nudge-btn" data-act="nudge" data-name="${esc(e.username)}" ${e.nudged ? 'disabled' : ''} aria-label="${esc(T('Nudge {name}: their streak needs today’s minutes', { name: e.username }))}">${ICON.bell}<span>${e.nudged ? T('Nudged') : T('Nudge')}</span></button>` : ''}
          </li>`).join('')}</ol>
        ${board.some((e) => e.atRisk && !e.nudged) ? `<p class="hint">${T('A bell means their streak still needs today’s 15 minutes. A nudge reminds them.')}</p>` : ''}`
      : `<div class="empty surface"><h2>${T('Better with friends')}</h2><p class="muted">${T('Add someone by their username and see who spends the most time on what they already own.')}</p></div>`}
    </section>

    ${F.feed && F.feed.length ? `<section class="section"><h2>${T('Friends’ moments')}</h2><ul class="list">${F.feed.map((e) => `<li><div class="plain-row">
        ${avatar(e.username)}
        <div class="main"><div class="name">${e.you ? T('You') : esc(e.username)} <span class="feed-text">${esc(TS(e.text))}</span></div><div class="muted small">${esc(seenAgo(e.at))}</div></div>
        ${e.you ? (e.fives ? `<span class="fives">${ICON.hand}${e.fives}</span>` : '')
          : `<button class="five ${e.fived ? 'on' : ''}" data-act="high-five" data-id="${e.id}" ${e.fived ? 'disabled' : ''} aria-label="${T('High-five {name}', { name: esc(e.username) })}">${ICON.hand}${e.fives ? `<span>${e.fives}</span>` : ''}</button>`}
      </div></li>`).join('')}</ul></section>` : ''}

    <section class="section">
      <h2>${T('Add a friend')}</h2>
      <form class="row surface pad" data-form="add-friend">
        <input class="input grow" name="username" placeholder="${T('Their username')}" autocapitalize="none" spellcheck="false" maxlength="32" required aria-label="${T('Username')}">
        <button class="btn primary">${T('Add')}</button>
      </form>
      ${F.outgoing.length ? `<ul class="list">${F.outgoing.map((r) => `<li><div class="plain-row">
          ${avatar(r.username)}<div class="main"><div class="name">${esc(r.username)}</div><div class="muted small">${T('waiting for them to accept')}</div></div>
          <button class="btn small" data-act="friend-cancel" data-name="${esc(r.username)}">${T('Cancel')}</button></div></li>`).join('')}</ul>` : ''}
      <p class="hint">${T('Friends see your points, hours and streak. Not what you do or what’s on your wishlist.')}</p>
    </section>

    <details class="more section">
      <summary>${T('How points work')}</summary>
      <div class="surface pad stack how">
        <p>${T('<b>10 points per minute</b>, times your multiplier. Every bonus that applies adds to it:')}</p>
        <ul>
          <li>${T('<b>Streak</b>: +10% for every day in a row you’ve done 15+ minutes, up to +100%')}</li>
          <li>${T('<b>Rediscovered</b>: +50% for something untouched for 2 weeks, +100% after a month')}</li>
          <li>${T('<b>Wheel’s pick</b>: +25% when you start the timer straight from a spin')}</li>
          <li>${T('<b>Live timer</b>: +20% for timed sessions')}</li>
          <li>${T('<b>Focus</b>: +20% for an hour or more in one go, +40% for two')}</li>
        </ul>
        <p>${T('<b>Streak freezes</b>: every 7 days in a row earns one, and you can hold 2. Miss a day and a freeze is used up for you, so the streak survives.')}</p>
        <p>${T('<b>Bonuses</b>: streak milestones at 3, 7, 14, 30, 60, 100 and 365 days, and 1,000 points for finishing a project you’ve put 2+ hours into.')}</p>
        <p class="muted small">${T('Fair play: up to 8 hours a day earn points, and time added more than 2 days later doesn’t.')}</p>
      </div>
    </details>`;
}
const seenAgo = (ts) => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 60) return m <= 1 ? T('just now') : T('{n} minutes ago', { n: m });
  const h = Math.floor(m / 60); if (h < 24) return Tn(h, '1 hour ago', '{n} hours ago');
  const d = Math.floor(h / 24); return d === 1 ? T('yesterday') : T('{n} days ago', { n: d });
};
function afterFriendsRender() {
  // count your score up from what you saw last time, and show rank changes
  const el = $('#hero-num'); if (!el) return;
  const to = Number(el.dataset.to);
  const key = `seen.${boardPeriod}.${boardPeriod === 'week' ? S.score.weekStart : boardPeriod === 'month' ? new Date().getMonth() : 'all'}`;
  const seen = store.get(key, { points: 0, rank: null });
  const from = Math.min(seen.points || 0, to);
  const board = F.board[boardPeriod] || []; const me = board.find((e) => e.you);
  if (me && seen.rank && me.rank < seen.rank && F.friends.length) {
    const m = $('#rank-move'); if (m) { m.className = 'rank-up'; m.textContent = `▲ ${seen.rank - me.rank}`; }
    SFX.rankUp(); FX.burstFrom($('.rank-big'), { n: 18 });
  }
  store.set(key, { points: to, rank: me ? me.rank : null });
  if (from === to || reducedMotion.matches) return;
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = nf.format(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function friendSheet(name) {
  const get = (p) => (F.board[p] || []).find((e) => e.username === name) || { points: 0, minutes: 0, rank: '-' };
  const w = get('week'), m = get('month'), a = get('all');
  openSheet(`<div class="sheet-head"><div class="row">${avatar(name)}<h2>${esc(name)}</h2></div><button class="icon-btn" data-act="close" aria-label="${T('Close')}">${ICON.x}</button></div>
    <div class="tiles">
      <div class="tile"><div class="v">${nf.format(w.points)}</div><div class="k">${T('this week, #{rank}', { rank: w.rank })}</div></div>
      <div class="tile"><div class="v">${nf.format(m.points)}</div><div class="k">${T('this month')}</div></div>
      <div class="tile"><div class="v">${nf.format(a.points)}</div><div class="k">${T('all time')}</div></div>
    </div>
    <p><span class="mini-flame">${ICON.flame}</span> ${w.streak ? Tn(w.streak, '1-day streak', '{n}-day streak') : T('No streak right now')}, ${T('{time} this week.', { time: hm(w.minutes) })}</p>
    <button class="btn danger" data-act="friend-remove" data-name="${esc(name)}">${T('Remove friend')}</button>`);
}

// --- Achievements
let A = null, achLoadedAt = 0;
const CAT_ICON = { wheel: 'spin', time: 'clock', streak: 'flame', money: 'coin', social: 'hand', project: 'check', rediscover: 'spark', points: 'star', legendary: 'crown' };
const TIER_NAME = { bronze: T('Bronze'), silver: T('Silver'), gold: T('Gold'), legendary: T('Legendary') };
const badge = (a, big = false) => `<span class="badge t-${a.tier} ${a.unlockedAt === null ? 'locked' : ''} ${big ? 'big' : ''}">${ICON[CAT_ICON[a.cat]] || ICON.star}</span>`;
async function loadAchievements(force = false) {
  if (!force && Date.now() - achLoadedAt < 5000) return;
  achLoadedAt = Date.now();
  try {
    A = (await api('GET', '/api/achievements')).achievements;
    const el = $('#ach'); if (el) el.innerHTML = achievementsBlock();
  } catch { /* try again later */ }
}
function achievementsBlock() {
  if (!A) return `<p class="hint">${T('Loading achievements…')}</p>`;
  const got = A.filter((a) => a.unlockedAt).length;
  const normal = A.filter((a) => a.tier !== 'legendary'), legend = A.filter((a) => a.tier === 'legendary');
  const cell = (a) => `<button class="ach" data-act="badge" data-key="${a.key}">${badge(a)}<span class="ach-name">${esc(T(a.name))}</span>
      ${a.unlockedAt ? '' : `<span class="ach-bar"><span style="width:${Math.round(a.progress * 100)}%"></span></span>`}</button>`;
  return `<div class="section-head"><h2>${T('Achievements')}</h2><span class="muted small">${T('{a} of {b}', { a: got, b: A.length })}</span></div>
    <div class="meter-track"><div class="meter-fill" style="width:${(got / A.length) * 100}%"></div></div>
    <div class="ach-grid surface">${normal.sort((x, y) => (!!y.unlockedAt - !!x.unlockedAt)).map(cell).join('')}</div>
    <div class="legend surface">
      <div class="legend-head">${ICON.crown}<div><b>${T('Legendary')}</b><span>${T('Absurdly hard on purpose. 10,000 points each.')}</span></div></div>
      <div class="ach-grid">${legend.map(cell).join('')}</div>
    </div>`;
}
function badgeSheet(key) {
  const a = A && A.find((x) => x.key === key); if (!a) return;
  const fmt = (n) => (Number.isInteger(n) ? nf.format(n) : nf1.format(n));
  openSheet(`${sheetHead('')}
    <div class="badge-detail">${badge(a, true)}
      <span class="tier-label t-${a.tier}">${T('{tier}, {points} points', { tier: TIER_NAME[a.tier], points: nf.format(a.points) })}</span>
      <h2>${esc(T(a.name))}</h2><p class="muted">${esc(T(a.desc))}</p>
      ${a.unlockedAt ? `<p><b>${T('Unlocked {date}', { date: esc(day(a.unlockedAt)) })}</b></p>`
        : `<div class="meter" style="max-width:280px"><div class="meter-track"><div class="meter-fill" style="width:${Math.round(a.progress * 100)}%"></div></div>
           <span class="muted small" style="text-align:center">${a.key === 'the-monk' ? `${Math.round(a.progress * 100)}%` : T('{a} of {b}', { a: fmt(a.current), b: fmt(a.goal) })}</span></div>`}
    </div>`);
}
function showAchievements(list) {
  if (!list.length) return;
  SFX.fanfare(); buzz([20, 60, 20, 60, 40]);
  if (list.length === 1) {
    const a = list[0];
    openSheet(`${sheetHead(T('Achievement unlocked'))}
      <div class="badge-detail pop">${badge({ ...a, unlockedAt: 1 }, true)}
        <span class="tier-label t-${a.tier}">${TIER_NAME[a.tier]}</span>
        <h2>${esc(T(a.name))}</h2><p class="muted">${esc(T(a.desc))}</p>
        <p class="ach-points">${T('+{n} points', { n: nf.format(a.points) })}</p></div>
      <button class="btn primary block" data-act="close">${T('Nice')}</button>`);
  } else {
    const total = list.reduce((x, a) => x + a.points, 0);
    openSheet(`${sheetHead(T('{n} achievements unlocked', { n: list.length }))}
      <ul class="list">${list.map((a) => `<li><div class="plain-row">${badge({ ...a, unlockedAt: 1 })}<div class="main"><div class="name">${esc(T(a.name))}</div><div class="muted small">${esc(T(a.desc))}</div></div><b>+${nf.format(a.points)}</b></div></li>`).join('')}</ul>
      <p class="ach-points">${T('+{n} points', { n: nf.format(total) })}</p>
      <button class="btn primary block" data-act="close">${T('Nice')}</button>`);
  }
  FX.cannons(list.some((a) => a.tier === 'legendary') ? 260 : 120);
  achLoadedAt = 0;
}

// --- Weekly recap
async function recapSheet(auto = false) {
  let r;
  try { r = await api('GET', '/api/recap'); } catch (e) { if (!auto) toast(e.message); return; }
  store.set(`recap.${r.start}`, true);
  if (auto && !r.minutes) return;
  const range = T('{from} to {to}', { from: day(r.start), to: day(r.end - 1) });
  const delta = r.prevMinutes ? Math.round(((r.minutes - r.prevMinutes) / r.prevMinutes) * 100) : null;
  const topMax = r.top.length ? r.top[0].minutes : 1;
  const weekday = (ts) => new Date(ts).toLocaleDateString(LOCALE, { weekday: 'long' });
  openSheet(`${sheetHead(T('Your week'))}
    <p class="muted" style="margin-top:-10px">${esc(range)}</p>
    ${r.minutes ? `
    <div class="recap-hero">
      <div><span class="recap-num">${round1(r.minutes / 60)}</span><span class="recap-unit">${T('hours')}</span></div>
      ${delta !== null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${T('{n}% vs the week before', { n: Math.abs(delta) })}</span>` : `<span class="delta up">${T('Your first tracked week')}</span>`}
    </div>
    <div class="tiles">
      <div class="tile"><div class="v">${nf.format(r.points)}</div><div class="k">${T('points')}</div></div>
      <div class="tile"><div class="v">${r.sessions}</div><div class="k">${T('sessions')}</div></div>
      <div class="tile"><div class="v">${r.daysActive}/7</div><div class="k">${T('days active')}</div></div>
    </div>
    ${r.rank ? `<div class="recap-rank r${r.rank}">${ICON.friends}<span>${T('You finished <b>#{rank}</b> of {n} among your friends', { rank: r.rank, n: r.people })}${r.rank === 1 ? T('. Champion!') : ''}</span></div>` : ''}
    ${r.bestDay ? `<p>${T('Best day: <b>{day}</b>, {time}.', { day: esc(weekday(r.bestDay.day)), time: hm(r.bestDay.minutes) })}</p>` : ''}
    <div class="hbars surface" style="box-shadow:none;background:var(--bg)">${r.top.map((t) => `<div class="hbar"><span class="lbl">${esc(t.name)}</span><span class="val">${hm(t.minutes)}</span>
      <div class="track"><div class="fill" style="width:${(t.minutes / topMax) * 100}%"></div></div></div>`).join('')}</div>
    ${r.achievements.length ? `<div><h3 style="margin-bottom:8px">${T('Unlocked')}</h3><div class="chips">${r.achievements.map((a) => `<span class="chip t-${a.tier}">${esc(T(a.name))}</span>`).join('')}</div></div>` : ''}
    ${r.highFives || r.buys ? `<p class="muted">${r.highFives ? Tn(r.highFives, '1 high-five from friends. ', '{n} high-fives from friends. ') : ''}${r.buys ? Tn(r.buys, 'You bought 1 thing you earned.', 'You bought {n} things you earned.') : ''}</p>` : ''}`
    : `<div class="empty"><h2>${T('A quiet week')}</h2><p class="muted">${T('Nothing logged. This week is a fresh start: spin the wheel and pick something up.')}</p></div>`}
    <button class="btn primary block" data-act="close">${r.minutes ? T('Onwards') : T('Let’s go')}</button>`);
  if (r.minutes && r.rank === 1) FX.cannons(90);
  SFX.land();
}

// --- popups that appear by themselves wait their turn
const popupQueue = [];
function enqueue(fn) { popupQueue.push(fn); setTimeout(runQueue, 500); }
function runQueue() { if (!sheet.open && popupQueue.length) popupQueue.shift()(); }

// --- Stats
function weekStart(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function weeks() {
  const cur = weekStart(now());
  const out = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(cur); d.setDate(d.getDate() - i * 7);
    out.push({ start: d.getTime(), minutes: 0 });
  }
  for (const l of S.logs) {
    const ws = weekStart(l.ended_at);
    const w = out.find((x) => x.start === ws);
    if (w) w.minutes += l.minutes;
  }
  return out;
}
function viewStats() {
  const b = S.bank;
  const ws = weeks();
  const max = Math.max(60, ...ws.map((w) => w.minutes));
  if (selectedWeek == null || !ws[selectedWeek]) selectedWeek = ws.length - 1;
  const sel = ws[selectedWeek];
  const byItem = S.items.filter((i) => i.minutes > 0).sort((a, z) => z.minutes - a.minutes).slice(0, 10);
  const top = byItem[0]?.minutes || 1;
  return `
    ${S.user.monthlyGoal ? goalCard() : `<button class="version-btn" data-act="goal"><span class="main"><b>${T('Set a monthly goal')}</b><span class="muted small">${T('Pick how many hours you want each month')}</span></span><span class="chev">${ICON.chev}</span></button>`}
    <section class="tiles">
      <div class="tile surface"><div class="v">${round1(b.earnedMinutes / 60)}</div><div class="k">${T('hours total')}</div></div>
      <div class="tile surface"><div class="v">${round1(ws[ws.length - 1].minutes / 60)}</div><div class="k">${T('hours this week')}</div></div>
      <div class="tile surface"><div class="v">${b.purchasesCount}</div><div class="k">${T('buys earned and used')}</div></div>
      <div class="tile surface"><div class="v">${nf.format(S.score.week)}</div><div class="k">${T('points this week')}</div></div>
      <div class="tile surface"><div class="v">${nf.format(S.score.total)}</div><div class="k">${T('points all time')}</div></div>
      <div class="tile surface"><div class="v">${S.score.bestStreak}</div><div class="k">${T('longest streak, days')}</div></div>
    </section>

    <button class="version-btn" data-act="recap"><span class="main"><b>${T('Last week’s recap')}</b><span class="muted small">${T('Hours, points, best day and your rank')}</span></span><span class="chev">${ICON.chev}</span></button>
    <section class="section" id="ach">${achievementsBlock()}</section>
    <section class="section">
      <h2>${T('Hours per week')}</h2>
      <div class="surface chart">
      <p class="chart-caption" id="week-caption">${selectedWeek === ws.length - 1 ? T('This week') : T('Week of {date}', { date: day(sel.start) })}: <b>${hm(sel.minutes)}</b></p>
      <div>
        <div class="weeks">${ws.map((w, i) => `<button data-act="week" data-i="${i}" aria-pressed="${i === selectedWeek}" aria-label="${T('Week of {date}', { date: day(w.start) })}: ${hm(w.minutes)}">
          <span class="bar" style="height:${(w.minutes / max) * 100}%"></span></button>`).join('')}</div>
        <div class="weeks-axis" aria-hidden="true">${ws.map((w) => `<span>${day(w.start)}</span>`).join('')}</div>
      </div>
      </div>
    </section>

    ${byItem.length ? `<section class="section"><h2>${T('Where your time went')}</h2><div class="hbars surface">
      ${byItem.map((i) => `<div class="hbar"><span class="lbl">${esc(i.name)}</span><span class="val">${hrs(i.minutes)}</span>
        <div class="track"><div class="fill" style="width:${(i.minutes / top) * 100}%"></div></div></div>`).join('')}
    </div></section>` : ''}

    <section class="section">
      <h2>${T('Recent sessions')}</h2>
      ${S.logs.length ? `<ul class="list">${S.logs.slice(0, 20).map((l) => sessionRow(l, true)).join('')}</ul>`
      : `<p class="muted">${T('No sessions yet. Spin the wheel and start a timer.')}</p>`}
    </section>`;
}

// --- Auth
// Old invite links still work as plain links to the sign-up screen.
if (new URLSearchParams(location.search).has('invite')) history.replaceState(null, '', '/');
function renderAuth(mode, error = '') {
  // first visit on this browser: sign up; after that: sign in
  if (!mode) mode = config.firstUser || !store.get('hadAccount', false) ? 'register' : 'login';
  const reg = mode === 'register', reset = mode === 'reset';
  const first = reg && config.firstUser;
  const min = config.passwordMin || 10;
  const title = reg ? T('Create an account') : reset ? T('Reset your password') : T('Sign in');
  const formName = reg ? 'register' : reset ? 'reset' : 'login';
  $('#app').innerHTML = `
    <main class="auth">
      <div class="stack" style="gap:10px">
        <h1 class="logo">bored?</h1>
        <p class="tag">${T('Spin for something you already own. Spend some time on it. Earn the next new thing.')}</p>
      </div>
      <form class="stack surface auth-card" data-form="${formName}">
        <h2>${title}</h2>
        ${first ? `<p class="note">${T('You’re the first one here, so this account becomes the admin of the site.')}</p>` : ''}
        ${reset ? `<p class="hint">${T('Ask the admin for a reset code. It works once, for 24 hours.')}</p>` : ''}
        <div class="field"><label for="u">${T('Username')}</label>
          <input class="input" id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="${reg ? 3 : 1}" maxlength="32"></div>
        ${reset ? `<div class="field"><label for="rc">${T('Reset code')}</label>
          <input class="input" id="rc" name="code" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" required placeholder="xxxx-xxxx-xxxx"></div>` : ''}
        <div class="field"><label for="p">${reset ? T('New password') : T('Password')}</label>
          <input class="input" id="p" name="password" type="password" autocomplete="${reg || reset ? 'new-password' : 'current-password'}" required minlength="${reg || reset ? min : 1}" maxlength="256">
          ${reg || reset ? `<span class="hint">${T('At least {n} characters. A few random words, like “cactus lamp tuesday river”, is strong and easy to remember.', { n: min })}</span>` : ''}</div>
        <p class="form-error" id="auth-error">${esc(error)}</p>
        <button class="btn primary block">${reg ? T('Create account') : reset ? T('Set new password') : T('Sign in')}</button>
        ${reg ? `<p class="hint" style="text-align:center">${T('By signing up you agree to how your data is handled.')} <button type="button" class="auth-switch" data-act="privacy">${T('Read the privacy notice')}</button></p>` : ''}
      </form>
      <div class="stack" style="gap:6px;text-align:center">
        ${first ? '' : `<p class="muted">${reg ? T('Already have an account?') : reset ? T('Remembered it?') : T('New here?')}
          <button class="auth-switch" data-act="auth-mode" data-v="${reg || reset ? 'login' : 'register'}">${reg || reset ? T('Sign in') : T('Create an account')}</button></p>`}
        ${mode === 'login' ? `<p class="muted">${T('Forgot your password?')} <button class="auth-switch" data-act="auth-mode" data-v="reset">${T('Use a reset code')}</button></p>` : ''}
        <div class="auth-foot">${langSwitch()}<button class="auth-switch" data-act="privacy">${T('Privacy')}</button></div>
      </div>
    </main>`;
  $('#u').focus();
}

// Home screen shortcuts (long-press the icon on Android): /?go=spin, /?go=continue, /?go=log
function shortcut() {
  const go = new URLSearchParams(location.search).get('go');
  if (!go) return;
  history.replaceState(null, '', '/');
  if (go === 'spin') { view = 'spin'; render(); setTimeout(() => $('#hub')?.click(), 400); }
  else if (go === 'log') logSheet(S.logs[0]?.item_id);
  else if (go === 'continue') {
    const last = S.logs.find((l) => S.items.some((i) => i.id === l.item_id && !i.archived));
    if (S.timer) toast(T('Your timer is already running'));
    else if (last) api('POST', '/api/timer/start', { itemId: last.item_id }).then(() => { SFX.start(); toast(T('Timer started on {name}', { name: last.item_name })); }).catch((e) => toast(e.message));
    else toast(T('Spin the wheel first, then you can continue from here'));
  }
}

// --- Language
const langSwitch = () => `<div class="seg lang-seg" role="group" aria-label="${T('Language')}">${Object.entries(LANGS).map(([k, l]) =>
  `<button lang="${k}" aria-pressed="${k === LANG}" data-act="lang" data-v="${k}">${l}</button>`).join('')}</div>`;

// --- Privacy notice
function privacySheet() {
  const c = config.privacyContact;
  openSheet(`${sheetHead(T('Privacy'))}
    <div class="stack how privacy">
      <p>${T('bored? is a small, independent project. This is what it keeps about you, in plain words.')}</p>
      <h3>${T('What’s stored')}</h3>
      <p>${T('Your username and password, and what you add: your stuff, time, wishlist, purchases, friends, high-fives and achievements. Your password is only kept as a scrambled hash that can’t be turned back into the password.')}</p>
      <h3>${T('Who sees it')}</h3>
      <p>${T('You. Friends see your points, hours and streak, and moments like streaks and badges, never what you do or what’s on your wishlist. The admin sees usernames and when accounts were made and last used, to keep the site running, plus site-wide totals like visits per day, never who did what.')}</p>
      <h3>${T('Cookies')}</h3>
      <p>${T('Only the ones needed to keep you signed in and to recognise your devices. No ads, trackers or analytics. Your language and sound choices stay in your browser.')}</p>
      <h3>${T('Security')}</h3>
      <p>${T('To catch leaked passwords, a new password is checked against Have I Been Pwned: only the first 5 characters of a hash of it are sent, never the password itself. To stop attacks, the server briefly keeps network addresses and failed sign-ins, and lists your devices (like “Safari on iPhone”) in Settings.')}</p>
      <h3>${T('Where')}</h3>
      <p>${T('On a private server in Belgium, run by the admin of this site. Nothing is sold or shared.')}</p>
      <h3>${T('Your choices')}</h3>
      <p>${T('In Settings you can export everything as a file or delete your account at any time. Deleting removes it right away; copies in update backups disappear as newer backups replace them.')}</p>
      ${c ? `<p>${T('Questions or requests? Contact {contact}.', { contact: `<b>${esc(c)}</b>` })}</p>` : ''}
    </div>
    <button class="btn primary block" data-act="close">${T('Got it')}</button>`);
}

// --- Settings
// --- Personalise: every change saves straight away
const ACCENTS = { indigo: '#5457E0', teal: '#0F7C78', rose: '#C7345F', amber: '#A15F06', green: '#2F7D4F', plum: '#8B3FB5' };
function personaliseSheet() {
  const p = prefs();
  const seg = (key, opts) => `<div class="seg pref-seg" style="--n:${opts.length}" role="group">${opts.map(([v, l]) =>
    `<button data-act="pref" data-k="${key}" data-v="${v}" aria-pressed="${p[key] === v}">${l}</button>`).join('')}</div>`;
  const toggle = (key, label, hint = '') => `<label class="toggle"><input type="checkbox" data-pref="${key}" ${p[key] ? 'checked' : ''}><span class="track"></span><span>${label}${hint ? `<span class="hint" style="display:block">${hint}</span>` : ''}</span></label>`;
  const row = (label, control, hint = '') => `<div class="pref"><span>${label}</span>${control}${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
  openSheet(`${sheetHead(T('Personalise'))}
    <section class="pref-group"><h3>${T('Look')}</h3>
      ${p.skin !== 'none' ? `<p class="snooze-note">${T('A secret theme is on, so theme and colour are taking a break.')} <button class="auth-switch" data-act="skin" data-v="none">${T('Back to the normal look')}</button></p>` : ''}
      ${row(T('Theme'), seg('theme', [['system', T('Automatic')], ['light', T('Light')], ['dark', T('Dark')]]))}
      ${row(T('Colour'), `<div class="swatches" role="group" aria-label="${T('Colour')}">${Object.entries(ACCENTS).map(([k, c]) =>
        `<button class="swatch" style="--c:${c}" data-act="pref" data-k="accent" data-v="${k}" aria-pressed="${p.accent === k}" aria-label="${T(k[0].toUpperCase() + k.slice(1))}"></button>`).join('')}</div>`)}
      ${row(T('Text size'), seg('textSize', [['small', T('Small')], ['normal', T('Normal')], ['large', T('Large')]]))}
    </section>
    <section class="pref-group"><h3>${T('Sound and feel')}</h3>
      <div class="toggles">
        ${toggle('sound', T('Sounds'))}
        ${toggle('haptics', T('Vibration'), T('On phones that support it'))}
        ${toggle('confetti', T('Confetti and sparkles'))}
        ${toggle('wakeLock', T('Keep the screen on while a timer runs'))}
        ${toggle('tabTitle', T('Show the timer in the browser tab'))}
      </div>
      ${row(T('Spin length'), seg('spin', [['quick', T('Quick')], ['normal', T('Normal')], ['dramatic', T('Dramatic')]]))}
    </section>
    <section class="pref-group"><h3>${T('The wheel')}</h3>
      ${row(T('Neglect boost'), seg('neglect', [['off', T('Off')], ['gentle', T('Gentle')], ['normal', T('Normal')], ['strong', T('Strong')]]),
        T('How much bigger a slice gets when you haven’t touched something for a while. Off gives every thing the same chance.'))}
      <div class="toggles">${toggle('autoTimer', T('Start the timer as soon as the wheel picks'), T('Skips the result screen. You still get the wheel’s pick bonus.'))}</div>
    </section>
    <section class="pref-group"><h3>${T('Numbers')}</h3>
      ${row(T('Currency'), seg('currency', [['EUR', '€'], ['USD', '$'], ['GBP', '£']]))}
      ${row(T('Hours'), seg('timeFormat', [['decimal', T('{h} h', { h: round1(1.5) })], ['hm', T('{h} h {m} min', { h: 1, m: 30 })]]))}
    </section>
    <section class="pref-group"><h3>${T('Friends and privacy')}</h3>
      <div class="toggles">
        ${toggle('private', T('Private mode'), T('Friends no longer see you on their leaderboard, in their feed or in challenges. You still see them.'))}
        ${toggle('shareMoments', T('Share my moments'), T('Streaks, badges and challenge wins in your friends’ feed.'))}
        ${toggle('allowNudges', T('Friends can nudge me'))}
        ${toggle('popups', T('Weekly recap and badge popups'), T('Badges still unlock and the recap stays under Stats.'))}
      </div>
    </section>
    <button class="btn block" data-act="settings">${T('Back to settings')}</button>
    <section class="secret" aria-label="${T('Secret themes')}">
      <p class="muted small">${T('You scrolled all the way down. Here’s something most people never find.')}</p>
      <h3>${T('Secret themes')}</h3>
      <div class="skin-cards">
        <button class="skin-card" data-act="skin" data-v="walnut" aria-pressed="${p.skin === 'walnut'}"><span class="skin-prev walnut"><i></i></span>
          <b class="walnut-name">${T('Walnut')}</b><span class="muted small">${T('Real wood, brass and paper. Very serious.')}</span></button>
        <button class="skin-card" data-act="skin" data-v="doodle" aria-pressed="${p.skin === 'doodle'}"><span class="skin-prev doodle"><i></i></span>
          <b class="doodle-name">${T('Doodle')}</b><span class="muted small">${T('Felt-tips on notebook paper. Not serious at all.')}</span></button>
      </div>
      ${p.skin !== 'none' ? `<button class="btn ghost block" data-act="skin" data-v="none">${T('Back to the normal look')}</button>` : ''}
    </section>`);
}
async function setPref(key, value) {
  const before = prefs()[key];
  S.user.prefs = { ...prefs(), [key]: value }; store.set('prefs', S.user.prefs); applyLook(S.user.prefs);
  if (key === 'wakeLock' || key === 'tabTitle') tickTimer();
  if (key === 'skin') render();
  try { await api('PATCH', '/api/settings', { prefs: { [key]: value } }); }
  catch (e) { S.user.prefs = { ...prefs(), [key]: before }; applyLook(); toast(e.message); }
}

// --- Tutorial: a few cards for new people, replayable from Settings
function tourSheet(step = 0) {
  const steps = [
    [ICON.spin, 'Welcome to bored?', 'Got hobbies, games and projects gathering dust? bored? helps you enjoy what you already own before buying more.'],
    [ICON.stuff, 'Add what you already have', 'Put your hobbies, games and half-finished projects on the wheel. Things you haven’t touched in a while get bigger slices.'],
    [ICON.clock, 'Spin, then do it', 'Spin the wheel, start the timer and get going. Every minute earns points, with bonuses for streaks, focus and dusting things off.'],
    [ICON.shop, 'Earn your next buy', 'Every {h} hours on your own stuff unlocks one new purchase. Until then, park what you want on your wishlist.'],
    [ICON.friends, 'Better with friends', 'Add friends to compare points, play the weekly challenge and keep each other’s streaks going.'],
  ];
  const [icon, title, text] = steps[step];
  const last = step === steps.length - 1;
  openSheet(`<div class="tour">
      <div class="tour-art">${icon}</div>
      <h2>${T(title)}</h2>
      <p>${T(text, { h: round1(S.user.hoursPerUnlock) })}</p>
      <div class="tour-dots" aria-label="${esc(T('Step {a} of {b}', { a: step + 1, b: steps.length }))}">${steps.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>
      <div class="tour-actions">
        ${last ? '' : `<button class="btn" data-act="tour-end">${T('Skip')}</button>`}
        <button class="btn primary" data-act="${last ? 'tour-end' : 'tour'}" data-v="${step + 1}" ${last ? 'data-start="1"' : ''}>${last ? T('Add my first thing') : T('Next')}</button>
      </div>
    </div>`);
}

function settingsSheet() {
  const u = S.user;
  openSheet(`${sheetHead(T('Settings'))}
    <button class="version-btn" data-act="personalise">
      <span class="main"><b>${T('Personalise')}</b><span class="muted small">${T('Theme, colour, sounds, the wheel and privacy')}</span></span>
      <span class="chev">${ICON.chev}</span>
    </button>
    <form class="stack" data-form="settings">
      <h3>${T('Hours per new purchase')}</h3>
      <div class="row"><input class="input" id="hpu" name="hours" type="number" min="1" max="500" step="0.25" value="${u.hoursPerUnlock}" aria-label="${T('Hours per new purchase')}" style="width:110px"><button class="btn">${T('Save')}</button></div>
      <p class="hint">${T('The default is 20 h. That’s roughly what it takes to get past the clumsy beginner stage of a skill (Josh Kaufman’s 20-hour rule), so you actually enjoy what you own before buying more. At a few hours a week it also adds a 3 to 6 week cooling-off period, longer than the popular 30-day rule against impulse buys.')}</p>
    </form>
    <div class="sheet-section">
      <h3>${T('Language')}</h3>
      ${langSwitch()}
    </div>
    ${u.isAdmin ? `<div class="sheet-section"><div class="section-head"><h3>${T('People')}</h3><span class="muted small">${Tn(u.userCount, '1 account', '{n} accounts')}</span></div><div id="people"><p class="hint">${T('Loading…')}</p></div>
      <button class="version-btn" data-act="stats" style="margin-top:12px">
        <span class="main"><b>${T('Site stats')}</b><span class="muted small">${T('Accounts, hours, points and traffic')}</span></span>
        <span class="chev">${ICON.chev}</span>
      </button></div>` : ''}
    <div class="sheet-section">
      <h3>${T('Signed-in devices')}</h3>
      <div id="devices"><p class="hint">${T('Loading…')}</p></div>
    </div>
    <div class="sheet-section">
      <h3>${T('Account')}</h3>
      <div class="row wrap">
        <a class="btn small" href="/api/export" download>${T('Export my data')}</a>
        <button class="btn small" data-act="password">${T('Change password')}</button>
      </div>
      <div class="row wrap">
        <button class="btn small" data-act="logout">${T('Sign out {name}', { name: esc(u.username) })}</button>
        ${u.isAdmin ? '' : `<button class="btn small danger" data-act="account-del">${T('Delete account')}</button>`}
      </div>
    </div>
    <div class="stack" style="gap:8px">
      <button class="version-btn" data-act="whats-new">
        <span class="main"><b>${T('What’s new')}</b><span class="muted small">${T('You’re on version {v}', { v: esc(config.release || '?') })}</span></span>
        <span class="chev">${ICON.chev}</span>
      </button>
      <button class="version-btn" data-act="tour">
        <span class="main"><b>${T('Show the tutorial again')}</b><span class="muted small">${T('A quick tour of how bored? works')}</span></span>
        <span class="chev">${ICON.chev}</span>
      </button>
      <button class="version-btn" data-act="privacy">
        <span class="main"><b>${T('Privacy')}</b><span class="muted small">${T('What’s stored and who sees it')}</span></span>
        <span class="chev">${ICON.chev}</span>
      </button>
    </div>`);
  loadDevices();
  if (u.isAdmin) loadPeople();
}

const seen = (ts) => {
  if (!ts) return T('never signed in');
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 15) return T('active now');
  if (m < 60 * 24) return T('active today');
  const d = Math.floor(m / 1440);
  return d === 1 ? T('active yesterday') : T('active {n} days ago', { n: d });
};
async function loadDevices() {
  try {
    const { sessions } = await api('GET', '/api/sessions');
    const el = $('#devices', sheet); if (!el) return;
    const others = sessions.filter((x) => !x.current).length;
    el.innerHTML = `<ul class="list">${sessions.map((x) => `<li><div class="plain-row">
        <div class="main"><div class="name">${esc(TS(x.device))}</div>
          <div class="muted small">${x.current ? T('This device') : x.createdAt ? T('{seen}, signed in {date}', { seen: seen(x.lastSeen), date: esc(day(x.createdAt)) }) : seen(x.lastSeen)}</div></div>
        ${x.current ? '' : `<button class="btn small" data-act="session-revoke" data-id="${esc(x.id)}">${T('Sign out')}</button>`}
      </div></li>`).join('')}</ul>
      ${others ? `<button class="btn ghost" data-act="sessions-others">${T('Sign out all other devices')}</button>` : ''}
      <p class="hint">${T('Logins end after 30 days without use. Changing your password signs out every other device.')}</p>`;
  } catch (e) { const el = $('#devices', sheet); if (el) el.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
}
async function loadPeople() {
  try {
    const { users } = await api('GET', '/api/admin/users');
    const el = $('#people', sheet); if (!el) return;
    el.innerHTML = `<ul class="list">${users.map((x) => `<li><div class="plain-row">
        <div class="main"><div class="name">${esc(x.username)}${x.you ? T(' (you)') : ''}</div>
          <div class="muted small">${T('{seen}, joined {date}', { seen: seen(x.lastSeen), date: esc(day(x.createdAt)) })}${x.resetPending ? T(', reset code waiting') : ''}</div></div>
        ${x.you ? '' : `<button class="btn small" data-act="user-reset" data-id="${x.id}" data-name="${esc(x.username)}">${T('Reset')}</button>
          <button class="icon-btn" data-act="user-remove" data-id="${x.id}" data-name="${esc(x.username)}" aria-label="${T('Remove {name}', { name: esc(x.username) })}">${ICON.x}</button>`}
      </div></li>`).join('')}</ul>
      <p class="hint">${T('Forgot their password? Reset gives you a one-time code to send them. It works for 24 hours.')}</p>`;
  } catch (e) { const el = $('#people', sheet); if (el) el.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
}

// --- Site stats (admin only): totals, a few day-by-day charts, and the same numbers as a table
let statsDays = store.get('statsDays', 30), STATS = null;
const STAT_CHARTS = [
  ['minutes', 'Hours logged per day'],
  ['active', 'People active per day'],
  ['page_views', 'Page views per day'],
  ['signups', 'New accounts per day'],
];
const statVal = (key, v) => (key === 'minutes' ? hm(v) : nf.format(v));
const statDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
function statCaption(key, i) {
  const d = STATS.daily[i];
  return `${i === STATS.daily.length - 1 ? T('Today') : esc(statDay(d.day))}: <b>${esc(statVal(key, d[key]))}</b>`;
}
function selectStatBar(btn) {
  const box = btn.closest('.stat-chart'); if (!box || !STATS) return;
  box.querySelectorAll('[data-act="stat-bar"]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  $('.chart-caption', box).innerHTML = statCaption(box.dataset.key, Number(btn.dataset.i));
}
async function statsSheet(days = statsDays) {
  let r;
  try { r = await api('GET', `/api/admin/stats?days=${days}`); } catch (e) { toast(e.message); return; }
  STATS = r; statsDays = r.days; store.set('statsDays', r.days);
  const t = r.totals, p = r.period, n = r.daily.length, last = n - 1;
  const tile = (v, k) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  const chart = ([key, title]) => {
    const max = Math.max(1, ...r.daily.map((d) => d[key]));
    const peak = Math.max(...r.daily.map((d) => d[key]));
    const side = key === 'active' ? T('busiest day: {n}', { n: nf.format(peak) }) : T('total: {n}', { n: statVal(key, p[key]) });
    return `<section class="stat-chart stack" data-key="${key}">
      <div class="section-head"><h3>${T(title)}</h3><span class="muted small">${esc(side)}</span></div>
      <p class="chart-caption">${statCaption(key, last)}</p>
      <div class="daybars" style="--n:${n};--gap:${n > 40 ? 1 : 2}px">${r.daily.map((d, i) => `<button data-act="stat-bar" data-i="${i}" aria-pressed="${i === last}" aria-label="${esc(statDay(d.day))}: ${esc(statVal(key, d[key]))}">
        <span class="bar ${d[key] ? '' : 'zero'}" style="height:${(d[key] / max) * 100}%"></span></button>`).join('')}</div>
      <div class="daybars-axis" aria-hidden="true"><span>${esc(statDay(r.daily[0].day))}</span><span>${esc(statDay(r.daily[Math.floor(last / 2)].day))}</span><span>${T('Today')}</span></div>
    </section>`;
  };
  const row = (k, v) => `<li><div class="plain-row"><div class="main">${k}</div><b>${v}</b></div></li>`;
  const mb = (b) => T('{n} MB', { n: nf1.format(b / 1048576) });
  const since = new Date(r.server.upSince).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  openSheet(`${sheetHead(T('Site stats'))}
    <div class="tiles">
      ${tile(nf.format(t.accounts), T('accounts'))}
      ${tile(nf.format(t.active7), T('active in the last 7 days'))}
      ${tile(nf.format(t.active30), T('active in the last 30 days'))}
      ${tile(round1(t.minutes / 60), T('hours logged'))}
      ${tile(nf.format(t.points), T('points earned'))}
      ${tile(nf.format(t.sessions), T('sessions logged'))}
    </div>
    <div class="seg" role="group" aria-label="${T('Period')}">${[[7, T('7 days')], [30, T('30 days')], [90, T('90 days')]].map(([d, l]) =>
      `<button data-act="stats-days" data-v="${d}" aria-pressed="${d === r.days}">${l}</button>`).join('')}</div>
    <div class="tiles">
      ${tile(nf.format(p.page_views), T('page views'))}
      ${tile(nf.format(p.signins), T('sign-ins'))}
      ${tile(nf.format(p.signups), T('new accounts'))}
    </div>
    ${STAT_CHARTS.map(chart).join('')}
    <details class="more"><summary>${T('Show as a table')}</summary>
      <div class="table-wrap"><table class="stat-table">
        <thead><tr><th>${T('Day')}</th><th>${T('Hours')}</th><th>${T('Active')}</th><th>${T('Views')}</th><th>${T('New')}</th><th>${T('Sign-ins')}</th></tr></thead>
        <tbody>${r.daily.slice().reverse().map((d) => `<tr><td>${esc(statDay(d.day))}</td><td>${round1(d.minutes / 60)}</td><td>${nf.format(d.active)}</td><td>${nf.format(d.page_views)}</td><td>${nf.format(d.signups)}</td><td>${nf.format(d.signins)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>
    <div class="stack"><h3>${T('Traffic in this period')}</h3><ul class="list">
      ${row(T('Requests'), nf.format(p.requests))}
      ${row(T('App data requests'), nf.format(p.api))}
      ${row(T('Failed sign-ins'), nf.format(p.signins_failed))}
      ${row(T('Blocked for going too fast'), nf.format(p.blocked))}
      ${row(T('Server errors'), nf.format(p.errors))}
    </ul></div>
    <div class="stack"><h3>${T('Everything so far')}</h3><ul class="list">
      ${row(T('Things on wheels'), nf.format(t.items))}
      ${row(T('Spins'), nf.format(t.spins))}
      ${row(T('Timers running now'), nf.format(t.timersRunning))}
      ${row(T('Wishes waiting'), nf.format(t.wishes))}
      ${row(T('Purchases earned'), nf.format(t.purchases))}
      ${row(T('Friendships'), nf.format(t.friendships))}
      ${row(T('Achievements unlocked'), nf.format(t.achievements))}
      ${row(T('High-fives'), nf.format(t.highFives))}
    </ul></div>
    <div class="stack"><h3>${T('Server')}</h3><ul class="list">
      ${row(T('Version'), esc(r.server.release))}
      ${row(T('Running since'), esc(since))}
      ${row(T('Database'), esc(mb(r.server.dbBytes)))}
      ${row(T('Memory in use'), esc(mb(r.server.memoryBytes)))}
    </ul>
    <p class="hint">${T('Only totals are counted: nothing here says who did what. Day-by-day traffic starts from the version that added this screen.')}</p></div>`);
}
// hovering a bar with a mouse shows that day, like tapping it does
document.addEventListener('pointerover', (e) => {
  const b = e.pointerType === 'mouse' && e.target.closest && e.target.closest('[data-act="stat-bar"]');
  if (b) selectStatBar(b);
});


// --- What's new
// Changelog text is ours, but it still goes through esc() before the bit of markdown is applied.
const mdLite = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
async function whatsNewSheet() {
  let data;
  try { data = await api('GET', `/api/changelog?lang=${LANG}`); } catch (e) { toast(e.message); return; }
  const fmtDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const block = (v) => `${v.intro ? `<p>${mdLite(v.intro)}</p>` : ''}${v.groups.map((g) => `
      ${g.title ? `<h4>${esc(g.title)}</h4>` : ''}<ul class="changes">${g.items.map((i) => `<li>${mdLite(i)}</li>`).join('')}</ul>`).join('')}`;
  const [first, ...rest] = data.versions;
  openSheet(`${sheetHead(T('What’s new'))}
    <div class="version-now">
      <span class="badge-ver">${esc(data.release)}</span>
      <span class="muted small">${T('You’re on version {v}', { v: esc(data.release) })}${data.commit && data.commit !== 'dev' ? ` (${T('build {id}', { id: esc(data.commit) })})` : ''}</span>
    </div>
    ${first ? `<section class="release current">
      <div class="release-head"><h3>${first.upcoming ? T('Coming next') : T('Version {v}', { v: esc(first.version) })}</h3><span class="muted small">${esc(fmtDate(first.date))}</span></div>
      ${block(first)}</section>` : `<p class="muted">${T('No release notes yet.')}</p>`}
    ${rest.map((v) => `<details class="release"><summary><span class="release-head"><b>${T('Version {v}', { v: esc(v.version) })}</b><span class="muted small">${esc(fmtDate(v.date))}</span></span></summary>${block(v)}</details>`).join('')}`);
  if (data.release) store.set('seenRelease', data.release);
}
// After an update, show what's new once (not on someone's very first visit).
function announceUpdate() {
  const seen = store.get('seenRelease', null);
  if (!config.release) return;
  if (!seen) { store.set('seenRelease', config.release); return; }
  if (seen !== config.release) enqueue(() => whatsNewSheet());
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context, fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  (sheet.open ? sheet : document.body).appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove(); return ok;
}

// ---------- wheel ----------
let wheelSlices = [];
function drawWheel() {
  const canvas = $('#wheel');
  if (!canvas) return;
  const list = wheelItems();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const css = canvas.clientWidth;
  if (!css) return;
  canvas.width = css * dpr; canvas.height = css * dpr;
  const ctx = canvas.getContext('2d');
  const c = (css * dpr) / 2;
  const R = c;  // full canvas; the shadow comes from CSS
  const total = list.reduce((a, i) => a + weightOf(i), 0);
  let a = 0;
  wheelSlices = list.map((item) => {
    const span = (weightOf(item) / total) * Math.PI * 2;
    const s = { item, start: a, end: a + span };
    a += span; return s;
  });
  const skin = pref('skin');
  if (skin === 'walnut' || skin === 'doodle') { drawSkinnedWheel(ctx, canvas, c, R, dpr, skin); return; }
  const css2 = getComputedStyle(document.body);
  const rim = css2.getPropertyValue('--surface').trim() || '#FFFFFF';

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(c, c);
  // rim
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fillStyle = rim; ctx.fill();
  const inner = R - 9 * dpr;
  ctx.rotate(wheelRot);
  for (const s of wheelSlices) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, inner, s.start, s.end); ctx.closePath();
    ctx.fillStyle = colorOf(s.item); ctx.fill();
    if (wheelWinner && s.item.id !== wheelWinner && wheelDim > 0) { ctx.globalAlpha = 0.6 * wheelDim; ctx.fillStyle = rim; ctx.fill(); ctx.globalAlpha = 1; }
  }
  // gaps between slices
  if (wheelSlices.length > 1) {
    ctx.strokeStyle = rim; ctx.lineWidth = 3 * dpr; ctx.lineCap = 'round';
    for (const s of wheelSlices) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(s.start) * inner, Math.sin(s.start) * inner); ctx.stroke(); }
  }
  // labels, kept upright on the left half
  for (const s of wheelSlices) {
    const mid = (s.start + s.end) / 2;
    const arc = (s.end - s.start) * inner * 0.62;
    const size = Math.max(11 * dpr, Math.min(inner * 0.072, arc * 0.5));
    const flip = Math.cos(mid + wheelRot) < 0;
    ctx.save();
    ctx.rotate(flip ? mid + Math.PI : mid);
    ctx.fillStyle = SLICE_TEXT;
    ctx.globalAlpha = wheelWinner && s.item.id !== wheelWinner ? 1 - 0.6 * wheelDim : 1;
    ctx.font = `650 ${size}px Figtree, system-ui, sans-serif`;
    ctx.textAlign = flip ? 'left' : 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, s.item.name, inner * 0.64 - 20 * dpr), flip ? -(inner - 16 * dpr) : inner - 16 * dpr, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
// --- The secret themes draw their own wheel.
// Walnut: a real prize wheel. Wood rim, brass ring and pegs, jewel-toned slices, light from the top left.
// Doodle: felt-tip slices, crayon hatching, wobbly black outlines that look drawn by hand.
const skinFonts = { walnut: '700 24px "Cormorant Garamond"', doodle: '24px "Patrick Hand"' };
let woodImg = null;
function wood() {
  if (!woodImg) { woodImg = new Image(); woodImg.src = '/themes/walnut.jpg'; woodImg.onload = () => { if (view === 'spin') drawWheel(); }; }
  return woodImg.complete && woodImg.naturalWidth ? woodImg : null;
}
const wobble = (seed) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x) - 0.5; };   // the same "random" every frame
function wobblyCircle(ctx, r, amp, seed, steps = 72) {
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU, rr = r + wobble(seed + (i % steps)) * amp;
    i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
}
function drawSkinnedWheel(ctx, canvas, c, R, dpr, skin) {
  if (document.fonts && !document.fonts.check(skinFonts[skin])) document.fonts.load(skinFonts[skin]).then(() => drawWheel()).catch(() => {});
  const walnut = skin === 'walnut';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save(); ctx.translate(c, c);
  const inner = walnut ? R * 0.86 : R * 0.92;
  if (walnut) {
    // wooden rim, rounded by light and shade
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU);
    const w = wood(); ctx.fillStyle = w ? ctx.createPattern(w, 'repeat') : '#4A2A18'; ctx.fill();
    const g = ctx.createRadialGradient(0, 0, inner, 0, 0, R);
    g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(0.3, 'rgba(255,225,180,.16)'); g.addColorStop(0.75, 'rgba(0,0,0,.05)'); g.addColorStop(1, 'rgba(0,0,0,.6)');
    ctx.fillStyle = g; ctx.fill();
  } else {
    ctx.fillStyle = '#FFFFFF'; wobblyCircle(ctx, R * 0.985, 1.2 * dpr, 3); ctx.fill();
  }
  ctx.rotate(wheelRot);
  // slices
  for (const s of wheelSlices) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, inner, s.start, s.end); ctx.closePath();
    ctx.fillStyle = colorOf(s.item); ctx.fill();
  }
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, inner, 0, TAU); ctx.clip();
  if (walnut) {
    // a lacquered, slightly domed face
    const g = ctx.createRadialGradient(-inner * 0.2, -inner * 0.25, inner * 0.05, 0, 0, inner);
    g.addColorStop(0, 'rgba(255,240,215,.22)'); g.addColorStop(0.6, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = g; ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
  } else {
    // crayon hatching across the whole face
    ctx.strokeStyle = 'rgba(30,30,30,.09)'; ctx.lineWidth = 2.2 * dpr;
    for (let x = -inner * 1.5; x < inner * 1.5; x += 7 * dpr) { ctx.beginPath(); ctx.moveTo(x, -inner); ctx.lineTo(x + inner * 0.9, inner); ctx.stroke(); }
  }
  // dim the others when one wins
  if (wheelWinner && wheelDim > 0) for (const s of wheelSlices) {
    if (s.item.id === wheelWinner) continue;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, inner, s.start, s.end); ctx.closePath();
    ctx.fillStyle = walnut ? `rgba(20,10,5,${0.62 * wheelDim})` : `rgba(255,253,246,${0.7 * wheelDim})`; ctx.fill();
  }
  ctx.restore();
  // dividers
  if (wheelSlices.length > 1) for (const s of wheelSlices) {
    const x = Math.cos(s.start) * inner, y = Math.sin(s.start) * inner;
    ctx.beginPath(); ctx.moveTo(0, 0);
    if (walnut) { ctx.lineTo(x, y); ctx.strokeStyle = '#C9A04A'; ctx.lineWidth = 2.2 * dpr; }
    else {
      const k = wobble(s.item.id) * 0.18, mx = Math.cos(s.start + k) * inner * 0.5, my = Math.sin(s.start + k) * inner * 0.5;
      ctx.quadraticCurveTo(mx, my, x, y); ctx.strokeStyle = '#1E1E1E'; ctx.lineWidth = 3.2 * dpr; ctx.lineCap = 'round';
    }
    ctx.stroke();
  }
  if (walnut) {
    // brass ring and pegs
    ctx.beginPath(); ctx.arc(0, 0, inner + 1.5 * dpr, 0, TAU);
    const b = ctx.createLinearGradient(-inner, -inner, inner, inner);
    b.addColorStop(0, '#F3DA93'); b.addColorStop(0.45, '#9C7A30'); b.addColorStop(0.7, '#E2C477'); b.addColorStop(1, '#7A5C1E');
    ctx.strokeStyle = b; ctx.lineWidth = 4 * dpr; ctx.stroke();
    const pegR = (inner + R) / 2;
    for (const s of wheelSlices) {
      const x = Math.cos(s.start) * pegR, y = Math.sin(s.start) * pegR;
      ctx.beginPath(); ctx.arc(x + 1.2 * dpr, y + 1.8 * dpr, 4.6 * dpr, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
      const pg = ctx.createRadialGradient(x - 1.5 * dpr, y - 1.5 * dpr, 0.5 * dpr, x, y, 4.6 * dpr);
      pg.addColorStop(0, '#FFF3C4'); pg.addColorStop(0.45, '#D4AE55'); pg.addColorStop(1, '#6E5218');
      ctx.beginPath(); ctx.arc(x, y, 4.4 * dpr, 0, TAU); ctx.fillStyle = pg; ctx.fill();
    }
  } else {
    ctx.strokeStyle = '#1E1E1E'; ctx.lineWidth = 3.6 * dpr; ctx.lineJoin = 'round';
    wobblyCircle(ctx, inner, 1.6 * dpr, 11); ctx.stroke();
    ctx.lineWidth = 1.6 * dpr; wobblyCircle(ctx, inner + 3 * dpr, 2.2 * dpr, 29); ctx.stroke();
  }
  // labels, kept upright
  for (const s of wheelSlices) {
    const mid = (s.start + s.end) / 2;
    const arc = (s.end - s.start) * inner * 0.62;
    const size = Math.max(12 * dpr, Math.min(inner * (walnut ? 0.085 : 0.09), arc * 0.55));
    const flip = Math.cos(mid + wheelRot) < 0;
    ctx.save(); ctx.rotate(flip ? mid + Math.PI : mid);
    ctx.globalAlpha = wheelWinner && s.item.id !== wheelWinner ? 1 - 0.6 * wheelDim : 1;
    ctx.font = walnut ? `700 ${size}px "Cormorant Garamond", Georgia, serif` : `${size}px "Patrick Hand", "Comic Sans MS", cursive`;
    ctx.fillStyle = walnut ? '#F7EEDC' : '#1E1E1E';
    if (walnut) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 2 * dpr; ctx.shadowOffsetY = 1 * dpr; }
    ctx.textAlign = flip ? 'left' : 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, s.item.name, inner * 0.64 - 20 * dpr), flip ? -(inner - 14 * dpr) : inner - 14 * dpr, 0);
    ctx.restore();
  }
  ctx.restore();
  if (walnut) {
    // a soft reflection on the lacquer, fixed while the wheel turns
    ctx.save(); ctx.translate(c, c);
    ctx.beginPath(); ctx.arc(0, 0, inner, 0, TAU); ctx.clip();
    const hl = ctx.createLinearGradient(-inner, -inner, inner * 0.3, inner * 0.3);
    hl.addColorStop(0, 'rgba(255,255,255,.16)'); hl.addColorStop(0.45, 'rgba(255,255,255,.03)'); hl.addColorStop(0.46, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
    ctx.restore();
  }
}
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}
const mod = (n, m) => ((n % m) + m) % m;
function sliceAtPointer() {
  const a = mod(-Math.PI / 2 - wheelRot, TAU);
  return wheelSlices.findIndex((s) => a >= s.start && a < s.end);
}

function spin() {
  if (spinning || wheelSlices.length < 2) return;
  spinning = true;
  $('#hub').disabled = true;
  wheelWinner = null; wheelDim = 0;
  SFX.warm(); SFX.whoosh(); buzz(8);
  api('POST', '/api/spin').catch(() => {});
  // weighted pick
  const total = wheelSlices.reduce((a, s) => a + (s.end - s.start), 0);
  let r = Math.random() * total;
  let win = wheelSlices[wheelSlices.length - 1];
  for (const s of wheelSlices) { r -= s.end - s.start; if (r <= 0) { win = s; break; } }
  const p = win.start + (0.15 + Math.random() * 0.7) * (win.end - win.start);
  const target = -Math.PI / 2 - p;
  const startRot = wheelRot;
  const turns = reducedMotion.matches ? 1 : pref('spin') === 'quick' ? 2 : pref('spin') === 'dramatic' ? 9 + Math.floor(Math.random() * 3) : 5 + Math.floor(Math.random() * 3);
  const endRot = startRot + turns * TAU + mod(target - startRot, TAU);
  const dur = reducedMotion.matches ? 700 : { quick: 1500, normal: 4200 + Math.random() * 1200, dramatic: 8000 + Math.random() * 1500 }[pref('spin')] || 4200;
  const t0 = performance.now();
  let last = sliceAtPointer();
  const frame = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    wheelRot = startRot + (endRot - startRot) * e;
    drawWheel();
    const idx = sliceAtPointer();
    if (idx !== last) { last = idx; tick(); }
    if (k < 1) requestAnimationFrame(frame);
    else {
      wheelRot = mod(wheelRot, TAU); store.set('rot', wheelRot);
      spinning = false;
      const hub = $('#hub'); if (hub) hub.disabled = false;
      land(win.item);
    }
  };
  requestAnimationFrame(frame);
}

// the wheel stops: ding, pointer bounce, sparks, dim the losing slices, then reveal
function land(item) {
  SFX.land(); buzz([12, 40, 18]);
  const ptr = $('#pointer');
  if (ptr) {
    ptr.classList.remove('tick', 'land'); void ptr.offsetWidth; ptr.classList.add('land');
    const r = ptr.getBoundingClientRect();
    FX.burst(r.left + r.width / 2, r.bottom + 6, { n: 26, colors: [colorOf(item), colorOf(item), '#5457E0', '#FFFFFF'], speed: 8 });
  }
  wheelWinner = item.id;
  animateDim(1, () => setTimeout(() => (pref('autoTimer') && !S.timer ? autoStart(item) : showResult(item)), reducedMotion.matches ? 0 : 220));
}
function animateDim(to, done) {
  const from = wheelDim, t0 = performance.now(), dur = reducedMotion.matches ? 1 : 260;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    wheelDim = from + (to - from) * k;
    drawWheel();
    if (k < 1) requestAnimationFrame(step); else { if (to === 0) wheelWinner = null; done && done(); }
  };
  requestAnimationFrame(step);
}

// ---------- sound effects (synthesized, no files) ----------
const SFX = (() => {
  let ac = null, master = null, noiseBuf = null;
  // 'ambient' lets sounds mix with your music instead of pausing it (Safari 16.4+), and follows the silent switch.
  try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch { /* unsupported */ }
  function ctx() {
    if (!pref('sound')) return null;
    // browsers only allow sound after you've tapped something; popups that open by themselves stay quiet
    if (!ac && navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
    try {
      if (!ac) {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.gain.value = 0.7; master.connect(ac.destination);
      }
      if (ac.state === 'suspended') ac.resume();
    } catch { return null; }
    return ac;
  }
  function tone(freq, { type = 'sine', t = 0, dur = 0.15, vol = 0.1, to = null, attack = 0.006 } = {}) {
    const a = ctx(); if (!a) return;
    const st = a.currentTime + t;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, st);
    if (to) o.frequency.exponentialRampToValueAtTime(to, st + dur * 0.8);
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(vol, st + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
    o.connect(g).connect(master); o.start(st); o.stop(st + dur + 0.03);
  }
  function noise({ t = 0, dur = 0.2, vol = 0.05, freq = 2000, to = null, q = 1 } = {}) {
    const a = ctx(); if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const st = a.currentTime + t;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; f.type = 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(freq, st); if (to) f.frequency.exponentialRampToValueAtTime(to, st + dur);
    g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(vol, st + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
    src.connect(f).connect(g).connect(master); src.start(st); src.stop(st + dur + 0.05);
  }
  return {
    warm: ctx,
    tick: () => tone(1600 + Math.random() * 250, { type: 'triangle', dur: 0.035, vol: 0.045 }),
    whoosh: () => noise({ dur: 0.4, vol: 0.06, freq: 500, to: 2600, q: 0.7 }),
    land: () => { tone(784, { dur: 0.22, vol: 0.08 }); tone(1175, { t: 0.08, dur: 0.5, vol: 0.075 }); },
    pop: () => tone(480, { dur: 0.11, vol: 0.09, to: 960 }),
    start: () => { tone(440, { dur: 0.12, vol: 0.06, to: 660 }); tone(660, { t: 0.09, dur: 0.2, vol: 0.06, to: 990 }); },
    coin: () => { tone(988, { type: 'triangle', dur: 0.09, vol: 0.07 }); tone(1319, { type: 'triangle', t: 0.075, dur: 0.4, vol: 0.07 }); },
    fanfare: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, { t: i * 0.085, dur: 0.38, vol: 0.065 })); tone(1568, { t: 0.36, dur: 0.7, vol: 0.05 }); },
    chaching: () => { noise({ dur: 0.09, vol: 0.05, freq: 6000, q: 2 }); tone(1568, { type: 'triangle', t: 0.05, dur: 0.12, vol: 0.06 }); tone(2093, { type: 'triangle', t: 0.13, dur: 0.55, vol: 0.06 }); },
    thud: () => tone(200, { dur: 0.13, vol: 0.08, to: 90 }),
    click: () => tone(1200, { type: 'triangle', dur: 0.03, vol: 0.03 }),
    count: (k) => tone(700 + 900 * k, { type: 'triangle', dur: 0.03, vol: 0.035 }),
    rankUp: () => { [784, 988, 1319].forEach((f, i) => tone(f, { t: i * 0.08, dur: 0.3, vol: 0.06 })); },
  };
})();
const buzz = (pattern) => { try { if (pref('haptics')) navigator.vibrate?.(pattern); } catch { /* unsupported */ } };

function tick() {
  const ptr = $('#pointer');
  if (ptr) { ptr.classList.remove('tick', 'land'); void ptr.offsetWidth; ptr.classList.add('tick'); }
  SFX.tick(); buzz(4);
}

// ---------- sheets ----------
const sheet = $('#sheet');
function openSheet(html, onOpen) {
  sheet.innerHTML = `<div class="sheet-body">${html}</div>`;
  sheet.scrollTop = 0;   // a new sheet starts at the top, even when it replaces one that was scrolled
  if (!sheet.open) sheet.showModal();
  FX.raise();
  onOpen && onOpen(sheet);
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => setTimeout(runQueue, 350));
sheet.addEventListener('close', () => { if (wheelWinner && !spinning && $('#wheel')) animateDim(0); else wheelWinner = null; });
const sheetHead = (title) => `<div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="close" aria-label="${T('Close')}">${ICON.x}</button></div>`;

// "Auto-start timer": the wheel's pick starts timing straight away (with the wheel's-pick bonus).
async function autoStart(item) {
  try {
    timerJustStarted = true;
    await api('POST', '/api/timer/start', { itemId: item.id, fromSpin: true });
    SFX.start(); buzz(10); toast(T('Timer started on {name}', { name: item.name }));
  } catch (e) { toast(e.message); showResult(item); }
}
function showResult(item) {
  const kicker = KICKERS[Math.floor(Math.random() * KICKERS.length)];
  const running = S.timer;
  openSheet(`
    <div class="sheet-head"><p class="result-kicker">${kicker}</p><button class="icon-btn" data-act="close" aria-label="${T('Close')}">${ICON.x}</button></div>
    <div class="stack" style="gap:10px">
      <span class="result-tag" style="background:${colorOf(item)}">${KINDS[item.kind]}</span>
      <div class="result-name">${esc(item.name)}</div>
      <p class="muted">${item.minutes ? T('{time} so far', { time: hrs(item.minutes) }) : T('No time logged yet')}, ${ago(item.last_at)}.</p>
      ${item.next_step ? `<p class="next-step">${ICON.check}<span><span class="muted small">${T('Next step, {done} of {total} done', { done: item.steps_done, total: item.steps_total })}</span><b>${esc(item.next_step)}</b></span></p>` : ''}
    </div>
    <div class="sheet-actions">
      <button class="btn primary" data-act="timer-start" data-id="${item.id}" data-spin="1">${running ? T('Stop current timer and start this') : T('Start timer')}</button>
      <button class="btn" data-act="log" data-id="${item.id}">${T('Log time')}</button>
    </div>
    <p class="hint" style="text-align:center">${ICON.spark.replace('<svg', '<svg class="inline-ico"')} ${T('Start the timer now for the +25% wheel’s pick bonus')}</p>
    <button class="btn ghost" data-act="respin">${T('Spin again')}</button>`);
  FX.burstFrom($('.result-name', sheet), { n: 22, colors: [colorOf(item), colorOf(item), '#5457E0', '#FFD873'], speed: 9 });
}

function logSheet(itemId) {
  const items = active();
  const all = items.some((i) => i.id === itemId) ? items : S.items;
  const today = new Date(); const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  openSheet(`${sheetHead(T('Log time'))}
    <form class="stack" data-form="log">
      <div class="field"><label for="log-item">${T('On')}</label>
        <select class="input" id="log-item" name="itemId">${all.map((i) => `<option value="${i.id}" ${i.id === itemId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${T('How long')}</label>
        <div class="row">
          <input class="input" name="h" type="number" inputmode="numeric" min="0" max="24" value="1" aria-label="${T('Hours')}" style="width:90px"><span>${T('h')}</span>
          <input class="input" name="m" type="number" inputmode="numeric" min="0" max="59" step="5" value="0" aria-label="${T('Minutes')}" style="width:90px"><span>min</span>
        </div>
        <div class="row" style="flex-wrap:wrap">${[[0, 30], [1, 0], [2, 0], [3, 0]].map(([h, m]) => `<button type="button" class="btn small" data-act="quick" data-h="${h}" data-m="${m}">${hm(h * 60 + m)}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="log-date">${T('When')}</label>
        <input class="input" id="log-date" name="date" type="date" value="${iso(today)}" max="${iso(today)}"></div>
      <div class="field"><label for="log-note">${T('Note')} <span class="muted">${T('(optional)')}</span></label>
        <input class="input" id="log-note" name="note" maxlength="200" placeholder="${T('What did you get done?')}" autocomplete="off"></div>
      <p class="form-error"></p>
      <button class="btn primary block">${T('Log time')}</button>
    </form>`);
}

function itemSheet(id) {
  const i = S.items.find((x) => x.id === id);
  if (!i) return;
  openSheet(`${sheetHead(esc(i.name))}
    <p class="muted">${Tn(i.sessions, '{time} over 1 session', '{time} over {n} sessions', { time: hrs(i.minutes) })}, ${ago(i.last_at)}.${i.archived ? '' : ` ${T('{n}% chance on the next spin.', { n: odds(i) })}`}</p>
    ${i.archived ? '' : `<div class="sheet-actions">
      <button class="btn primary" data-act="timer-start" data-id="${i.id}">${S.timer ? T('Switch timer to this') : T('Start timer')}</button>
      <button class="btn" data-act="log" data-id="${i.id}">${T('Log time')}</button></div>
      ${snoozed(i)
        ? `<p class="snooze-note">${T('Snoozed until {date}, so it’s off the wheel for now.', { date: esc(day(i.snoozed_until)) })} <button class="auth-switch" data-act="snooze" data-id="${i.id}" data-v="0">${T('Put it back now')}</button></p>`
        : `<button class="btn ghost" data-act="snooze" data-id="${i.id}" data-v="7">${ICON.moon}${T('Not this week')}</button>`}`}
    ${diary(i.id)}
    ${i.kind === 'project' && !i.archived ? `<section class="steps" id="steps" data-item="${i.id}"><p class="hint">${T('Loading steps…')}</p></section>` : ''}
    <form class="stack" data-form="edit-item" data-id="${i.id}">
      <div class="field"><label for="ename">${T('Name')}</label><input class="input" id="ename" name="name" value="${esc(i.name)}" maxlength="60" required></div>
      ${kindPicker('ekind', i.kind)}
      <div class="toggles">
        <label class="toggle"><input type="checkbox" name="quick" ${i.quick ? 'checked' : ''}><span class="track"></span><span>${T('Works in 30 minutes or less')}</span></label>
        <label class="toggle"><input type="checkbox" name="chill" ${i.chill ? 'checked' : ''}><span class="track"></span><span>${T('Good for low energy')}</span></label>
      </div>
      <p class="form-error"></p>
      <button class="btn">${T('Save changes')}</button>
    </form>
    <div class="sheet-actions">
      ${i.archived
        ? `<button class="btn" data-act="archive" data-id="${i.id}" data-v="0">${T('Put back on the wheel')}</button>`
        : `<button class="btn" data-act="archive" data-id="${i.id}" data-v="1">${i.kind === 'project' ? T('Finished it') : T('Retire it')}</button>`}
      <button class="btn danger" data-act="item-del" data-id="${i.id}">${T('Delete')}</button>
    </div>
    <p class="muted small">${T('Finished and retired things leave the wheel but keep their hours. Deleting also removes the hours.')}</p>`);
  if (i.kind === 'project' && !i.archived) loadSteps(i.id);
}

// --- project checklists
async function loadSteps(itemId) {
  try { const r = await api('GET', `/api/items/${itemId}/steps`); renderSteps(itemId, r.steps); } catch (e) { toast(e.message); }
}
function renderSteps(itemId, steps) {
  const el = $('#steps', sheet); if (!el) return;
  const done = steps.filter((x) => x.done).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  el.innerHTML = `
    <div class="steps-head"><h3>${T('Steps')}</h3>${steps.length ? `<span class="muted small">${T('{a} of {b} done', { a: done, b: steps.length })}</span>` : ''}</div>
    ${steps.length ? `<div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div>` : ''}
    ${steps.length ? `<ul class="step-list">${steps.map((x) => `<li class="${x.done ? 'done' : ''}">
        <button class="check" data-act="step-toggle" data-id="${x.id}" data-done="${x.done ? 0 : 1}" aria-pressed="${x.done}" aria-label="${x.done ? T('Mark not done') : T('Mark done')}: ${esc(x.text)}">${x.done ? ICON.check : ''}</button>
        <span class="step-text">${esc(x.text)}</span>
        <button class="icon-btn" data-act="step-del" data-id="${x.id}" aria-label="${T('Delete step {name}', { name: esc(x.text) })}">${ICON.x}</button>
      </li>`).join('')}</ul>` : `<p class="hint">${T('Break the project into small steps. The next one shows up when the wheel picks it.')}</p>`}
    ${steps.length && done === steps.length ? `<div class="all-done"><b>${T('Every step is done.')}</b> <button class="btn small primary" data-act="archive" data-id="${itemId}" data-v="1">${T('Mark the project finished')}</button></div>` : ''}
    <form class="row" data-form="add-step" data-item="${itemId}">
      <input class="input grow" name="text" placeholder="${T('Add a step')}" maxlength="120" required aria-label="${T('New step')}">
      <button class="btn">${T('Add')}</button>
    </form>`;
}

// --- Sessions: a row, the per-item diary, and editing one
function sessionRow(l, withItem) {
  return `<li><button class="plain-row session-row" data-act="log-edit" data-id="${l.id}">
      <span class="main"><span class="name">${withItem ? esc(l.item_name) : esc(day(l.ended_at))}</span>
        <span class="muted small">${withItem ? `${esc(day(l.ended_at))}, ` : ''}${l.source === 'timer' ? T('timed') : T('added by hand')}${l.edited ? T(', edited') : ''}</span>
        ${l.note ? `<span class="session-note">${esc(l.note)}</span>` : ''}</span>
      <span class="sess"><b>${hm(l.minutes)}</b>${l.points ? `<span class="muted small">${T('+{n} pts', { n: nf.format(l.points) })}</span>` : ''}</span>
    </button></li>`;
}
function diary(itemId) {
  const logs = S.logs.filter((l) => l.item_id === itemId).slice(0, 8);
  if (!logs.length) return '';
  return `<section class="stack" style="gap:8px"><h3>${T('Sessions')}</h3><ul class="list">${logs.map((l) => sessionRow(l, false)).join('')}</ul>
    ${logs.some((l) => l.note) ? '' : `<p class="hint">${T('Tap a session to add a note, like what you got done.')}</p>`}</section>`;
}
function editLogSheet(id) {
  const l = S.logs.find((x) => x.id === id); if (!l) return;
  openSheet(`${sheetHead(esc(l.item_name))}
    <p class="muted">${esc(day(l.ended_at))}, ${l.source === 'timer' ? T('timed') : T('added by hand')}${l.points ? `, ${T('+{n} pts', { n: nf.format(l.points) })}` : ''}</p>
    <form class="stack" data-form="log-edit" data-id="${l.id}">
      <div class="field"><label>${T('How long')}</label>
        <div class="row">
          <input class="input" name="h" type="number" inputmode="numeric" min="0" max="24" value="${Math.floor(l.minutes / 60)}" aria-label="${T('Hours')}" style="width:90px"><span>${T('h')}</span>
          <input class="input" name="m" type="number" inputmode="numeric" min="0" max="59" value="${l.minutes % 60}" aria-label="${T('Minutes')}" style="width:90px"><span>min</span>
        </div>
        ${l.source === 'timer' ? `<span class="hint">${T('Making a timed session longer counts it as added by hand.')}</span>` : ''}</div>
      <div class="field"><label for="lnote">${T('Note')}</label>
        <textarea class="input" id="lnote" name="note" maxlength="200" rows="2" placeholder="${T('What did you get done?')}">${esc(l.note || '')}</textarea></div>
      <p class="form-error"></p>
      <button class="btn primary block">${T('Save changes')}</button>
    </form>
    <button class="btn danger block" data-act="log-del" data-id="${l.id}">${T('Delete this session')}</button>`);
}

// --- Undo: deleting a session, wish or step happens after a few seconds, unless you tap Undo.
const pendingDeletes = new Map();
function deleteWithUndo(key, url, hideLocally, message, onUndo = refresh) {
  hideLocally(); render(); SFX.thud();
  const run = () => { pendingDeletes.delete(key); return api('DELETE', url).then((st) => { if (st && st.items) setState(st); }).catch((e) => { toast(e.message); refresh(); }); };
  const t = setTimeout(run, 5000);
  pendingDeletes.set(key, { t, url });
  toast(message, { label: T('Undo'), fn: () => { clearTimeout(t); pendingDeletes.delete(key); onUndo(); } });
}
// Leaving the page doesn't cancel a delete you already confirmed.
addEventListener('pagehide', () => {
  for (const [key, p] of pendingDeletes) { clearTimeout(p.t); pendingDeletes.delete(key); fetch(p.url, { method: 'DELETE', keepalive: true, credentials: 'same-origin' }).catch(() => {}); }
});

function confirmSheet(title, text, label, onYes, danger = true) {
  openSheet(`${sheetHead(title)}<p>${text}</p>
    <div class="sheet-actions"><button class="btn" data-act="close">${T('Cancel')}</button>
    <button class="btn ${danger ? 'danger' : 'primary'}" id="yes">${label}</button></div>`, (el) => {
    $('#yes', el).addEventListener('click', async () => { try { await onYes(); closeSheet(); } catch (e) { toast(e.message); } });
  });
}

function celebrate(newUnlocks) {
  if (!newUnlocks) return;
  SFX.fanfare(); buzz([20, 60, 20, 60, 40]);
  openSheet(`${sheetHead(T('You unlocked a buy'))}
    <p class="big" style="color:var(--accent)">+${newUnlocks}</p>
    <p>${T('You put in the hours on stuff you already own. Go pick something from your wishlist.')}</p>
    <div class="sheet-actions"><button class="btn primary" data-act="nav" data-v="shop">${T('Open wishlist')}</button><button class="btn" data-act="close">${T('Later')}</button></div>`);
  FX.cannons(140);
}

// ---------- timer ----------
let timerInt = null;
// "Keep screen awake" while a timer runs (where the browser allows it).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch { wakeLock = null; }
}
const TITLE = 'bored?';
function tickTimer() {
  clearInterval(timerInt);
  if (!S || !S.timer) { document.title = TITLE; keepAwake(false); return; }
  keepAwake(pref('wakeLock') && !S.timer.paused_at);
  const upd = () => {
    if (!S || !S.timer) return;
    const c = clock(timerMs()), el = $('#clock');
    if (el) el.textContent = c;
    document.title = pref('tabTitle') ? `${S.timer.paused_at ? '⏸' : '▶'} ${c} · ${S.timer.item_name}` : TITLE;
  };
  upd(); timerInt = setInterval(upd, 1000);
}
async function stopTimer() {
  const elapsed = Math.round(timerMs() / 60000);
  if (elapsed >= 180) {
    openSheet(`${sheetHead(T('That was a long one'))}
      <p>${T('The timer ran for <b>{time}</b> on {name}. Forgot to stop it? Keep only the real part.', { time: hm(elapsed), name: esc(S.timer.item_name) })}</p>
      <form class="stack" data-form="stop-adjust">
        <div class="row">
          <input class="input" name="h" type="number" min="0" max="24" value="${Math.floor(Math.min(elapsed, 1440) / 60)}" aria-label="${T('Hours')}" style="width:90px"><span>${T('h')}</span>
          <input class="input" name="m" type="number" min="0" max="59" value="${Math.min(elapsed, 1440) % 60}" aria-label="${T('Minutes')}" style="width:90px"><span>min</span>
        </div>
        <button class="btn primary block">${T('Log this')}</button>
      </form>`);
    return;
  }
  const r = await api('POST', '/api/timer/stop');
  afterLog(r);
}
function afterLog(r) {
  closeSheet();
  if (r.logged < 1) { toast(T('Under a minute, so nothing logged.')); return; }
  if (r.offline) { toast(T('Logged {time}. Points are added when you’re back online.', { time: hm(r.logged) })); SFX.coin(); return; }
  if (r.earned && r.earned.total > 0) { pointsReveal(r); return; }
  toast(r.earned && r.earned.note ? T('Logged {time}. {note}.', { time: hm(r.logged), note: TS(r.earned.note) }) : T('Logged {time}. Nice.', { time: hm(r.logged) }));
  if (!r.newUnlocks) { SFX.coin(); buzz(15); floatText($('.bankpill'), `+${hm(r.logged)}`); }
  celebrate(r.newUnlocks);
}

// The satisfying bit: base points, then each bonus pops in, the multiplier grows,
// and the total counts up with rising ticks.
function pointsReveal(r) {
  const e = r.earned;
  const rows = [
    `<li class="pr-row" style="--d:0"><span>${nf.format(e.scoredMinutes)} min × 10</span><b>${nf.format(e.base)}</b></li>`,
    ...e.bonuses.map((b, i) => `<li class="pr-row bonus" style="--d:${i + 1}"><span>${ICON.spark.replace('<svg', '<svg class="inline-ico"')}${esc(TS(b.label))}</span><b>+${b.pct}%</b></li>`),
    ...(e.milestone ? [`<li class="pr-row milestone" style="--d:${e.bonuses.length + 1}"><span>${ICON.flame.replace('<svg', '<svg class="inline-ico"')}${T('{n}-day streak bonus', { n: e.milestone.days })}</span><b>+${nf.format(e.milestone.points)}</b></li>`] : []),
  ];
  openSheet(`
    <div class="sheet-head"><p class="result-kicker">${T('You did {time}. That’s worth', { time: hm(r.logged) })}</p><button class="icon-btn" data-act="close" aria-label="${T('Close')}">${ICON.x}</button></div>
    <div class="pr-total"><span class="pr-num" id="pr-num">+0</span><span class="pr-unit">${T('points')}</span>
      ${e.multiplier > 1 ? `<span class="pr-mult" id="pr-mult">×${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(e.multiplier)}</span>` : ''}</div>
    <ul class="pr-list">${rows.join('')}</ul>
    ${e.note ? `<p class="hint">${esc(TS(e.note))}.</p>` : ''}
    ${e.logId ? `<input class="input" id="pr-note" maxlength="200" placeholder="${T('Add a note: what did you get done?')}" aria-label="${T('Note')}" autocomplete="off">` : ''}
    <button class="btn primary block" data-act="points-done" data-log="${e.logId || ''}" data-unlocks="${r.newUnlocks || 0}">${r.newUnlocks ? T('Nice. And there’s more…') : T('Nice')}</button>`);
  const steps = rows.length;
  rows.forEach((_, i) => setTimeout(() => { if (sheet.open) { SFX.tick(); buzz(5); } }, 250 + i * 260));
  const el = $('#pr-num', sheet);
  const start = performance.now() + 250 + steps * 260;
  const dur = reducedMotion.matches ? 1 : 900;
  let lastTick = 0;
  const step = (t) => {
    if (!el.isConnected) return;
    const k = Math.max(0, Math.min(1, (t - start) / dur));
    const v = Math.round(e.total * (1 - Math.pow(1 - k, 3)));
    el.textContent = `+${nf.format(v)}`;
    if (k > 0 && k < 1 && t - lastTick > 70) { lastTick = t; SFX.count(k); }
    if (k < 1) requestAnimationFrame(step);
    else {
      el.classList.add('done'); $('#pr-mult', sheet)?.classList.add('done');
      SFX.coin(); buzz([10, 30, 20]);
      FX.burstFrom(el, { n: 28, speed: 9 });
      floatText($('.bankpill'), `+${hm(r.logged)}`);
    }
  };
  requestAnimationFrame(step);
}

// ---------- toast & confetti ----------
let toastT = null;
function toast(msg, action) {
  const t = $('#toast'); t.textContent = msg;
  try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch { /* no popover support */ }
  requestAnimationFrame(() => t.classList.add('show'));
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-action'; b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.fn(); }, { once: true });
    t.append(b);
  }
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2800);
}
// ---------- particles ----------
const FX = (() => {
  const cv = $('#confetti'); const ctx = cv.getContext('2d');
  let parts = [], raf = 0, dpr = 1, last = 0;
  const off = () => reducedMotion.matches || !pref('confetti');
  // the canvas is a popover, so it sits in the top layer above open sheets
  const show = () => { try { if (cv.showPopover) { if (cv.matches(':popover-open')) cv.hidePopover(); cv.showPopover(); } } catch { /* unsupported */ } };
  const hide = () => { try { cv.hidePopover?.(); } catch { /* already hidden */ } };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function draw(p) {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
    if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, TAU); ctx.fill(); }
    else if (p.shape === 'star') {
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const r = i % 2 ? p.s * 0.22 : p.s * 0.6, a = (i * Math.PI) / 4; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.closePath(); ctx.fill();
    } else {
      // confetti strip that flips as it falls
      const w = p.s, h = p.s * 0.55 * Math.abs(Math.cos(p.flip));
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-w / 2, -h / 2, w, Math.max(h, 0.8), 1.5) : ctx.rect(-w / 2, -h / 2, w, Math.max(h, 0.8)); ctx.fill();
    }
    ctx.restore();
  }
  function loop(t) {
    const dt = Math.min(2.5, (t - last) / 16.667); last = t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => (p.age += dt * 16.667) < p.life && p.y < innerHeight + 40);
    for (const p of parts) {
      p.vx *= Math.pow(p.drag, dt); p.vy = p.vy * Math.pow(p.drag, dt) + p.g * dt;
      p.x += p.vx * dt + (p.sway ? Math.sin(p.age / 180 + p.phase) * p.sway * dt : 0); p.y += p.vy * dt;
      p.r += p.vr * dt; p.flip += p.vf * dt;
      ctx.globalAlpha = Math.min(1, (1 - p.age / p.life) * 3);
      draw(p);
    }
    ctx.globalAlpha = 1;
    if (parts.length) raf = requestAnimationFrame(loop);
    else { raf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); hide(); }
  }
  function run() {
    if (!raf) {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      last = performance.now(); raf = requestAnimationFrame(loop);
    }
    show();
  }
  function add(o) {
    parts.push({ age: 0, r: rnd(0, TAU), vr: rnd(-0.2, 0.2), flip: rnd(0, TAU), vf: rnd(0.1, 0.3), drag: 0.97, g: 0.25, sway: 0, phase: rnd(0, TAU), ...o });
  }
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return {
    // small explosion, e.g. from a button
    burst(x, y, { n = 18, colors = CONFETTI, speed = 7, shapes = ['circle', 'star', 'rect'], size = [5, 10], life = [600, 1000], g = 0.18 } = {}) {
      if (off()) return;
      for (let i = 0; i < n; i++) {
        const a = rnd(0, TAU), v = rnd(speed * 0.4, speed);
        add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, s: rnd(...size), c: pick(colors), shape: pick(shapes), life: rnd(...life), drag: 0.92, g });
      }
      run();
    },
    burstFrom(el, opts) { if (el && el.isConnected) { const [x, y] = center(el); this.burst(x, y, opts); } },
    // party cannons from both bottom corners
    cannons(n = 80) {
      if (off()) return;
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < n / 2; i++) {
          const a = side ? rnd(-2.25, -1.75) : rnd(-1.4, -0.9), v = rnd(14, 24);
          add({ x: side ? innerWidth + 10 : -10, y: innerHeight * 0.85, vx: Math.cos(a) * v, vy: Math.sin(a) * v, s: rnd(7, 12), c: pick(CONFETTI), shape: Math.random() < 0.75 ? 'rect' : 'circle', life: rnd(2200, 3200), drag: 0.965, g: 0.32, sway: rnd(0.3, 0.9) });
        }
      }
      run();
    },
    raise() { if (raf) show(); },
  };
})();
const confetti = (_colors, n) => FX.cannons(n);

// floating "+1.5 h" label
function floatText(el, text) {
  if (!el || !el.isConnected || reducedMotion.matches) return;
  const r = el.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'float-text'; f.textContent = text;
  f.style.left = `${r.left + r.width / 2}px`; f.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(f);
  f.addEventListener('animationend', () => f.remove());
}

// ---------- events ----------
const formVal = (f, n) => (f.elements[n] ? f.elements[n].value : '');
const minutesFrom = (f) => (Number(formVal(f, 'h')) || 0) * 60 + (Number(formVal(f, 'm')) || 0);

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = Number(el.dataset.id);
  try {
    switch (act) {
      case 'nav': view = el.dataset.v; store.set('view', view); closeSheet(); render(); scrollTo(0, 0); break;
      case 'auth-mode': renderAuth(el.dataset.v); break;
      case 'close': closeSheet(); break;
      case 'spin': spin(); break;
      case 'respin': closeSheet(); setTimeout(spin, 150); break;
      case 'item': itemSheet(id); break;
      case 'log': logSheet(id); break;
      case 'quick': { SFX.click(); const f = el.closest('form'); f.elements.h.value = el.dataset.h; f.elements.m.value = el.dataset.m; break; }
      case 'timer-start':
      {
        let prev = '';
        if (S.timer) {
          const name = S.timer.item_name;
          const r = await api('POST', '/api/timer/stop');
          if (r.logged >= 1) prev = `${T('Logged {time} on {name}', { time: hm(r.logged), name })}${r.earned && r.earned.total ? T(', +{n} points', { n: nf.format(r.earned.total) }) : ''}. `;
        }
        timerJustStarted = true;
        await api('POST', '/api/timer/start', { itemId: id, fromSpin: el.dataset.spin === '1' });
        SFX.start(); buzz(10);
        closeSheet(); toast(prev + T('Timer started. Have fun.')); scrollTo(0, 0);
      }
        break;
      case 'timer-stop': await stopTimer(); break;
      case 'timer-cancel':
        confirmSheet(T('Discard timer?'), T('The time on {name} won’t be logged.', { name: esc(S.timer.item_name) }), T('Discard'), async () => { await api('POST', '/api/timer/cancel'); SFX.thud(); });
        break;
      case 'archive': {
        const st = await api('PATCH', `/api/items/${id}`, { archived: el.dataset.v === '1' }); closeSheet();
        if (st.bonus) { setTimeout(() => { toast(T('+{n} points for finishing it', { n: nf.format(st.bonus.points) })); floatText($('.bankpill'), T('+{n} pts', { n: nf.format(st.bonus.points) })); SFX.fanfare(); FX.cannons(90); }, 100); break; }
        if (el.dataset.v === '1') { toast(T('Off the wheel. Hours kept.')); SFX.land(); FX.cannons(70); buzz([15, 40, 15]); }
        else SFX.pop();
        break;
      }
      case 'item-del': {
        const i = S.items.find((x) => x.id === id);
        confirmSheet(T('Delete this?'), T('{name} and its {time} of logged time will be gone for good.', { name: esc(i.name), time: hrs(i.minutes) }), T('Delete'), async () => { await api('DELETE', `/api/items/${id}`); SFX.thud(); });
        break;
      }
      case 'wish-del': {
        const w = S.wishes.find((x) => x.id === id);
        deleteWithUndo(`wish-${id}`, `/api/wishes/${id}`, () => { S.wishes = S.wishes.filter((x) => x.id !== id); }, T('{name} removed', { name: w ? w.name : '' }));
        break;
      }
      case 'buy': {
        const w = S.wishes.find((x) => x.id === id);
        confirmSheet(T('Buy it?'), `${T('This uses one unlock on <b>{name}</b>', { name: esc(w.name) })}${w.price != null ? ` (${money(w.price)})` : ''}.`, T('Yes, I’m buying it'), async () => {
          await api('POST', '/api/purchases', { wishId: id }); SFX.chaching(); buzz([15, 50, 30]); FX.cannons(150); toast(T('Enjoy it. You earned it.'));
        }, false);
        break;
      }
      case 'buy-other':
        openSheet(`${sheetHead(T('What did you buy?'))}
          <form class="stack" data-form="buy-other"><input class="input" name="name" maxlength="80" required placeholder="${T('New headphones')}" aria-label="${T('What you bought')}">
          <p class="form-error"></p><button class="btn primary block">${T('Use one unlock')}</button></form>`);
        break;
      case 'purchase-del':
        confirmSheet(T('Undo this purchase?'), T('You’ll get the unlock back. Use this if you returned it or logged it by mistake.'), T('Undo purchase'), async () => { await api('DELETE', `/api/purchases/${id}`); SFX.thud(); }, false);
        break;
      case 'log-del':
        closeSheet();
        deleteWithUndo(`log-${id}`, `/api/logs/${id}`, () => { S.logs = S.logs.filter((x) => x.id !== id); }, T('Session deleted'));
        break;
      case 'log-edit': editLogSheet(id); break;
      case 'goal': goalSheet(); break;
      case 'personalise': personaliseSheet(); break;
      case 'skin': {
        const y = sheet.scrollTop;
        await setPref('skin', el.dataset.v);
        personaliseSheet(); sheet.scrollTop = y;
        if (el.dataset.v !== 'none') { FX.cannons(90); SFX.fanfare(); toast(T('Secret theme on: {name}', { name: T(el.dataset.v === 'walnut' ? 'Walnut' : 'Doodle') })); }
        break;
      }
      case 'pref': {
        const key = el.dataset.k; let v = el.dataset.v;
        el.closest('[role="group"]')?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
        await setPref(key, v); SFX.click();
        if (key === 'spin' || key === 'neglect' || key === 'currency' || key === 'timeFormat') render();
        break;
      }
      case 'tour': tourSheet(Number(el.dataset.v) || 0); break;
      case 'tour-end':
        closeSheet();
        if (!pref('tourDone')) setPref('tourDone', true);
        if (el.dataset.start) { view = 'stuff'; store.set('view', view); render(); setTimeout(() => $('input[name="name"]')?.focus(), 300); }
        break;
      case 'nudge':
        F = await api('POST', '/api/nudge', { username: el.dataset.name });
        SFX.pop(); buzz(10); toast(T('Nudge sent to {name}', { name: el.dataset.name }));
        if (view === 'friends') $('#view').innerHTML = viewFriends();
        break;
      case 'goal-pick': { const i = sheet.querySelector('input[name="hours"]'); if (i) i.value = el.dataset.v; break; }
      case 'goal-remove': await api('PATCH', '/api/settings', { monthlyGoalHours: 0 }); closeSheet(); toast(T('Goal removed')); break;
      case 'timer-pause': case 'timer-resume':
        await api('POST', `/api/timer/${act === 'timer-pause' ? 'pause' : 'resume'}`, { at: now() }); SFX.click(); buzz(8);
        break;
      case 'snooze': {
        const days = Number(el.dataset.v);
        await api('PATCH', `/api/items/${id}`, { snoozeDays: days }); closeSheet();
        toast(days ? T('Off the wheel until {date}', { date: day(Date.now() + days * 86400000) }) : T('Back on the wheel'));
        break;
      }
      case 'stuff-sort': stuffSort = el.dataset.v; store.set('stuffSort', stuffSort); render(); break;
      case 'week': {
        selectedWeek = Number(el.dataset.i); SFX.click(); render(); break;
      }
      case 'settings': settingsSheet(); break;
      case 'filter': filters[el.dataset.v] = !filters[el.dataset.v]; store.set('filters', filters); SFX.click(); render(); break;
      case 'filter-kind': {
        const k = el.dataset.v;
        filters.kinds = filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k];
        store.set('filters', filters); SFX.click(); render(); break;
      }
      case 'filter-clear': filters = { quick: false, chill: false, kinds: [] }; store.set('filters', filters); SFX.click(); render(); break;
      case 'step-toggle': {
        const done = el.dataset.done === '1';
        const r = await api('PATCH', `/api/steps/${id}`, { done });
        const itemId = Number($('#steps', sheet)?.dataset.item);
        renderSteps(itemId, r.steps);
        if (done) {
          SFX.coin(); buzz(10);
          const li = $(`[data-act="step-toggle"][data-id="${id}"]`, sheet);
          FX.burstFrom(li, { n: 14, speed: 5 });
          if (r.steps.every((x) => x.done)) { SFX.fanfare(); FX.cannons(70); }
        } else SFX.click();
        break;
      }
      case 'step-del': {
        const itemId = Number($('#steps', sheet)?.dataset.item);
        deleteWithUndo(`step-${id}`, `/api/steps/${id}`, () => el.closest('li')?.remove(), T('Step deleted'), () => loadSteps(itemId));
        break;
      }
      case 'high-five': {
        F = await api('POST', '/api/high-five', { eventId: id });
        SFX.chaching(); buzz([10, 40, 10]); FX.burstFrom(el, { n: 22, speed: 7 });
        setTimeout(() => { if (view === 'friends') { $('#view').innerHTML = viewFriends(); } }, 250);
        break;
      }
      case 'badge': badgeSheet(el.dataset.key); break;
      case 'recap': recapSheet(); break;
      case 'whats-new': whatsNewSheet(); break;
      case 'stats': statsSheet(); break;
      case 'stats-days': { const y = sheet.scrollTop; await statsSheet(Number(el.dataset.v)); SFX.click(); sheet.scrollTop = y; break; }
      case 'stat-bar': selectStatBar(el); break;
      case 'board': boardPeriod = el.dataset.v; store.set('board', boardPeriod); SFX.click(); $('#view').innerHTML = viewFriends(); afterFriendsRender(); break;
      case 'friend': friendSheet(el.dataset.name); break;
      case 'friend-accept':
        F = await api('POST', '/api/friends/accept', { username: el.dataset.name });
        SFX.rankUp(); FX.burstFrom(el, { n: 20 }); toast(T('You and {name} are now friends', { name: el.dataset.name }));
        S.friendRequests = F.incoming.length; render();
        break;
      case 'friend-decline':
        F = await api('POST', '/api/friends/decline', { username: el.dataset.name }); SFX.thud(); S.friendRequests = F.incoming.length; render(); break;
      case 'friend-cancel':
        F = await api('POST', '/api/friends/cancel', { username: el.dataset.name }); SFX.thud(); $('#view').innerHTML = viewFriends(); afterFriendsRender(); break;
      case 'friend-remove': {
        const name = el.dataset.name;
        confirmSheet(T('Remove {name}?', { name: esc(name) }), T('You’ll stop seeing each other on the leaderboard. You can add each other again later.'), T('Remove friend'), async () => {
          F = await api('POST', '/api/friends/remove', { username: name }); SFX.thud(); toast(T('{name} removed', { name }));
          if (view === 'friends') { $('#view').innerHTML = viewFriends(); afterFriendsRender(); }
        });
        break;
      }
      case 'points-done': {
        const u = Number(el.dataset.unlocks), text = $('#pr-note', sheet)?.value.trim();
        closeSheet();
        if (text && el.dataset.log) api('PATCH', `/api/logs/${el.dataset.log}`, { note: text }).catch((err) => toast(err.message));
        if (u) setTimeout(() => celebrate(u), 150);
        break;
      }
      case 'session-revoke': await api('POST', '/api/sessions/revoke', { id: el.dataset.id }); SFX.thud(); loadDevices(); break;
      case 'sessions-others':
        confirmSheet(T('Sign out other devices?'), T('Every device except this one will need to sign in again.'), T('Sign them out'), async () => {
          await api('POST', '/api/sessions/revoke', { others: true }); SFX.thud(); toast(T('Other devices signed out')); setTimeout(settingsSheet, 0);
        });
        break;
      case 'user-reset': {
        const name = el.dataset.name;
        confirmSheet(T('Reset {name}’s password?', { name: esc(name) }), T('You’ll get a one-time code to send them. Their current password keeps working until they use it.'), T('Make reset code'), async () => {
          const r = await api('POST', `/api/admin/users/${id}/reset`);
          setTimeout(() => openSheet(`${sheetHead(T('Reset code'))}
            <p>${T('Send this to <b>{name}</b>. On the sign-in screen they tap “Use a reset code”. It works once, for 24 hours.', { name: esc(r.username) })}</p>
            <div class="key">${esc(r.code)}</div>
            <div class="sheet-actions"><button class="btn primary" data-act="copy-text" data-text="${esc(r.code)}">${ICON.copy}${T('Copy code')}</button>
            <button class="btn" data-act="settings">${T('Done')}</button></div>`), 0);
        }, false);
        break;
      }
      case 'user-remove': {
        const name = el.dataset.name;
        confirmSheet(T('Remove {name}?', { name: esc(name) }), T('This deletes {name}’s account and everything in it. It can’t be undone.', { name: esc(name) }), T('Remove account'), async () => {
          await api('POST', `/api/admin/users/${id}/delete`); SFX.thud(); toast(T('{name} removed', { name })); setTimeout(settingsSheet, 0);
        });
        break;
      }
      case 'copy-text': toast(await copyText(el.dataset.text) ? T('Copied') : T('Couldn’t copy. Select it and copy by hand.')); break;
      case 'lang':
        if (el.dataset.v !== LANG && LANGS[el.dataset.v]) { store.set('lang', el.dataset.v); if (S) store.set('reopen', 'settings'); location.reload(); }
        break;
      case 'privacy': privacySheet(); break;
      case 'password':
        openSheet(`${sheetHead(T('Change password'))}
          <form class="stack" data-form="password">
            <div class="field"><label for="pc">${T('Current password')}</label><input class="input" id="pc" name="current" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="pn">${T('New password')}</label><input class="input" id="pn" name="next" type="password" autocomplete="new-password" minlength="${config.passwordMin || 10}" maxlength="256" required>
              <span class="hint">${T('At least {n} characters. A few random words works well. Other devices get signed out.', { n: config.passwordMin || 10 })}</span></div>
            <p class="form-error"></p><button class="btn primary block">${T('Change password')}</button></form>`);
        break;
      case 'logout': await api('POST', '/api/logout'); forgetDevice(); S = null; closeSheet(); renderAuth('login'); break;
      case 'account-del':
        openSheet(`${sheetHead(T('Delete your account?'))}
          <p>${T('This deletes your stuff, hours, wishlist and purchases. It can’t be undone. Export your data first if you want a copy.')}</p>
          <form class="stack" data-form="account-del">
            <div class="field"><label for="pd">${T('Password')}</label><input class="input" id="pd" name="password" type="password" autocomplete="current-password" required></div>
            <p class="form-error"></p><button class="btn danger block">${T('Delete my account')}</button></form>`);
        break;
    }
  } catch (err) {
    if (!err.signedOut) toast(err.message);
  }
});

// Personalise: on/off switches save as soon as they change
document.addEventListener('change', (e) => {
  const key = e.target.dataset && e.target.dataset.pref;
  if (!key) return;
  setPref(key, e.target.checked); SFX.click(); buzz(5);
  if (key === 'private' && e.target.checked) toast(T('Private mode is on. Friends can’t see you now.'));
});
// My stuff: search filters the rows in place, so the keyboard stays open
document.addEventListener('input', (e) => {
  if (e.target.id !== 'stuff-search') return;
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#stuff-list > li').forEach((li) => { const hit = !q || li.dataset.name.includes(q); li.hidden = !hit; shown += hit; });
  const none = $('#stuff-none'); if (none) none.hidden = shown > 0;
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const errEl = $('.form-error', f);
  const btn = f.querySelector('button:not([type="button"])');
  if (btn) btn.disabled = true;
  try {
    switch (f.dataset.form) {
      case 'login':
      case 'register':
        await api('POST', '/api/' + f.dataset.form, { username: formVal(f, 'username'), password: formVal(f, 'password') });
        config.firstUser = false;
        await api('GET', '/api/state');
        if (S && !pref('tourDone') && !S.items.length) enqueue(() => tourSheet(0));
        break;
      case 'reset':
        await api('POST', '/api/reset-password', { username: formVal(f, 'username'), code: formVal(f, 'code'), password: formVal(f, 'password') });
        await api('GET', '/api/state');
        toast(T('Password changed. You’re signed in.'));
        break;
      case 'add-item': {
        const kind = f.querySelector('input[name="kind"]:checked')?.value || 'hobby';
        const name = formVal(f, 'name');
        const addBtn = f.querySelector('button');
        const [bx, by] = (() => { const r = addBtn.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })();
        const before = new Set(S.items.map((i) => i.id));
        freshId = null;
        const st = await api('POST', '/api/items', { name, kind });
        const added = st.items.find((i) => !before.has(i.id));
        if (added) { freshId = added.id; render(); setTimeout(() => { freshId = null; }, 1500); }
        SFX.pop(); buzz(8);
        FX.burst(bx, by, { n: 16, colors: added ? [colorOf(added), colorOf(added), '#5457E0'] : CONFETTI, speed: 6 });
        toast(T('{name} is on the wheel', { name: name.trim() }));
        $('input[name="name"]', $('form[data-form="add-item"]'))?.focus();
        break;
      }
      case 'edit-item':
        await api('PATCH', `/api/items/${f.dataset.id}`, { name: formVal(f, 'name'), kind: f.querySelector('input[name="ekind"]:checked')?.value,
          quick: f.elements.quick.checked, chill: f.elements.chill.checked });
        closeSheet(); toast(T('Saved'));
        break;
      case 'log': {
        const minutes = minutesFrom(f);
        if (minutes < 1) throw new Error(T('Add at least 1 minute'));
        const [y, mo, d] = formVal(f, 'date').split('-').map(Number);
        const date = y ? new Date(y, mo - 1, d) : new Date();
        const isToday = date.toDateString() === new Date().toDateString();
        const endedAt = isToday ? undefined : new Date(y, mo - 1, d, 20, 0).getTime();
        const r = await api('POST', '/api/logs', { itemId: Number(formVal(f, 'itemId')), minutes, endedAt, note: formVal(f, 'note') || undefined });
        afterLog(r);
        break;
      }
      case 'stop-adjust': {
        const r = await api('POST', '/api/timer/stop', { minutes: minutesFrom(f) });
        afterLog(r);
        break;
      }
      case 'goal': {
        const h = Number(formVal(f, 'hours'));
        if (!(h >= 1 && h <= 300)) throw new Error(T('Pick between 1 and 300 hours'));
        await api('PATCH', '/api/settings', { monthlyGoalHours: h });
        closeSheet(); SFX.pop(); toast(T('Goal set: {h} h a month', { h }));
        break;
      }
      case 'log-edit': {
        const minutes = minutesFrom(f);
        if (minutes < 1) throw new Error(T('Add at least 1 minute'));
        await api('PATCH', `/api/logs/${f.dataset.id}`, { minutes, note: formVal(f, 'note') });
        closeSheet(); SFX.pop(); toast(T('Saved'));
        break;
      }
      case 'add-friend': {
        const r = await api('POST', '/api/friends/request', { username: formVal(f, 'username') });
        F = r; S.friendRequests = r.incoming.length;
        if (r.accepted) { SFX.rankUp(); toast(T('You and {name} are now friends', { name: r.accepted })); render(); }
        else { SFX.pop(); toast(T('Request sent to {name}', { name: r.sent })); $('#view').innerHTML = viewFriends(); afterFriendsRender(); }
        break;
      }
      case 'add-step': {
        const r = await api('POST', `/api/items/${f.dataset.item}/steps`, { text: formVal(f, 'text') });
        renderSteps(Number(f.dataset.item), r.steps); SFX.pop();
        $('#steps input[name="text"]', sheet)?.focus();
        break;
      }
      case 'add-wish':
        { const r = f.querySelector('button').getBoundingClientRect();
          await api('POST', '/api/wishes', { name: formVal(f, 'name'), price: formVal(f, 'price') });
          SFX.pop(); buzz(8); FX.burst(r.left + r.width / 2, r.top + r.height / 2, { n: 14, speed: 6 }); }
        break;
      case 'buy-other':
        await api('POST', '/api/purchases', { name: formVal(f, 'name') });
        closeSheet(); SFX.chaching(); buzz([15, 50, 30]); FX.cannons(150); toast(T('Enjoy it. You earned it.'));
        break;
      case 'settings':
        await api('PATCH', '/api/settings', { hoursPerUnlock: Number(formVal(f, 'hours')) });
        closeSheet(); toast(T('Saved'));
        break;
      case 'password':
        await api('POST', '/api/password', { current: formVal(f, 'current'), next: formVal(f, 'next') });
        closeSheet(); toast(T('Password changed. Other devices are signed out.'));
        break;
      case 'account-del':
        await api('POST', '/api/account/delete', { password: formVal(f, 'password') });
        closeSheet(); forgetDevice(); S = null; store.set('hadAccount', false); renderAuth('register', T('Your account is deleted.'));
        break;
    }
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
    else if (['login', 'register', 'reset'].includes(f.dataset.form)) { const a = $('#auth-error'); if (a) a.textContent = err.message; }
    else toast(err.message);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

// keep phone and laptop in sync
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !S || spinning || sheet.open) return;
  try {
    const c = await (await fetch('/api/config')).json();
    // a new version was deployed while this tab was open: reload to get the new code
    if (config.version && c.version && c.version !== config.version) { location.reload(); return; }
    config = c;
  } catch { /* offline */ }
  await flushQueue();
  api('GET', '/api/state').then(() => setOffline(!!queue().length)).catch(() => {});
  if (view === 'friends') loadFriends(true);
});
let resizeT = null;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (view === 'spin' && !spinning) drawWheel(); }, 120); });
document.fonts?.ready.then(() => { if (S && view === 'spin') drawWheel(); });

// ---------- boot ----------
(async () => {
  try { config = await (await fetch('/api/config')).json(); } catch { /* defaults */ }
  try { await api('GET', '/api/state'); } catch (e) {
    const cached = e.network && store.get('lastState', null);
    if (!S && cached) { setState(cached); setOffline(true); } else if (!S) renderAuth();
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(PAGE_VERSION)}`).catch(() => {});
  if (S) {
    flushQueue();
    store.set('hadAccount', true);
    // coming back from a language switch in Settings
    if (store.get('reopen', null) === 'settings') { store.set('reopen', null); settingsSheet(); }
    shortcut();
    if (!pref('tourDone') && !S.items.length) enqueue(() => tourSheet(0));
    announceUpdate();
    const ws = S.score && S.score.weekStart; const prev = ws && new Date(ws); if (prev) prev.setDate(prev.getDate() - 7);
    if (prev && pref('popups') && !store.get(`recap.${prev.getTime()}`, false) && S.logs.length) enqueue(() => recapSheet(true));
  }
})();
