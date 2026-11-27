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

let S = null;               // server state
let config = { firstUser: false, defaultHours: 20 };
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
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error(T('Can’t reach the server. Check your connection.')); }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && data.error === 'Sign in to continue') { S = null; closeSheet(); renderAuth(); throw Object.assign(new Error(TS(data.error)), { signedOut: true }); }
  if (!res.ok) throw new Error(data.error ? TS(data.error) : T('Request failed ({n})', { n: res.status }));
  if (data && Array.isArray(data.items)) setState(data);
  if (data && Array.isArray(data.achievements) && data.achievements.length && url !== '/api/achievements') {
    const list = data.achievements; enqueue(() => showAchievements(list));
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
function setState(d) { S = d; clockOffset = d.now - Date.now(); render(); }

// ---------- formatting ----------
const nf = new Intl.NumberFormat(LOCALE);
const nf1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const round1 = (n) => nf1.format(Math.round(n * 10) / 10);   // for display only
function hrs(min) { return min < 60 && min > 0 ? T('{m} min', { m: min }) : T('{h} h', { h: round1(min / 60) }); }
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
const money = (p) => p == null ? '' : new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR', maximumFractionDigits: p % 1 ? 2 : 0 }).format(p);
const colorOf = (item) => INKS[(item.id - 1) % INKS.length];
const active = () => S.items.filter((i) => !i.archived);

// Quick filters for the wheel: tags (AND) and kinds (any of).
let filters = store.get('filters', { quick: false, chill: false, kinds: [] });
const filtering = () => filters.quick || filters.chill || filters.kinds.length > 0;
function wheelItems() {
  return active().filter((i) => (!filters.quick || i.quick) && (!filters.chill || i.chill) && (!filters.kinds.length || filters.kinds.includes(i.kind)));
}

// Neglected things get bigger slices: 1× if touched today, up to 3× after four weeks or never.
function weightOf(item) {
  if (!item.last_at) return 3;
  const days = (now() - item.last_at) / 86400000;
  return 1 + Math.min(Math.max(days, 0), 28) / 14;
}
function odds(item) {
  const list = active();
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

function timerBar() {
  if (!S.timer) return '';
  const enter = timerJustStarted; timerJustStarted = false;
  return `<div class="timerbar ${enter ? 'enter' : ''}" role="timer">
    <div class="what"><span>${T('Timing')}</span><b>${esc(S.timer.item_name)}</b></div>
    <span class="clock" id="clock">${clock(now() - S.timer.started_at)}</span>
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
    </section>`;
}

function streakCard() {
  const sc = S.score; if (!sc) return '';
  const left = sc.streakDoneToday ? null : Math.max(1, sc.streakGoal - sc.todayMinutes);
  const line = sc.streak === 0
    ? T('Do {m} min today to start a streak', { m: left })
    : sc.streakDoneToday
      ? (sc.nextMilestone ? Tn(sc.nextMilestone.days - sc.streak, '1 more day to the {days}-day bonus', '{n} more days to the {days}-day bonus', { days: sc.nextMilestone.days }) : T('Legendary streak'))
      : T('Do {m} min today to keep it going', { m: left });
  return `<button class="streak surface ${sc.streak && !sc.streakDoneToday ? 'at-risk' : ''}" data-act="nav" data-v="friends">
    <span class="flame ${sc.streak ? 'lit' : ''}">${ICON.flame}</span>
    <span class="main"><b>${sc.streak ? Tn(sc.streak, '1-day streak', '{n}-day streak') : T('No streak yet')}${sc.streakBonus ? ` <span class="pill">+${sc.streakBonus}%</span>` : ''}</b><span class="muted small">${line}</span></span>
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
    : `${KINDS[i.kind]}${i.steps_total ? T(', {done}/{total} steps', { done: i.steps_done, total: i.steps_total }) : ''}, ${ago(i.last_at)}, ${T('{n}% odds', { n: odds(i) })}`;
  return `<li class="${i.id === freshId ? 'fresh' : ''}"><button class="item-row" data-act="item" data-id="${i.id}">
    <span class="dot" style="background:${i.archived ? 'var(--surface-2)' : colorOf(i)}"></span>
    <span class="main"><span class="name">${esc(i.name)}</span><span class="meta">${meta}</span></span>
    <span class="hrs">${i.minutes ? hrs(i.minutes) : ''}</span>
    <span class="chev">${ICON.chev}</span>
  </button></li>`;
}
function viewStuff() {
  const list = active();
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
      ${list.length
        ? `<ul class="list">${list.map(itemRow).join('')}</ul>
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
        <input class="input" name="price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="€" aria-label="${T('Price in euro')}" style="width:84px">
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
      </div>
    </section>

    ${F.incoming.length ? `<section class="section"><h2>${T('Friend requests')}</h2><ul class="list">${F.incoming.map((r) => `<li><div class="plain-row">
        ${avatar(r.username)}<div class="main"><div class="name">${esc(r.username)}</div><div class="muted small">${T('wants to be friends')}</div></div>
        <button class="btn small primary" data-act="friend-accept" data-name="${esc(r.username)}">${T('Accept')}</button>
        <button class="icon-btn" data-act="friend-decline" data-name="${esc(r.username)}" aria-label="${T('Decline {name}', { name: esc(r.username) })}">${ICON.x}</button>
      </div></li>`).join('')}</ul></section>` : ''}

    <section class="section">
      <div class="seg" role="tablist" aria-label="${T('Leaderboard period')}">${PERIODS.map(([k, l]) => `<button role="tab" aria-selected="${k === boardPeriod}" data-act="board" data-v="${k}">${l}</button>`).join('')}</div>
      ${hasFriends ? `<ol class="board">${board.map((e) => `<li>
          <button class="board-row ${e.you ? 'me' : ''}" ${e.you ? 'disabled' : `data-act="friend" data-name="${esc(e.username)}"`}>
            <span class="rank r${e.rank}">${e.rank}</span>
            ${avatar(e.username)}
            <span class="main"><span class="name">${e.you ? T('You') : esc(e.username)}</span>
              <span class="muted small">${hm(e.minutes)}${e.streak ? ` <span class="mini-flame">${ICON.flame}</span>${e.streak}` : ''}</span></span>
            <b class="score">${nf.format(e.points)}</b>
          </button></li>`).join('')}</ol>`
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
      ${S.logs.length ? `<ul class="list">${S.logs.slice(0, 20).map((l) => `<li><div class="plain-row">
          <div class="main"><div class="name">${esc(l.item_name)}</div><div class="muted small">${day(l.ended_at)}, ${l.source === 'timer' ? T('timed') : T('added by hand')}</div></div>
          <span class="sess"><b>${hm(l.minutes)}</b>${l.points ? `<span class="muted small">${T('+{n} pts', { n: nf.format(l.points) })}</span>` : ''}</span>
          <button class="icon-btn" data-act="log-del" data-id="${l.id}" aria-label="${T('Delete this session')}">${ICON.x}</button>
        </div></li>`).join('')}</ul>`
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
      <p>${T('You. Friends see your points, hours and streak, and moments like streaks and badges, never what you do or what’s on your wishlist. The admin sees usernames and when accounts were made and last used, to keep the site running.')}</p>
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
function settingsSheet() {
  const u = S.user;
  openSheet(`${sheetHead(T('Settings'))}
    <form class="stack" data-form="settings">
      <h3>${T('Hours per new purchase')}</h3>
      <div class="row"><input class="input" id="hpu" name="hours" type="number" min="1" max="500" step="0.25" value="${u.hoursPerUnlock}" aria-label="${T('Hours per new purchase')}" style="width:110px"><button class="btn">${T('Save')}</button></div>
      <p class="hint">${T('The default is 20 h. That’s roughly what it takes to get past the clumsy beginner stage of a skill (Josh Kaufman’s 20-hour rule), so you actually enjoy what you own before buying more. At a few hours a week it also adds a 3 to 6 week cooling-off period, longer than the popular 30-day rule against impulse buys.')}</p>
    </form>
    <div class="sheet-section">
      <h3>${T('Language')}</h3>
      ${langSwitch()}
    </div>
    ${u.isAdmin ? `<div class="sheet-section"><div class="section-head"><h3>${T('People')}</h3><span class="muted small">${Tn(u.userCount, '1 account', '{n} accounts')}</span></div><div id="people"><p class="hint">${T('Loading…')}</p></div></div>` : ''}
    <div class="sheet-section">
      <h3>${T('Signed-in devices')}</h3>
      <div id="devices"><p class="hint">${T('Loading…')}</p></div>
    </div>
    <div class="sheet-section">
      <h3>${T('Account')}</h3>
      <div class="row wrap">
        <button class="btn small" data-act="sound">${store.get('sound', true) ? T('Wheel sound on') : T('Wheel sound off')}</button>
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
          <div class="muted small">${x.current ? T('This device') : T('{seen}, signed in {date}', { seen: seen(x.lastSeen), date: esc(day(x.createdAt)) })}</div></div>
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
  const turns = reducedMotion.matches ? 1 : 5 + Math.floor(Math.random() * 3);
  const endRot = startRot + turns * TAU + mod(target - startRot, TAU);
  const dur = reducedMotion.matches ? 700 : 4200 + Math.random() * 1200;
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
  animateDim(1, () => setTimeout(() => showResult(item), reducedMotion.matches ? 0 : 220));
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
    if (!store.get('sound', true)) return null;
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
const buzz = (pattern) => { try { if (store.get('sound', true)) navigator.vibrate?.(pattern); } catch { /* unsupported */ } };

function tick() {
  const ptr = $('#pointer');
  if (ptr) { ptr.classList.remove('tick', 'land'); void ptr.offsetWidth; ptr.classList.add('tick'); }
  SFX.tick(); buzz(4);
}

// ---------- sheets ----------
const sheet = $('#sheet');
function openSheet(html, onOpen) {
  sheet.innerHTML = `<div class="sheet-body">${html}</div>`;
  if (!sheet.open) sheet.showModal();
  FX.raise();
  onOpen && onOpen(sheet);
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => setTimeout(runQueue, 350));
sheet.addEventListener('close', () => { if (wheelWinner && !spinning && $('#wheel')) animateDim(0); else wheelWinner = null; });
const sheetHead = (title) => `<div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="close" aria-label="${T('Close')}">${ICON.x}</button></div>`;

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
      <button class="btn" data-act="log" data-id="${i.id}">${T('Log time')}</button></div>`}
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
function tickTimer() {
  clearInterval(timerInt);
  if (!S || !S.timer) return;
  const upd = () => { const el = $('#clock'); if (el && S.timer) el.textContent = clock(now() - S.timer.started_at); };
  upd(); timerInt = setInterval(upd, 1000);
}
async function stopTimer() {
  const elapsed = Math.round((now() - S.timer.started_at) / 60000);
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
    <button class="btn primary block" data-act="points-done" data-unlocks="${r.newUnlocks || 0}">${r.newUnlocks ? T('Nice. And there’s more…') : T('Nice')}</button>`);
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
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800);
}
// ---------- particles ----------
const FX = (() => {
  const cv = $('#confetti'); const ctx = cv.getContext('2d');
  let parts = [], raf = 0, dpr = 1, last = 0;
  const off = () => reducedMotion.matches;
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
      case 'wish-del': await api('DELETE', `/api/wishes/${id}`); SFX.thud(); break;
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
      case 'log-del': await api('DELETE', `/api/logs/${id}`); SFX.thud(); toast(T('Session deleted')); break;
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
        const r = await api('DELETE', `/api/steps/${id}`);
        renderSteps(Number($('#steps', sheet)?.dataset.item), r.steps); SFX.thud(); break;
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
      case 'points-done': { const u = Number(el.dataset.unlocks); closeSheet(); if (u) setTimeout(() => celebrate(u), 150); break; }
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
      case 'sound': store.set('sound', !store.get('sound', true)); settingsSheet(); break;
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
      case 'logout': await api('POST', '/api/logout'); S = null; closeSheet(); renderAuth('login'); break;
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
        const r = await api('POST', '/api/logs', { itemId: Number(formVal(f, 'itemId')), minutes, endedAt });
        afterLog(r);
        break;
      }
      case 'stop-adjust': {
        const r = await api('POST', '/api/timer/stop', { minutes: minutesFrom(f) });
        afterLog(r);
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
        closeSheet(); S = null; store.set('hadAccount', false); renderAuth('register', T('Your account is deleted.'));
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
  api('GET', '/api/state').catch(() => {});
  if (view === 'friends') loadFriends(true);
});
let resizeT = null;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (view === 'spin' && !spinning) drawWheel(); }, 120); });
document.fonts?.ready.then(() => { if (S && view === 'spin') drawWheel(); });

// ---------- boot ----------
(async () => {
  try { config = await (await fetch('/api/config')).json(); } catch { /* defaults */ }
  try { await api('GET', '/api/state'); } catch { if (!S) renderAuth(); }
  if (S) {
    store.set('hadAccount', true);
    // coming back from a language switch in Settings
    if (store.get('reopen', null) === 'settings') { store.set('reopen', null); settingsSheet(); }
    announceUpdate();
    const ws = S.score && S.score.weekStart; const prev = ws && new Date(ws); if (prev) prev.setDate(prev.getDate() - 7);
    if (prev && !store.get(`recap.${prev.getTime()}`, false) && S.logs.length) enqueue(() => recapSheet(true));
  }
})();
