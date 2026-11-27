'use strict';
/* bored? — client */
const TAU = Math.PI * 2;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Soft slice colors that all carry the same dark text.
const INKS = ['#FFB4A2', '#A6C8FF', '#FFD873', '#A3DFB8', '#CDBBFF', '#FFB8D2', '#93DCE0'];
const SLICE_TEXT = '#1D1E22';
const CONFETTI = [...INKS, '#5457E0'];
const KINDS = { hobby: 'Hobby', game: 'Game', project: 'Project', learning: 'Learning', other: 'Other' };
const KICKERS = [
  'The wheel has spoken.', 'Tonight you’re doing:', 'Skip the shop. Do this:', 'You already own the fun:',
  'Dust this one off:', 'Your past self bought this for a reason:', 'Here’s your plan:',
];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('bored.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('bored.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let S = null;               // server state
let config = { needsInvite: true, defaultHours: 20 };
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
  try { res = await fetch(url, opts); } catch { throw new Error('Can’t reach the server. Check your connection.'); }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && data.error === 'Sign in to continue') { S = null; renderAuth(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  if (data && Array.isArray(data.items)) setState(data);
  return data;
}
const now = () => Date.now() + clockOffset;
function setState(d) { S = d; clockOffset = d.now - Date.now(); render(); }

// ---------- formatting ----------
const round1 = (n) => Math.round(n * 10) / 10;
function hrs(min) { return min < 60 && min > 0 ? `${min} min` : `${round1(min / 60)} h`; }
function hm(min) { const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`; }
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function ago(ts) {
  if (!ts) return 'never touched';
  const d = Math.floor((now() - ts) / 86400000);
  if (d <= 0) return 'touched today';
  if (d === 1) return 'touched yesterday';
  if (d < 60) return `touched ${d} days ago`;
  return `touched ${Math.round(d / 30)} months ago`;
}
function listedFor(ts) {
  const d = Math.max(0, Math.floor((now() - ts) / 86400000));
  return d === 0 ? 'added today' : `on your list for ${d} day${d === 1 ? '' : 's'}`;
}
const day = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const money = (p) => p == null ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: p % 1 ? 2 : 0 }).format(p);
const colorOf = (item) => INKS[(item.id - 1) % INKS.length];
const active = () => S.items.filter((i) => !i.archived);

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
  pointer: '<svg viewBox="0 0 30 34"><path d="M15 32c-1 0-1.7-.6-2.2-1.4L4.2 12.8A11.5 11.5 0 1 1 25.8 12.8l-8.6 17.8c-.5.8-1.2 1.4-2.2 1.4Z" fill="currentColor"/></svg>',
};

// ---------- rendering ----------
function render() {
  if (!S) return renderAuth();
  const app = $('#app');
  const views = { spin: viewSpin, stuff: viewStuff, shop: viewShop, stats: viewStats };
  if (!views[view]) view = 'spin';
  const tabs = [['spin', 'Spin'], ['stuff', 'My stuff'], ['shop', 'Wishlist'], ['stats', 'Stats']];
  app.innerHTML = `
    <div class="app-wrap">
      <div class="shell">
        <header class="top">
          <h1 class="logo">bored?</h1>
          ${bankPill()}
          <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button>
        </header>
        ${timerBar()}
        <main class="view" id="view">${views[view]()}</main>
      </div>
      <nav class="nav" aria-label="Sections"><div class="nav-inner">
        ${tabs.map(([k, l]) => `<button data-act="nav" data-v="${k}" ${view === k ? 'aria-current="page"' : ''}><span class="ico">${ICON[k]}</span><span>${l}</span></button>`).join('')}
      </div></nav>
    </div>`;
  if (view === 'spin') drawWheel();
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
    ? `${b.unlocks} buy${b.unlocks > 1 ? 's' : ''} ready`
    : `${round1(b.progressMinutes / 60)} / ${round1(b.costMinutes / 60)} h`;
  return `<button class="bankpill ${b.unlocks ? 'ready' : ''}" data-act="nav" data-v="shop" aria-label="${esc(label)}, open wishlist">${ring}<span>${label}</span></button>`;
}

function timerBar() {
  if (!S.timer) return '';
  const enter = timerJustStarted; timerJustStarted = false;
  return `<div class="timerbar ${enter ? 'enter' : ''}" role="timer">
    <div class="what"><span>Timing</span><b>${esc(S.timer.item_name)}</b></div>
    <span class="clock" id="clock">${clock(now() - S.timer.started_at)}</span>
    <button class="btn small" data-act="timer-stop">Stop</button>
    <button class="icon-btn" data-act="timer-cancel" aria-label="Discard timer">${ICON.x}</button>
  </div>`;
}

function meter(b) {
  const pct = Math.min(100, (b.progressMinutes / b.costMinutes) * 100);
  const from = lastPct == null || lastPct > pct ? (lastPct == null ? pct : 0) : lastPct;
  return `<div class="meter-track" role="progressbar" aria-valuemin="0" aria-valuemax="${b.costMinutes}" aria-valuenow="${b.progressMinutes}" aria-label="Progress to next buy">
    <div class="meter-fill" style="width:${from}%" data-to="${pct}"></div></div>`;
}

// --- Spin
function viewSpin() {
  const list = active();
  const b = S.bank;
  if (list.length < 2) {
    return `<section class="empty surface">
      <h2>${list.length ? 'One more' : 'Nothing to spin yet'}</h2>
      <p class="muted">Add the hobbies, games and half-finished projects you already have. You need at least two to spin.</p>
      <button class="btn primary" data-act="nav" data-v="stuff">Add your stuff</button>
    </section>`;
  }
  const toGo = b.costMinutes - b.progressMinutes;
  return `<section class="wheel-area">
      <div class="wheel-wrap">
        <span class="pointer" id="pointer" aria-hidden="true">${ICON.pointer}</span>
        <canvas id="wheel" role="img" aria-label="Wheel with ${list.length} things: ${esc(list.map((i) => i.name).join(', '))}"></canvas>
        <button class="hub" id="hub" data-act="spin">Spin</button>
      </div>
      <div class="meter">
        <div class="meter-label">
          ${b.unlocks
            ? `<span><b>${b.unlocks} buy${b.unlocks > 1 ? 's' : ''} unlocked.</b> Next one in ${hrs(toGo)}.</span>`
            : `<span><b>${hrs(toGo)}</b> to go until your next buy</span>`}
          <span class="muted">${round1(b.progressMinutes / 60)} / ${round1(b.costMinutes / 60)} h</span>
        </div>
        ${meter(b)}
      </div>
    </section>`;
}

// --- Stuff
function kindPicker(name, current) {
  return `<div class="kinds" role="radiogroup" aria-label="Type">${Object.entries(KINDS).map(([k, l]) =>
    `<input type="radio" name="${name}" id="${name}-${k}" value="${k}" ${k === current ? 'checked' : ''}><label for="${name}-${k}">${l}</label>`).join('')}</div>`;
}
function itemRow(i) {
  const meta = i.archived
    ? `${KINDS[i.kind]}, ${hrs(i.minutes)} logged`
    : `${KINDS[i.kind]}, ${ago(i.last_at)}, ${odds(i)}% odds`;
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
      <h2>Add something you already have</h2>
      <form class="stack surface pad" data-form="add-item">
        <div class="row">
          <input class="input grow" name="name" placeholder="Unfinished puzzle, Elden Ring, guitar…" maxlength="60" required aria-label="Name">
          <button class="btn primary">Add</button>
        </div>
        ${kindPicker('kind', 'hobby')}
      </form>
    </section>
    <section class="section">
      <div class="section-head"><h2>On the wheel</h2><span class="muted small">${list.length} thing${list.length === 1 ? '' : 's'}</span></div>
      ${list.length
        ? `<ul class="list">${list.map(itemRow).join('')}</ul>
           <p class="hint">Things you haven’t touched in a while get a bigger slice, up to three times bigger after four weeks.</p>`
        : `<p class="muted">Nothing here yet. Start with whatever is gathering dust closest to you.</p>`}
    </section>
    ${done.length ? `<details class="more section"><summary>Done or retired (${done.length})</summary>
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
        ? `<div><div class="big">${b.unlocks}</div><p><b>new buy${b.unlocks > 1 ? 's' : ''} unlocked</b></p></div>
           <p class="muted">You earned it. Pick something from your list, or log what you bought.</p>`
        : `<div><div class="big">${hrs(toGo)}</div><p><b>to go until your next buy</b></p></div>`}
      ${meter(b)}
      <p class="muted small">Every ${costH} h you spend on stuff you already own unlocks one new purchase.</p>
    </section>
    <section class="section">
      <h2>Wishlist</h2>
      <form class="row surface pad" data-form="add-wish">
        <input class="input grow" name="name" placeholder="What are you craving?" maxlength="80" required aria-label="Wish">
        <input class="input" name="price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="€" aria-label="Price in euro" style="width:84px">
        <button class="btn primary">Add</button>
      </form>
      ${wishes.length ? `<ul class="list">${wishes.map((w) => `<li><div class="plain-row">
          <div class="main"><div class="name">${esc(w.name)}</div>
            <div class="muted small">${w.price != null ? money(w.price) + ', ' : ''}${listedFor(w.created_at)}</div></div>
          <button class="btn small ${b.unlocks ? 'primary' : ''}" data-act="buy" data-id="${w.id}" ${b.unlocks ? '' : 'disabled'}>${b.unlocks ? 'Buy it' : 'Locked'}</button>
          <button class="icon-btn" data-act="wish-del" data-id="${w.id}" aria-label="Remove ${esc(w.name)}">${ICON.x}</button>
        </div></li>`).join('')}</ul>
        <p class="hint">Still want it after a few weeks? Then it’s probably worth it.</p>`
      : `<p class="muted">Park the things you want here instead of in a shopping cart.</p>`}
      ${b.unlocks ? `<button class="btn block" data-act="buy-other">I bought something else</button>` : ''}
    </section>
    ${S.purchases.length ? `<section class="section"><h2>Bought</h2><ul class="list">
      ${S.purchases.map((p) => `<li><div class="plain-row">
        <div class="main"><div class="name">${esc(p.name)}</div><div class="muted small">${day(p.created_at)}, earned with ${hrs(p.cost_minutes)}</div></div>
        <button class="icon-btn" data-act="purchase-del" data-id="${p.id}" aria-label="Undo purchase of ${esc(p.name)}">${ICON.x}</button>
      </div></li>`).join('')}</ul></section>` : ''}`;
}

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
      <div class="tile surface"><div class="v">${round1(b.earnedMinutes / 60)}</div><div class="k">hours total</div></div>
      <div class="tile surface"><div class="v">${round1(ws[ws.length - 1].minutes / 60)}</div><div class="k">hours this week</div></div>
      <div class="tile surface"><div class="v">${b.purchasesCount}</div><div class="k">buys earned and used</div></div>
    </section>

    <section class="section">
      <h2>Hours per week</h2>
      <div class="surface chart">
      <p class="chart-caption" id="week-caption">${selectedWeek === ws.length - 1 ? 'This week' : 'Week of ' + day(sel.start)}: <b>${hm(sel.minutes)}</b></p>
      <div>
        <div class="weeks">${ws.map((w, i) => `<button data-act="week" data-i="${i}" aria-pressed="${i === selectedWeek}" aria-label="Week of ${day(w.start)}: ${hm(w.minutes)}">
          <span class="bar" style="height:${(w.minutes / max) * 100}%"></span></button>`).join('')}</div>
        <div class="weeks-axis" aria-hidden="true">${ws.map((w) => `<span>${day(w.start)}</span>`).join('')}</div>
      </div>
      </div>
    </section>

    ${byItem.length ? `<section class="section"><h2>Where your time went</h2><div class="hbars surface">
      ${byItem.map((i) => `<div class="hbar"><span class="lbl">${esc(i.name)}</span><span class="val">${hrs(i.minutes)}</span>
        <div class="track"><div class="fill" style="width:${(i.minutes / top) * 100}%"></div></div></div>`).join('')}
    </div></section>` : ''}

    <section class="section">
      <h2>Recent sessions</h2>
      ${S.logs.length ? `<ul class="list">${S.logs.slice(0, 20).map((l) => `<li><div class="plain-row">
          <div class="main"><div class="name">${esc(l.item_name)}</div><div class="muted small">${day(l.ended_at)}, ${l.source === 'timer' ? 'timed' : 'added by hand'}</div></div>
          <b>${hm(l.minutes)}</b>
          <button class="icon-btn" data-act="log-del" data-id="${l.id}" aria-label="Delete this session">${ICON.x}</button>
        </div></li>`).join('')}</ul>`
      : `<p class="muted">No sessions yet. Spin the wheel and start a timer.</p>`}
    </section>`;
}

// --- Auth
const urlInvite = new URLSearchParams(location.search).get('invite') || '';
function renderAuth(mode, error = '') {
  if (!mode) mode = urlInvite || !config.needsInvite ? 'register' : 'login';
  const reg = mode === 'register';
  const first = reg && !config.needsInvite;
  $('#app').innerHTML = `
    <main class="auth">
      <div class="stack" style="gap:10px">
        <h1 class="logo">bored?</h1>
        <p class="tag">Spin for something you already own. Spend some time on it. Earn the next new thing.</p>
      </div>
      <form class="stack surface auth-card" data-form="${reg ? 'register' : 'login'}">
        <h2>${reg ? 'Create an account' : 'Sign in'}</h2>
        ${first ? `<p class="note">You’re the first one here, so this account becomes the admin. You’ll get an invite key to share with others.</p>` : ''}
        <div class="field"><label for="u">Username</label>
          <input class="input" id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="${reg ? 3 : 1}" maxlength="32"></div>
        <div class="field"><label for="p">Password${reg ? ', at least 8 characters' : ''}</label>
          <input class="input" id="p" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="${reg ? 8 : 1}"></div>
        ${reg && !first ? `<div class="field"><label for="inv">Invite key</label>
          <input class="input" id="inv" name="invite" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="xxxx-xxxx-xxxx-xxxx" value="${esc(urlInvite)}">
          <span class="hint">Ask the person who runs this site for one.</span></div>` : ''}
        <p class="form-error" id="auth-error">${esc(error)}</p>
        <button class="btn primary block">${reg ? 'Create account' : 'Sign in'}</button>
      </form>
      ${first ? '' : `<p class="muted" style="text-align:center">${reg ? 'Already have an account?' : 'Got an invite key?'}
        <button class="auth-switch" data-act="auth-mode" data-v="${reg ? 'login' : 'register'}">${reg ? 'Sign in' : 'Create an account'}</button></p>`}
    </main>`;
  $('#u').focus();
}

// --- Settings
function settingsSheet() {
  const u = S.user;
  openSheet(`${sheetHead('Settings')}
    ${u.isAdmin ? `<div class="stack" style="gap:10px">
      <h3>Invite key</h3>
      <p class="hint">People need this key to create an account. It works any number of times. ${u.userCount} account${u.userCount === 1 ? '' : 's'} so far.</p>
      <div class="key" id="invite-key">${esc(u.inviteKey)}</div>
      <div class="sheet-actions">
        <button class="btn primary" data-act="copy-key">${ICON.copy}Copy key</button>
        <button class="btn" data-act="copy-link">Copy sign-up link</button>
      </div>
      <button class="btn ghost" data-act="regen-key">Make a new key</button>
    </div>` : ''}
    <form class="stack ${u.isAdmin ? 'sheet-section' : ''}" data-form="settings">
      <h3>Hours per new purchase</h3>
      <div class="row"><input class="input" id="hpu" name="hours" type="number" min="1" max="500" step="0.25" value="${u.hoursPerUnlock}" aria-label="Hours per new purchase" style="width:110px"><button class="btn">Save</button></div>
      <p class="hint">The default is 20 h. That’s roughly what it takes to get past the clumsy beginner stage of a skill (Josh Kaufman’s 20-hour rule), so you actually enjoy what you own before buying more. At a few hours a week it also adds a 3 to 6 week cooling-off period, longer than the popular 30-day rule against impulse buys.</p>
    </form>
    <div class="sheet-section">
      <h3>Account</h3>
      <div class="row wrap">
        <button class="btn small" data-act="sound">${store.get('sound', true) ? 'Wheel sound on' : 'Wheel sound off'}</button>
        <a class="btn small" href="/api/export" download>Export my data</a>
        <button class="btn small" data-act="password">Change password</button>
      </div>
      <div class="row wrap">
        <button class="btn small" data-act="logout">Sign out ${esc(u.username)}</button>
        ${u.isAdmin ? '' : '<button class="btn small danger" data-act="account-del">Delete account</button>'}
      </div>
    </div>
    <p class="hint" style="text-align:center">bored? version ${esc(config.version || 'dev')}${config.buildDate ? `, built ${esc(new Date(config.buildDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}</p>`);
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
  const list = active();
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
sheet.addEventListener('close', () => { if (wheelWinner && !spinning && $('#wheel')) animateDim(0); else wheelWinner = null; });
const sheetHead = (title) => `<div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>`;

function showResult(item) {
  const kicker = KICKERS[Math.floor(Math.random() * KICKERS.length)];
  const running = S.timer;
  openSheet(`
    <div class="sheet-head"><p class="result-kicker">${kicker}</p><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
    <div class="stack" style="gap:10px">
      <span class="result-tag" style="background:${colorOf(item)}">${KINDS[item.kind]}</span>
      <div class="result-name">${esc(item.name)}</div>
      <p class="muted">${item.minutes ? hrs(item.minutes) + ' so far' : 'No time logged yet'}, ${ago(item.last_at)}.</p>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" data-act="timer-start" data-id="${item.id}">${running ? 'Stop current timer and start this' : 'Start timer'}</button>
      <button class="btn" data-act="log" data-id="${item.id}">Log time</button>
    </div>
    <button class="btn ghost" data-act="respin">Spin again</button>`);
  FX.burstFrom($('.result-name', sheet), { n: 22, colors: [colorOf(item), colorOf(item), '#5457E0', '#FFD873'], speed: 9 });
}

function logSheet(itemId) {
  const items = active();
  const all = items.some((i) => i.id === itemId) ? items : S.items;
  const today = new Date(); const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  openSheet(`${sheetHead('Log time')}
    <form class="stack" data-form="log">
      <div class="field"><label for="log-item">On</label>
        <select class="input" id="log-item" name="itemId">${all.map((i) => `<option value="${i.id}" ${i.id === itemId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></div>
      <div class="field"><label>How long</label>
        <div class="row">
          <input class="input" name="h" type="number" inputmode="numeric" min="0" max="24" value="1" aria-label="Hours" style="width:90px"><span>h</span>
          <input class="input" name="m" type="number" inputmode="numeric" min="0" max="59" step="5" value="0" aria-label="Minutes" style="width:90px"><span>min</span>
        </div>
        <div class="row" style="flex-wrap:wrap">${[[0, 30], [1, 0], [2, 0], [3, 0]].map(([h, m]) => `<button type="button" class="btn small" data-act="quick" data-h="${h}" data-m="${m}">${hm(h * 60 + m)}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="log-date">When</label>
        <input class="input" id="log-date" name="date" type="date" value="${iso(today)}" max="${iso(today)}"></div>
      <p class="form-error"></p>
      <button class="btn primary block">Log time</button>
    </form>`);
}

function itemSheet(id) {
  const i = S.items.find((x) => x.id === id);
  if (!i) return;
  openSheet(`${sheetHead(esc(i.name))}
    <p class="muted">${hrs(i.minutes)} over ${i.sessions} session${i.sessions === 1 ? '' : 's'}, ${ago(i.last_at)}.${i.archived ? '' : ` ${odds(i)}% chance on the next spin.`}</p>
    ${i.archived ? '' : `<div class="sheet-actions">
      <button class="btn primary" data-act="timer-start" data-id="${i.id}">${S.timer ? 'Switch timer to this' : 'Start timer'}</button>
      <button class="btn" data-act="log" data-id="${i.id}">Log time</button></div>`}
    <form class="stack" data-form="edit-item" data-id="${i.id}">
      <div class="field"><label for="ename">Name</label><input class="input" id="ename" name="name" value="${esc(i.name)}" maxlength="60" required></div>
      ${kindPicker('ekind', i.kind)}
      <p class="form-error"></p>
      <button class="btn">Save changes</button>
    </form>
    <div class="sheet-actions">
      ${i.archived
        ? `<button class="btn" data-act="archive" data-id="${i.id}" data-v="0">Put back on the wheel</button>`
        : `<button class="btn" data-act="archive" data-id="${i.id}" data-v="1">${i.kind === 'project' ? 'Finished it' : 'Retire it'}</button>`}
      <button class="btn danger" data-act="item-del" data-id="${i.id}">Delete</button>
    </div>
    <p class="muted small">Finished and retired things leave the wheel but keep their hours. Deleting also removes the hours.</p>`);
}

function confirmSheet(title, text, label, onYes, danger = true) {
  openSheet(`${sheetHead(title)}<p>${text}</p>
    <div class="sheet-actions"><button class="btn" data-act="close">Cancel</button>
    <button class="btn ${danger ? 'danger' : 'primary'}" id="yes">${label}</button></div>`, (el) => {
    $('#yes', el).addEventListener('click', async () => { try { await onYes(); closeSheet(); } catch (e) { toast(e.message); } });
  });
}

function celebrate(newUnlocks) {
  if (!newUnlocks) return;
  SFX.fanfare(); buzz([20, 60, 20, 60, 40]);
  openSheet(`${sheetHead('You unlocked a buy')}
    <p class="big" style="color:var(--accent)">+${newUnlocks}</p>
    <p>You put in the hours on stuff you already own. Go pick something from your wishlist.</p>
    <div class="sheet-actions"><button class="btn primary" data-act="nav" data-v="shop">Open wishlist</button><button class="btn" data-act="close">Later</button></div>`);
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
    openSheet(`${sheetHead('That was a long one')}
      <p>The timer ran for <b>${hm(elapsed)}</b> on ${esc(S.timer.item_name)}. Forgot to stop it? Keep only the real part.</p>
      <form class="stack" data-form="stop-adjust">
        <div class="row">
          <input class="input" name="h" type="number" min="0" max="24" value="${Math.floor(Math.min(elapsed, 1440) / 60)}" aria-label="Hours" style="width:90px"><span>h</span>
          <input class="input" name="m" type="number" min="0" max="59" value="${Math.min(elapsed, 1440) % 60}" aria-label="Minutes" style="width:90px"><span>min</span>
        </div>
        <button class="btn primary block">Log this</button>
      </form>`);
    return;
  }
  const r = await api('POST', '/api/timer/stop');
  afterLog(r);
}
function afterLog(r) {
  closeSheet();
  if (r.logged >= 1) {
    toast(`Logged ${hm(r.logged)}. Nice.`);
    if (!r.newUnlocks) { SFX.coin(); buzz(15); }
    if (!r.newUnlocks) floatText($('.bankpill'), `+${hm(r.logged)}`);
  } else toast('Under a minute, so nothing logged.');
  celebrate(r.newUnlocks);
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
          if (r.logged >= 1) prev = `Logged ${hm(r.logged)} on ${name}. `;
        }
        timerJustStarted = true;
        await api('POST', '/api/timer/start', { itemId: id });
        SFX.start(); buzz(10);
        closeSheet(); toast(prev + 'Timer started. Have fun.'); scrollTo(0, 0);
      }
        break;
      case 'timer-stop': await stopTimer(); break;
      case 'timer-cancel':
        confirmSheet('Discard timer?', `The time on ${esc(S.timer.item_name)} won’t be logged.`, 'Discard', async () => { await api('POST', '/api/timer/cancel'); SFX.thud(); });
        break;
      case 'archive': await api('PATCH', `/api/items/${id}`, { archived: el.dataset.v === '1' }); closeSheet();
        if (el.dataset.v === '1') { toast('Off the wheel. Hours kept.'); SFX.land(); FX.cannons(70); buzz([15, 40, 15]); }
        else SFX.pop();
        break;
      case 'item-del': {
        const i = S.items.find((x) => x.id === id);
        confirmSheet('Delete this?', `${esc(i.name)} and its ${hrs(i.minutes)} of logged time will be gone for good.`, 'Delete', async () => { await api('DELETE', `/api/items/${id}`); SFX.thud(); });
        break;
      }
      case 'wish-del': await api('DELETE', `/api/wishes/${id}`); SFX.thud(); break;
      case 'buy': {
        const w = S.wishes.find((x) => x.id === id);
        confirmSheet('Buy it?', `This uses one unlock on <b>${esc(w.name)}</b>${w.price != null ? ` (${money(w.price)})` : ''}.`, 'Yes, I’m buying it', async () => {
          await api('POST', '/api/purchases', { wishId: id }); SFX.chaching(); buzz([15, 50, 30]); FX.cannons(150); toast('Enjoy it. You earned it.');
        }, false);
        break;
      }
      case 'buy-other':
        openSheet(`${sheetHead('What did you buy?')}
          <form class="stack" data-form="buy-other"><input class="input" name="name" maxlength="80" required placeholder="New headphones" aria-label="What you bought">
          <p class="form-error"></p><button class="btn primary block">Use one unlock</button></form>`);
        break;
      case 'purchase-del':
        confirmSheet('Undo this purchase?', 'You’ll get the unlock back. Use this if you returned it or logged it by mistake.', 'Undo purchase', async () => { await api('DELETE', `/api/purchases/${id}`); SFX.thud(); }, false);
        break;
      case 'log-del': await api('DELETE', `/api/logs/${id}`); SFX.thud(); toast('Session deleted'); break;
      case 'week': {
        selectedWeek = Number(el.dataset.i); SFX.click(); render(); break;
      }
      case 'settings': settingsSheet(); break;
      case 'sound': store.set('sound', !store.get('sound', true)); settingsSheet(); break;
      case 'copy-key': toast(await copyText(S.user.inviteKey) ? 'Invite key copied' : 'Couldn’t copy. Select the key and copy it by hand.'); break;
      case 'copy-link': toast(await copyText(`${location.origin}/?invite=${encodeURIComponent(S.user.inviteKey)}`) ? 'Sign-up link copied' : 'Couldn’t copy the link'); break;
      case 'regen-key':
        confirmSheet('Make a new invite key?', 'The current key stops working right away. Accounts that already exist keep working.', 'Make new key', async () => {
          await api('POST', '/api/admin/invite'); setTimeout(settingsSheet, 0); toast('New invite key ready');
        }, false);
        break;
      case 'password':
        openSheet(`${sheetHead('Change password')}
          <form class="stack" data-form="password">
            <div class="field"><label for="pc">Current password</label><input class="input" id="pc" name="current" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="pn">New password (at least 8 characters)</label><input class="input" id="pn" name="next" type="password" autocomplete="new-password" minlength="8" required></div>
            <p class="form-error"></p><button class="btn primary block">Change password</button></form>`);
        break;
      case 'logout': await api('POST', '/api/logout'); S = null; renderAuth(); break;
      case 'account-del':
        openSheet(`${sheetHead('Delete your account?')}
          <p>This deletes your stuff, hours, wishlist and purchases. It can’t be undone. Export your data first if you want a copy.</p>
          <form class="stack" data-form="account-del">
            <div class="field"><label for="pd">Password</label><input class="input" id="pd" name="password" type="password" autocomplete="current-password" required></div>
            <p class="form-error"></p><button class="btn danger block">Delete my account</button></form>`);
        break;
    }
  } catch (err) {
    if (err.message !== 'Sign in to continue') toast(err.message);
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
        await api('POST', '/api/' + f.dataset.form, { username: formVal(f, 'username'), password: formVal(f, 'password'), invite: formVal(f, 'invite') || undefined });
        if (urlInvite) history.replaceState(null, '', '/');
        if (f.dataset.form === 'register') config.needsInvite = true;
        await api('GET', '/api/state');
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
        toast(`${name.trim()} is on the wheel`);
        $('input[name="name"]', $('form[data-form="add-item"]'))?.focus();
        break;
      }
      case 'edit-item':
        await api('PATCH', `/api/items/${f.dataset.id}`, { name: formVal(f, 'name'), kind: f.querySelector('input[name="ekind"]:checked')?.value });
        closeSheet(); toast('Saved');
        break;
      case 'log': {
        const minutes = minutesFrom(f);
        if (minutes < 1) throw new Error('Add at least 1 minute');
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
      case 'add-wish':
        { const r = f.querySelector('button').getBoundingClientRect();
          await api('POST', '/api/wishes', { name: formVal(f, 'name'), price: formVal(f, 'price') });
          SFX.pop(); buzz(8); FX.burst(r.left + r.width / 2, r.top + r.height / 2, { n: 14, speed: 6 }); }
        break;
      case 'buy-other':
        await api('POST', '/api/purchases', { name: formVal(f, 'name') });
        closeSheet(); SFX.chaching(); buzz([15, 50, 30]); FX.cannons(150); toast('Enjoy it. You earned it.');
        break;
      case 'settings':
        await api('PATCH', '/api/settings', { hoursPerUnlock: Number(formVal(f, 'hours')) });
        closeSheet(); toast('Saved');
        break;
      case 'password':
        await api('POST', '/api/password', { current: formVal(f, 'current'), next: formVal(f, 'next') });
        closeSheet(); toast('Password changed. Other devices are signed out.');
        break;
      case 'account-del':
        await api('POST', '/api/account/delete', { password: formVal(f, 'password') });
        closeSheet(); S = null; renderAuth('login', 'Your account is deleted.');
        break;
    }
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
    else if (f.dataset.form === 'login' || f.dataset.form === 'register') { const a = $('#auth-error'); if (a) a.textContent = err.message; }
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
});
let resizeT = null;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (view === 'spin' && !spinning) drawWheel(); }, 120); });
document.fonts?.ready.then(() => { if (S && view === 'spin') drawWheel(); });

// ---------- boot ----------
(async () => {
  try { config = await (await fetch('/api/config')).json(); } catch { /* defaults */ }
  try { await api('GET', '/api/state'); } catch { if (!S) renderAuth(); }
})();
