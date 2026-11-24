// The whole app: setup, home screen, logging sheets, editing, contacts and settings.
// Data lives in db.js, calculations in logic.js. This file only draws screens and reacts to taps.

import * as db from './db.js';
import * as L from './logic.js';

const PEOPLE = ['Sergio', 'Ana Rita'];
const COLORS = { Yellow: '#e8c547', Green: '#6b8e3a', Brown: '#8a5a2b', Black: '#222', Red: '#c0392b', White: '#f4f4f4' };
const ROLES = ['Pediatrician', 'Hospital', 'Emergency', 'Nurse line', 'Pharmacy', 'Family', 'Babysitter', 'Other'];
const WINDOW_DAYS = 7; // the live view keeps the last week; older days load on request
// Sleep options: [stored value, label]. Labels also go to Notion as-is.
const SLEEP_OPTS = {
  cover: [['swaddle', 'Swaddle'], ['sleeping_bag', 'Sleeping bag'], ['blanket', 'Blanket']],
  location: [['bassinet', 'Bedside bassinet'], ['crib', 'Crib'], ['cot', 'Cot'], ['other', 'Other']],
  sound: [['silence', 'Silence'], ['white_noise', 'White noise'], ['music', 'Music']],
};
const optLabel = (field, v) => (SLEEP_OPTS[field]?.find(o => o[0] === v) || [])[1] || '';

const store = {
  get: k => { try { return localStorage.getItem('picos.' + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('picos.' + k, v); } catch {} },
};

const S = {
  fid: store.get('family'),
  me: store.get('me'),
  baby: null,
  entries: [], older: [], olderFrom: null,
  pending: new Set(),
  contacts: [], contactsPending: new Set(),
  milk: [], milkPending: new Set(), // milk portions still holding milk
  view: 'home',
  sheet: null, // { kind, ...data } while a sheet is open
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const buzz = () => navigator.vibrate?.(25);

// ---------- Theme ----------
// 'light' (default), 'dark', or 'night' = dark from 8 PM to 7 AM.
function applyTheme() {
  const t = store.get('theme') || 'light';
  const h = new Date().getHours(), night = h >= 20 || h < 7;
  const dark = t === 'dark' || (t === 'night' && night);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#16131a' : '#faf7f2');
}
applyTheme();
setInterval(applyTheme, 60000);

// ---------- Formatting ----------
const pad = n => String(n).padStart(2, '0');
function dur(ms) {
  const m = Math.max(0, Math.round(ms / L.MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${pad(r)}` : `${h} h`;
}
function ago(t) {
  const ms = Date.now() - t;
  if (ms < L.MIN) return 'just now';
  if (ms < L.DAY) return dur(ms);
  return `${Math.floor(ms / L.DAY)} d`;
}
const agoLong = t => { const a = ago(t); return a === 'just now' ? a : `${a} ago`; };
function clockTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function toInput(t) { const d = new Date(t); return new Date(t - d.getTimezoneOffset() * L.MIN).toISOString().slice(0, 16); }
function fromInput(v) { return v ? new Date(v).getTime() : null; }
function dayLabel(t) {
  const d0 = L.startOfDay(t), today = L.startOfDay();
  if (d0 === today) return 'Today';
  if (d0 === L.startOfDay(today - 1)) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}
function babyAge(birth) {
  if (!birth) return '';
  const b = new Date(birth + 'T00:00').getTime();
  const days = Math.floor((L.startOfDay() - b) / L.DAY);
  if (days < 0) return `due in ${-days} day${days === -1 ? '' : 's'}`;
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  if (days < 84) return `${Math.floor(days / 7)} weeks ${days % 7 ? `${days % 7} d` : ''} old`;
  return `${Math.floor(days / 30.44)} months old`;
}
const side = k => (k === 'left' ? 'Left' : 'Right');
function bottleSource(e) {
  if (e.source === 'formula') return ' formula';
  if (e.uses?.length) return ` · ${e.uses.map(u => u.code).join(' + ')}`;
  return '';
}
const PLACE = { fridge: 'Fridge', freezer: 'Freezer', thawed: 'Thawed' };
const shortDate = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
// "in 3 d", "in 5 h", "expired 2 h ago", "in 4 months"
function untilText(t, now = Date.now()) {
  const ms = t - now, a = Math.abs(ms);
  const s = a < L.HOUR ? `${Math.max(1, Math.round(a / L.MIN))} min` : a < 2 * L.DAY ? `${Math.round(a / L.HOUR)} h`
    : a < 60 * L.DAY ? `${Math.round(a / L.DAY)} d` : `${Math.round(a / (30.44 * L.DAY))} months`;
  return ms > 0 ? `use within ${s}` : `expired ${s} ago`;
}
const whoTag = by => by ? `<span class="who ${by === 'Sergio' ? 's' : 'a'}">${by === 'Sergio' ? 'S' : 'AR'}</span>` : '';

function describe(e) {
  if (e.type === 'feed') {
    if (L.isBreast(e)) return { ic: '🤱', what: `${side(e.kind)} breast · ${e.end == null ? 'feeding…' : dur(e.end - e.start)}` };
    if (e.kind === 'bottle') return { ic: '🍼', what: `Bottle · ${e.ml || 0} ml${bottleSource(e)}` };
    return { ic: '🫙', what: `Pumped · ${e.ml || 0} ml` }; // logged before Pump had its own button
  }
  if (e.type === 'pump') return { ic: '🫙', what: `Pumped ${side(e.kind)} · ${e.ml || 0} ml${e.code ? ` · ${e.code}` : ''}` };
  if (e.type === 'diaper') {
    const k = { wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' }[e.kind] || 'Diaper';
    return { ic: '🧷', what: `${k}${e.color ? ` · ${e.color}` : ''}` };
  }
  const extra = [e.period === 'night' ? '🌙' : e.period === 'day' ? '☀️' : '', optLabel('location', e.location), optLabel('cover', e.cover)].filter(Boolean);
  return { ic: '😴', what: (e.end == null ? 'Sleeping…' : `Slept ${dur(e.end - e.start)}`) + (extra.length ? ` · ${extra.join(' · ')}` : '') };
}

// ---------- Data wiring ----------
function all() { return L.visible([...S.entries, ...S.older.filter(o => !S.entries.some(e => e.id === o.id))]); }

let unsub = [];
function start() {
  db.connect(S.fid);
  unsub.forEach(u => u());
  const since = L.startOfDay() - (WINDOW_DAYS - 1) * L.DAY;
  S.olderFrom = since;
  unsub = [
    db.watchEntries(since, ({ list, pending }) => { S.entries = list; S.pending = pending; render(); }),
    db.watchContacts(({ list, pending }) => { S.contacts = list; S.contactsPending = pending; if (S.view === 'contacts') render(); }),
    db.watchBaby(b => { S.baby = b; render(); }),
    db.watchMilk(({ list, pending }) => { S.milk = list; S.milkPending = pending; if (S.sheet?.kind === 'feed') { if (S.sheet.showNote) S.sheet.note = readNote(); drawSheet(); } render(); }),
    db.watchMilkCounter(),
  ];
}

function logEntry(fields, { toastText, undo = true, extra = [] } = {}) {
  const id = db.newId();
  const now = Date.now();
  const e = { id, type: fields.type, kind: fields.kind ?? null, start: fields.start ?? now, end: fields.end ?? null,
    ml: fields.ml ?? null, color: fields.color ?? null, note: fields.note ?? '', by: S.me, createdAt: now, deleted: false };
  if (e.type === 'diaper' || (e.type === 'feed' && !['left', 'right'].includes(e.kind))) e.end = e.start;
  if (e.type === 'sleep') for (const k of L.SLEEP_FIELDS) e[k] = fields[k] ?? null;
  if (e.type === 'pump') { e.end = e.start; Object.assign(e, { code: fields.code ?? null, seq: fields.seq ?? null, fridgeMl: fields.fridgeMl ?? 0, freezerMl: fields.freezerMl ?? 0, portions: fields.portions ?? [] }); }
  if (e.kind === 'bottle') { e.source = fields.source ?? null; e.uses = fields.uses ?? []; }
  db.saveEntry(id, e);
  if (e.uses?.length) for (const u of e.uses) db.adjustMilk(u.id, -u.ml);
  buzz();
  const actions = [];
  if (undo) actions.push({ label: 'Undo', fn: () => { db.saveEntry(id, { deleted: true }); returnMilk(e); } });
  actions.push(...extra(id));
  if (e.type !== 'pump') actions.push({ label: 'Note', fn: () => openEdit(id, true) });
  toast(toastText, actions);
  return id;
}

// ---------- Actions from the big buttons ----------
function stopFeed(e) {
  const end = Date.now();
  db.saveEntry(e.id, { end });
  buzz();
  const other = e.kind === 'left' ? 'right' : 'left';
  toast(`${side(e.kind)} · ${dur(end - e.start)} saved`, [
    { label: 'Undo', fn: () => db.saveEntry(e.id, { end: null }) },
    { label: `Start ${side(other)}`, fn: () => logEntry({ type: 'feed', kind: other }, { toastText: `${side(other)} breast started`, extra: () => [] }) },
  ]);
}

// Sleep card: Start saves a new sleep with the chosen details; Woke up stops the running one.
function stopSleep() {
  const running = all().find(e => e.id === S.sheet.runningId);
  if (!running) return closeSheet();
  const end = Date.now();
  closeSheet(); // also saves a changed temperature or note
  db.saveEntry(running.id, { end });
  buzz();
  toast(`Woke up · slept ${dur(end - running.start)}`, [
    { label: 'Undo', fn: () => db.saveEntry(running.id, { end: null }) },
    { label: 'Edit', fn: () => openEdit(running.id) },
  ]);
}
// While a sleep is running, taps on its options save at once; typed fields save when the card closes.
function saveRunningSleepText() {
  const sh = S.sheet, running = all().find(e => e.id === sh.runningId);
  if (!running) return;
  const fields = {};
  const t = readTemp(); if (t !== (running.tempC ?? null)) fields.tempC = t;
  const note = readNote(); if (note !== (running.note || '')) fields.note = note;
  if (Object.keys(fields).length) db.saveEntry(running.id, fields);
}
function openSleep() {
  const list = all(), running = L.runningSleep(list);
  if (!running) {
    // One tap starts the timer; the card opens so details can be set while it counts.
    const d = L.sleepDefaults(list);
    const id = logEntry({ type: 'sleep', ...d }, { toastText: 'Asleep from now', extra: () => [] });
    return openSheet('sleep', { runningId: id, sleepStart: Date.now(), d });
  }
  const d = Object.fromEntries(L.SLEEP_FIELDS.map(k => [k, running[k] ?? null]));
  d.period ??= L.dayOrNight(running.start);
  d.nightLight = !!d.nightLight;
  openSheet('sleep', { runningId: running.id, sleepStart: running.start, d, note: running.note || '', showNote: !!running.note });
}
// Keep typed values when the card redraws after a tap.
function keepSleepInputs() {
  if (S.sheet.d) S.sheet.d.tempC = readTemp();
  if (S.sheet.showNote) S.sheet.note = readNote();
}
function sleepDetails(d) {
  const chips = f => `<div class="seg">${SLEEP_OPTS[f].map(([v, l]) => `<button class="chip ${d[f] === v ? 'on' : ''}" data-sl="${f}:${v}">${l}</button>`).join('')}</div>`;
  return `<div class="daynight">
      <button class="dn ${d.period === 'day' ? 'on' : ''}" data-sl="period:day"><span class="emoji">☀️</span>Day</button>
      <button class="dn ${d.period === 'night' ? 'on' : ''}" data-sl="period:night"><span class="emoji">🌙</span>Night</button></div>
    <div class="section-label">Cover</div>${chips('cover')}
    <div class="section-label">Where</div>${chips('location')}
    <div class="section-label">Sound</div>${chips('sound')}
    <label class="check"><input type="checkbox" id="sl-light" ${d.nightLight ? 'checked' : ''}><span>💡 Night light on</span></label>
    <label class="field"><span>Room temperature</span><div class="temp-row"><input type="number" inputmode="decimal" step="0.5" min="10" max="40" id="sl-temp" value="${d.tempC ?? ''}"><b>°C</b></div></label>`;
}
function readTemp() {
  const v = $('#sl-temp')?.value;
  if (v == null) return S.sheet?.d?.tempC ?? L.SLEEP_TEMP_DEFAULT;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

// ---------- Rendering ----------
function render() {
  const app = $('#app');
  if (!S.fid || !S.me) return renderSetup(app);
  if (S.view === 'contacts') return renderContacts(app);
  if (S.view === 'stock') return renderStock(app);
  if (S.view === 'settings') return renderSettings(app);
  renderHome(app);
}

function syncBadge() {
  const n = S.pending.size + S.contactsPending.size + S.milkPending.size;
  const offline = !navigator.onLine;
  const text = n ? `${n} waiting to sync${offline ? ' (offline)' : ''}` : offline ? 'Offline · saved on phone' : 'Synced';
  return `<span class="sync ${n || offline ? 'waiting' : ''}"><span class="dot"></span>${text}</span>`;
}

function renderHome(app) {
  const list = all();
  const now = Date.now();
  const sess = L.lastFeedSession(list);
  const feedRun = L.runningFeed(list);
  const diaper = L.lastDiaper(list);
  const sl = L.sleepState(list, now);
  const t = L.todayTotals(list, now);
  const next = L.nextSide(list);

  let feedTile;
  if (feedRun) feedTile = `<button class="tile feed running" data-edit="${feedRun.id}"><div class="label">Feeding now</div>
      <div class="big" data-timer="${feedRun.start}">${clockTimer(now - feedRun.start)}</div><div class="small">${side(feedRun.kind)} breast</div></button>`;
  else if (sess) {
    const sides = sess.parts.map(p => L.isBreast(p) ? side(p.kind) : p.kind === 'bottle' ? `${p.ml} ml` : '').filter(Boolean).join(' + ');
    feedTile = `<div class="tile feed"><div class="label">Last feed</div><div class="big" data-ago="${sess.start}">${ago(sess.start)}</div>
      <div class="small">${esc(sides)} · next: <b>${side(next)}</b></div></div>`;
  } else feedTile = `<div class="tile feed"><div class="label">Last feed</div><div class="big">–</div><div class="small">next: ${side(next)}</div></div>`;

  const diaperTile = `<div class="tile diaper"><div class="label">Last diaper</div>
    <div class="big" ${diaper ? `data-ago="${diaper.start}"` : ''}>${diaper ? ago(diaper.start) : '–'}</div>
    <div class="small">${diaper ? esc(describe(diaper).what) : 'none yet'}</div></div>`;

  const sleepTile = `<div class="tile sleep ${sl?.asleep ? 'running' : ''}"><div class="label">${sl ? (sl.asleep ? 'Asleep for' : 'Awake for') : 'Sleep'}</div>
    <div class="big" ${sl ? `data-ago="${sl.since}"` : ''}>${sl ? ago(sl.since) : '–'}</div>
    <div class="small">${sl ? `since ${clock(sl.since)}` : 'none yet'}</div></div>`;

  const todayTile = `<div class="tile today"><div class="label">Today</div><div class="today-grid">
    <b>${t.feeds}</b><span>feeds${t.breastMin ? ` · ${t.breastMin} min breast` : ''}</span>
    ${t.bottleMl ? `<b>${t.bottleMl}</b><span>ml bottle</span>` : ''}
    ${t.pumpMl ? `<b>${t.pumpMl}</b><span>ml pumped</span>` : ''}
    <b>${t.wet}/${t.dirty}</b><span>wet / dirty</span>
    <b>${dur(t.sleepMs)}</b><span>sleep</span></div></div>`;

  // Timeline grouped by day
  let rows = '', lastDay = null;
  for (const e of list) {
    const d = dayLabel(e.start);
    if (d !== lastDay) { rows += `<div class="day">${d}</div>`; lastDay = d; }
    const { ic, what } = describe(e);
    rows += `<button class="row" data-edit="${e.id}"><span class="ic">${ic}</span><span class="main">
      <div class="what">${esc(what)}${whoTag(e.by)}${S.pending.has(e.id) ? ' <span class="waiting-mark">⏳</span>' : ''}</div>
      ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</span><span class="time">${clock(e.start)}</span></button>`;
  }
  if (!list.length) rows = `<div class="empty">Nothing logged yet.<br>Tap a big button below to start.</div>`;

  const sleepBtn = sl?.asleep
    ? `<button class="act sleep running" data-act="sleep"><span class="emoji">🌤️</span>Woke up<span class="hint" data-ago="${sl.since}">${ago(sl.since)}</span></button>`
    : `<button class="act sleep" data-act="sleep"><span class="emoji">😴</span>Sleep<span class="hint">${sl ? `awake ${ago(sl.since)}` : 'start'}</span></button>`;
  const feedBtn = feedRun
    ? `<button class="act feed running" data-act="stopfeed"><span class="emoji">⏹️</span>Stop feed<span class="hint" data-timer="${feedRun.start}">${side(feedRun.kind)} ${clockTimer(now - feedRun.start)}</span></button>`
    : `<button class="act feed" data-act="feed"><span class="emoji">🍼</span>Feed<span class="hint">next: ${side(next)}</span></button>`;

  const st = L.stockTotals(S.milk, now);
  const flag = st.expired ? `<span class="flag bad">${st.expired} expired</span>` : st.soon ? `<span class="flag soon">${st.soon} use soon</span>` : '';
  const stockLine = `<button class="stockline" data-nav="stock"><span class="emoji">🧊</span>
    ${st.fridge || st.freezer ? `<span>Fridge <b>${st.fridge} ml</b> · Freezer <b>${st.freezer} ml</b></span>` : '<span>Milk stock · empty</span>'}${flag}<span class="chev">›</span></button>`;
  const lastP = L.lastPump(list);

  app.innerHTML = `<div class="screen">
    <div class="topbar"><div class="grow"><h1>${esc(S.baby?.name || 'Baby')}</h1>
      <div class="sub">${esc(babyAge(S.baby?.birth))} ${syncBadge()}</div></div>
      <button class="iconbtn" data-nav="contacts" aria-label="Contacts">📞</button>
      <button class="iconbtn" data-nav="settings" aria-label="Settings">⚙️</button></div>
    <div class="now">${feedTile}${diaperTile}${sleepTile}${todayTile}</div>
    ${rows}
    <button class="more" data-act="older">Show earlier days</button>
  </div>
  <div class="bar"><div class="bar-wrap">${stockLine}<div class="bar-inner">${feedBtn}
    <button class="act pump" data-act="pump"><span class="emoji">🫙</span>Pump<span class="hint">${lastP ? agoLong(lastP.start) : ''}</span></button>
    ${sleepBtn}
    <button class="act diaper" data-act="diaper"><span class="emoji">🧷</span>Diaper<span class="hint" ${diaper ? `data-ago="${diaper.start}"` : ''}>${diaper ? agoLong(diaper.start) : ''}</span></button>
    </div></div></div>`;
}

// Live clocks without redrawing the whole screen.
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-timer]').forEach(el => {
    const txt = el.textContent.replace(/[\d:]+$/, '');
    el.textContent = txt + clockTimer(now - +el.dataset.timer);
  });
}, 1000);
setInterval(() => { if (S.view === 'home' && !S.sheet && S.fid && S.me) render(); }, 30000);
window.addEventListener('online', render);
window.addEventListener('offline', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// ---------- Sheets ----------
function openSheet(kind, data = {}) {
  if (!S.sheet) history.pushState({ sheet: true }, '');
  S.sheet = { kind, start: null, color: null, note: '', showNote: false, ...data };
  drawSheet();
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
}
function closeSheet(fromBack = false) {
  if (!S.sheet) return;
  if (S.sheet.kind === 'sleep' && S.sheet.runningId) saveRunningSleepText();
  S.sheet = null;
  $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true;
  if (!fromBack) { S.ignorePop = true; history.back(); }
  render();
}

function timeChips() {
  const opts = [[null, 'Now'], [5, '5 min ago'], [15, '15 min ago'], [30, '30 min ago'], [60, '1 h ago']];
  const sel = S.sheet.startOffset ?? null;
  const custom = S.sheet.startOffset === 'custom';
  return `<div class="timeline-chips">${opts.map(([v, l]) => `<button class="chip ${sel === v ? 'on' : ''}" data-offset="${v ?? ''}">${l}</button>`).join('')}
    <button class="chip ${custom ? 'on' : ''}" data-offset="custom">Other…</button></div>
    ${custom ? `<label class="field"><span>Started at</span><input type="datetime-local" id="custom-time" value="${toInput(S.sheet.customTime || Date.now())}"></label>` : ''}`;
}
function sheetStart() {
  const o = S.sheet.startOffset;
  if (o === 'custom') return fromInput($('#custom-time')?.value) || Date.now();
  return o ? Date.now() - o * L.MIN : Date.now();
}
function noteBlock() {
  return S.sheet.showNote
    ? `<label class="field"><span>Note (optional)</span><textarea id="note" placeholder="e.g. spit up a bit">${esc(S.sheet.note)}</textarea></label>`
    : `<button class="notebtn" data-act="shownote">+ Add a note</button>`;
}
const readNote = () => ($('#note')?.value ?? S.sheet.note ?? '').trim();

function drawSheet() {
  const sh = S.sheet, el = $('#sheet');
  const list = all();
  let body = '';
  if (sh.kind === 'feed') {
    const next = L.nextSide(list);
    const bottle = sh.bottle ?? L.lastAmount(list, 'bottle', 60);
    sh.bottle = bottle;
    body = `<div class="sheet-title"><h2>Feed</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
      ${timeChips()}
      <div class="choices">
        ${['left', 'right'].map(k => `<button class="big-choice ${k === next ? 'suggested' : ''}" data-feed="${k}">
          <span class="emoji">🤱</span>${side(k)}<small>${k === next ? 'next side · starts timer' : 'starts timer'}</small></button>`).join('')}
      </div>
      <div class="amount"><div class="top"><span class="label">🍼 Bottle</span>
        <div class="stepper"><button data-step="bottle:-10">−</button><span class="val">${bottle} ml</span><button data-step="bottle:10">+</button></div></div>
        ${bottleSourceBlock()}
        <button class="save" data-feed="bottle">Log bottle · ${bottle} ml${sh.source === 'formula' ? ' formula' : ''}</button></div>
      ${noteBlock()}`;
  } else if (sh.kind === 'pump') {
    body = pumpBody();
  } else if (sh.kind === 'pumped') {
    body = pumpedBody();
  } else if (sh.kind === 'milk') {
    body = milkBody();
  } else if (sh.kind === 'diaper') {
    body = `<div class="sheet-title"><h2>Diaper</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
      ${timeChips()}
      <div class="choices three" style="--c:var(--diaper)">
        <button class="big-choice primary" data-diaper="wet"><span class="emoji">💧</span>Wet</button>
        <button class="big-choice primary" data-diaper="dirty"><span class="emoji">💩</span>Dirty</button>
        <button class="big-choice primary" data-diaper="both"><span class="emoji">💧💩</span>Both</button>
      </div>
      <div class="section-label">Colour (optional, pick before tapping)</div>
      <div class="timeline-chips">${Object.entries(COLORS).map(([n, c]) => `<button class="chip ${sh.color === n ? 'on' : ''}" data-color="${n}"><span class="swatch" style="background:${c}"></span>${n}</button>`).join('')}</div>
      ${noteBlock()}`;
  } else if (sh.kind === 'sleep') {
    const st = sh.sleepStart, back = [[5, '5 min'], [15, '15 min'], [30, '30 min']];
    body = `<div class="sheet-title"><h2>Sleep</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
      <button class="sleep-go running" data-act="stopsleep"><span class="emoji">🌤️</span>Woke up · stop<small>asleep since ${clock(st)} · ${dur(Date.now() - st)}</small></button>
      <div class="section-label">Fell asleep earlier?</div>
      <div class="timeline-chips">${back.map(([m, l]) => `<button class="chip" data-sback="${m}">${l} earlier</button>`).join('')}</div>
      ${sleepDetails(sh.d)}
      <p class="fine">Changes are saved to this sleep as you make them. Close the card any time; it keeps counting.</p>
      ${noteBlock()}`;
  } else if (sh.kind === 'edit') body = editBody();
  else if (sh.kind === 'contact') body = contactBody();
  el.innerHTML = `<div class="grab"></div>${body}`;
}

// ---------- Bottle from stock ----------
// Portions picked for this bottle: the ones tapped by hand, or else the oldest fridge milk.
function bottlePicks() {
  const sh = S.sheet;
  const live = S.milk.filter(L.inStock).map(p => p.id);
  if (sh.picks) return sh.picks.filter(id => live.includes(id));
  return L.autoPick(S.milk, sh.bottle);
}
function milkRow(p, attrs, on, extra = '') {
  const f = L.milkFlag(p);
  return `<button class="milkrow ${on ? 'on' : ''} ${f}" ${attrs}>
    <span class="code">${esc(p.code)}</span>
    <span class="mid"><b>${p.left === p.ml ? `${p.left} ml` : `${p.left} of ${p.ml} ml`}</b> · ${PLACE[p.place]}
      <small>pumped ${shortDate(p.pumpedAt)}, ${clock(p.pumpedAt)} · ${untilText(L.milkExpiry(p))}</small></span>${extra}</button>`;
}
function bottleSourceBlock() {
  const sh = S.sheet;
  const srcChips = `<div class="seg src"><button class="chip ${sh.source !== 'formula' ? 'on' : ''}" data-src="breast">Breast milk</button>
    <button class="chip small ${sh.source === 'formula' ? 'on' : ''}" data-src="formula">Formula</button></div>`;
  if (sh.source === 'formula') return srcChips;
  const stock = L.stockList(S.milk);
  if (!stock.length) return `${srcChips}<p class="fine">No milk in stock, so this bottle won't take from any bag.</p>`;
  const picks = bottlePicks();
  const { uses, short } = L.planUse(S.milk, picks, sh.bottle);
  const fridge = stock.filter(L.inFridge), frozen = stock.filter(p => !L.inFridge(p));
  const showFrozen = sh.showFreezer || frozen.some(p => picks.includes(p.id));
  const rows = list => list.map(p => {
    const u = uses.find(x => x.id === p.id);
    return milkRow(p, `data-pick="${p.id}"`, picks.includes(p.id), `<span class="take">${u ? `−${u.ml} ml` : ''}</span>`);
  }).join('');
  return `${srcChips}<div class="section-label">From stock (oldest first)</div>
    ${fridge.length ? rows(fridge) : '<p class="fine">Nothing in the fridge.</p>'}
    ${frozen.length ? (showFrozen ? `<div class="section-label">Freezer</div>${rows(frozen)}` : `<button class="notebtn" data-act="showfreezer">Show freezer (${frozen.length})</button>`) : ''}
    <p class="fine">${uses.length ? `Takes ${uses.map(u => `${u.ml} ml from ${esc(u.code)}`).join(' and ')}.` : 'No bag picked: tap one to take from it.'}${short && uses.length ? ` ${short} ml not covered by the picked bags.` : ''}</p>`;
}
// Undo/delete: a bottle puts its milk back; a pump removes its bags.
function returnMilk(e) {
  if (e.type === 'pump') for (const id of e.portions || []) db.saveMilk(id, { deleted: true });
  for (const u of e.uses || []) db.adjustMilk(u.id, u.ml);
}
function retakeMilk(e) {
  if (e.type === 'pump') for (const id of e.portions || []) db.saveMilk(id, { deleted: false });
  for (const u of e.uses || []) db.adjustMilk(u.id, -u.ml);
}

// ---------- Pump ----------
function openPump(over = {}) {
  const list = all(), last = L.lastPump(list);
  const recent = last && Date.now() - last.start < 2 * L.HOUR;
  const ml = over.ml ?? S.sheet?.ml ?? (last?.ml || 60);
  const where = over.store ?? S.sheet?.store ?? (store.get('pumpStore') || 'fridge');
  const data = { side: recent ? (last.kind === 'left' ? 'right' : 'left') : 'left', ml, store: where,
    freezer: where === 'freezer' ? ml : where === 'fridge' ? 0 : Math.round(ml / 2 / 5) * 5, ...over };
  if (S.sheet) { S.sheet = { kind: 'pump', start: null, note: '', showNote: false, ...data }; return drawSheet(); }
  openSheet('pump', data);
}
function pumpBody() {
  const sh = S.sheet;
  const parts = L.splitPortions(sh.ml, sh.freezer);
  const fridgeMl = sh.ml - Math.min(sh.ml, sh.freezer);
  return `<div class="sheet-title"><h2>Pump</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    ${timeChips()}
    <div class="choices" style="--c:var(--pump)">${['left', 'right'].map(k => `<button class="big-choice ${sh.side === k ? 'suggested' : ''}" data-pside="${k}">
      <span class="emoji">🫙</span>${side(k)}<small>${sh.side === k ? 'selected' : 'tap to pick'}</small></button>`).join('')}</div>
    <div class="amount"><div class="top"><span class="label">Pumped</span>
      <div class="stepper"><button data-step="ml:-5">−</button><span class="val">${sh.ml} ml</span><button data-step="ml:5">+</button></div></div>
      <div class="section-label">Where does it go?</div>
      <div class="seg">${[['fridge', 'Fridge'], ['freezer', 'Freezer'], ['split', 'Split']].map(([v, l]) => `<button class="chip ${sh.store === v ? 'on' : ''}" data-store="${v}">${l}</button>`).join('')}</div>
      ${sh.store === 'split' ? `<div class="top" style="margin-top:10px"><span class="label">🧊 Freezer</span>
        <div class="stepper"><button data-step="freezer:-5">−</button><span class="val">${Math.min(sh.freezer, sh.ml)} ml</span><button data-step="freezer:5">+</button></div></div>
        <p class="fine" style="margin:6px 0 0">Fridge gets the other ${fridgeMl} ml.</p>` : ''}
      <p class="fine">${parts.length ? parts.map(([pl, ml]) => `${PLACE[pl]} ${ml} ml${pl === 'freezer' ? ' (code ends in -F)' : ''}`).join(' · ') + '. The code to write on the bag shows after saving.' : 'Nothing to store.'}</p>
      <button class="save pumpsave" data-act="savepump" ${sh.saving ? 'disabled' : ''}>${sh.saving ? 'Saving…' : `Save ${side(sh.side)} · ${sh.ml} ml`}</button></div>
    ${noteBlock()}`;
}
async function savePump() {
  const sh = S.sheet;
  if (sh.saving) return;
  const start = sheetStart(), note = readNote();
  sh.note = note; sh.saving = true; drawSheet();
  const parts = L.splitPortions(sh.ml, sh.freezer);
  let code = null, seq = null, offline = false;
  if (parts.length) {
    ({ seq, offline } = await db.nextPumpSeq(sh.side, L.maxSeq(all())[sh.side]));
    code = L.pumpCode(sh.side, seq);
  }
  const portions = parts.map(([place, ml]) => {
    const id = db.newMilkId();
    db.saveMilk(id, { code: L.portionCode(code, place), pumpCode: code, side: sh.side, place, ml, left: ml, pumpedAt: start,
      thawedAt: null, by: S.me, note: '', deleted: false, discarded: false, createdAt: Date.now() });
    return { id, place, ml, code: L.portionCode(code, place) };
  });
  store.set('pumpStore', sh.store);
  const fridgeMl = parts.find(p => p[0] === 'fridge')?.[1] || 0, freezerMl = parts.find(p => p[0] === 'freezer')?.[1] || 0;
  logEntry({ type: 'pump', kind: sh.side, start, ml: sh.ml, note, code, seq, fridgeMl, freezerMl, portions: portions.map(p => p.id) },
    { toastText: `${side(sh.side)} · ${sh.ml} ml saved${code ? ` · ${code}` : ''}`, extra: () => [] });
  if (!S.sheet) return; // closed while saving
  S.sheet = { kind: 'pumped', side: sh.side, ml: sh.ml, store: sh.store, freezer: sh.freezer, labels: portions, offline, code };
  drawSheet();
}
function pumpedBody() {
  const sh = S.sheet, other = sh.side === 'left' ? 'right' : 'left';
  return `<div class="sheet-title"><h2>Saved · ${side(sh.side)} ${sh.ml} ml</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    ${sh.labels.length ? `<div class="section-label">Write on the bag</div>
      ${sh.labels.map(l => `<div class="label-card ${l.place}"><span class="code">${esc(l.code)}</span><span>${PLACE[l.place]} · ${l.ml} ml</span></div>`).join('')}`
      : '<p class="fine">Nothing stored, so no bag code.</p>'}
    ${sh.offline ? '<p class="fine">No signal, so this code was numbered on this phone. It only clashes if the other phone saved the same breast while offline too.</p>' : ''}
    <div class="btn-row" style="margin-top:14px"><button class="btn primary" data-act="switchbreast">Switch breast · ${side(other)}</button>
      <button class="btn" data-act="close">Done</button></div>`;
}

// ---------- Milk stock ----------
function renderStock(app) {
  const stock = L.stockList(S.milk), st = L.stockTotals(S.milk);
  const fridge = stock.filter(L.inFridge), frozen = stock.filter(p => !L.inFridge(p));
  const section = (name, list, empty) => `<div class="day">${name} · ${list.reduce((a, p) => a + p.left, 0)} ml</div>
    ${list.length ? list.map(p => milkRow(p, `data-milk="${p.id}"`, false, `${S.milkPending.has(p.id) ? '<span class="waiting-mark">⏳</span>' : ''}<span class="chev">›</span>`)).join('') : `<div class="empty" style="padding:12px">${empty}</div>`}`;
  app.innerHTML = `<div class="screen" style="padding-bottom:40px">
    <div class="topbar"><button class="iconbtn" data-nav="home" aria-label="Back">←</button><div class="grow"><h1>Milk stock</h1>
      <div class="sub">${st.fridge + st.freezer} ml in ${stock.length} bag${stock.length === 1 ? '' : 's'}${st.expired ? ` · <span class="flag bad">${st.expired} expired</span>` : ''}${st.soon ? ` · <span class="flag soon">${st.soon} use soon</span>` : ''}</div></div></div>
    ${section('Fridge', fridge, 'Nothing in the fridge.')}
    ${section('Freezer', frozen, 'Nothing in the freezer.')}
    <p class="fine" style="margin-top:18px">Oldest first. Fridge milk keeps ${L.MILK_RULES.fridgeDays} days from pumping, frozen milk ${L.MILK_RULES.freezerMonths} months, and thawed milk ${L.MILK_RULES.thawedHours} hours from thawing. Tap a bag to thaw it, change what's left, or discard it.</p>
  </div>`;
}
function milkBody() {
  const p = S.sheet.draft, f = L.milkFlag(p);
  return `<div class="sheet-title"><h2 class="code-title">${esc(p.code)}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <p class="fine" style="margin-top:0">${side(p.side)} breast · ${PLACE[p.place]} · pumped ${shortDate(p.pumpedAt)}, ${clock(p.pumpedAt)}${p.thawedAt ? ` · thawed ${shortDate(p.thawedAt)}, ${clock(p.thawedAt)}` : ''}</p>
    <p class="expiry ${f}">${f === 'expired' ? 'Expired' : 'Use by'} ${shortDate(L.milkExpiry(p))}, ${clock(L.milkExpiry(p))} (${untilText(L.milkExpiry(p))})</p>
    <label class="field"><span>Milk left (ml, of ${p.ml})</span><input type="number" inputmode="numeric" id="mk-left" value="${p.left}"></label>
    <label class="field"><span>Note</span><textarea id="mk-note">${esc(p.note)}</textarea></label>
    ${p.place === 'freezer' ? '<button class="btn wide" data-act="thaw" style="margin-bottom:10px">Thaw · move to fridge (24 h to use)</button>' : ''}
    <div class="btn-row"><button class="btn danger" data-act="discard">${S.sheet.confirmDiscard ? 'Tap again to discard' : 'Discard'}</button>
      <button class="btn primary" data-act="savemilk">Save</button></div>`;
}
function saveMilkEdit() {
  const p = S.sheet.draft, fields = {};
  const left = Math.max(0, Math.round(Number($('#mk-left').value) || 0));
  if (left !== p.left) fields.left = left;
  const note = $('#mk-note').value.trim(); if (note !== (p.note || '')) fields.note = note;
  if (Object.keys(fields).length) db.saveMilk(p.id, fields);
  closeSheet();
  if (Object.keys(fields).length) toast(left === 0 ? `${p.code} used up` : 'Saved', []);
}
function thawMilk() {
  const p = S.sheet.draft, now = Date.now();
  db.saveMilk(p.id, { place: 'thawed', thawedAt: now });
  closeSheet();
  toast(`${p.code} thawing · use within 24 h`, [{ label: 'Undo', fn: () => db.saveMilk(p.id, { place: 'freezer', thawedAt: null }) }]);
}
function discardMilk() {
  const p = S.sheet.draft;
  db.saveMilk(p.id, { discarded: true, discardedAt: Date.now() });
  closeSheet();
  toast(`${p.code} discarded`, [{ label: 'Undo', fn: () => db.saveMilk(p.id, { discarded: false, discardedAt: null }) }]);
}

// ---------- Edit sheet ----------
function openEdit(id, focusNote = false) {
  const e = all().find(x => x.id === id);
  if (!e) return;
  openSheet('edit', { id, draft: { ...e }, focusNote, confirmDelete: false });
  if (focusNote) setTimeout(() => $('#note')?.focus(), 50);
}

function editBody() {
  const d = S.sheet.draft;
  const kinds = d.type === 'feed' ? [['left', 'Left'], ['right', 'Right'], ['bottle', 'Bottle'], ...(d.kind === 'pump' ? [['pump', 'Pump']] : [])]
    : d.type === 'diaper' ? [['wet', 'Wet'], ['dirty', 'Dirty'], ['both', 'Both']] : [];
  const hasEnd = d.type === 'sleep' || L.isBreast(d);
  const hasMl = d.type === 'feed' && (d.kind === 'bottle' || d.kind === 'pump');
  const title = { feed: 'Edit feed', diaper: 'Edit diaper', sleep: 'Edit sleep', pump: `Edit pump${d.code ? ` · ${d.code}` : ''}` }[d.type];
  const milkInfo = d.type === 'pump'
    ? `<p class="fine">${side(d.kind)} breast · ${d.ml || 0} ml${d.fridgeMl ? ` · fridge ${d.fridgeMl} ml (${esc(d.code)})` : ''}${d.freezerMl ? ` · freezer ${d.freezerMl} ml (${esc(d.code)}-F)` : ''}.
        Changing the time also moves the expiry dates. To change amounts, open the bag in Milk stock. Deleting this removes its bags from stock.</p>`
    : d.kind === 'bottle' && d.uses?.length
      ? `<p class="fine">Took ${d.uses.map(u => `${u.ml} ml from ${esc(u.code)}`).join(', ')}. Changing the amount here doesn't change the stock; deleting puts the milk back.</p>`
      : d.kind === 'bottle' && d.source === 'formula' ? '<p class="fine">Formula</p>' : '';
  return `<div class="sheet-title"><h2>${title}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    ${kinds.length ? `<div class="seg" style="margin-bottom:12px">${kinds.map(([k, l]) => `<button class="chip ${d.kind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('')}</div>` : ''}
    <label class="field"><span>${hasEnd ? 'Started' : 'Time'}</span><input type="datetime-local" id="ed-start" value="${toInput(d.start)}"></label>
    ${hasEnd ? (d.end == null
      ? `<div class="field"><span>Ended</span><button class="btn wide" data-act="endnow">Still going · tap to stop now</button></div>`
      : `<label class="field"><span>Ended</span><input type="datetime-local" id="ed-end" value="${toInput(d.end)}"></label>`) : ''}
    ${d.type === 'sleep' ? sleepDetails(d) : ''}${milkInfo}
    ${hasMl ? `<label class="field"><span>Amount (ml)</span><input type="number" inputmode="numeric" id="ed-ml" value="${d.ml ?? ''}"></label>` : ''}
    ${d.type === 'diaper' ? `<div class="section-label">Colour</div><div class="timeline-chips">
      <button class="chip ${!d.color ? 'on' : ''}" data-dcolor="">None</button>
      ${Object.entries(COLORS).map(([n, c]) => `<button class="chip ${d.color === n ? 'on' : ''}" data-dcolor="${n}"><span class="swatch" style="background:${c}"></span>${n}</button>`).join('')}</div>` : ''}
    <label class="field"><span>Note</span><textarea id="note">${esc(d.note)}</textarea></label>
    <p class="sub" style="color:var(--muted);font-size:14px;margin:0 0 10px">Logged by ${esc(d.by || 'unknown')}</p>
    <div class="btn-row"><button class="btn danger" data-act="delete">${S.sheet.confirmDelete ? 'Tap again to delete' : 'Delete'}</button>
      <button class="btn primary" data-act="saveedit">Save</button></div>`;
}

function readEditInputs() {
  const d = S.sheet.draft;
  const s = fromInput($('#ed-start')?.value); if (s) d.start = s;
  if ($('#ed-end')) d.end = fromInput($('#ed-end').value);
  if ($('#ed-ml')) d.ml = Number($('#ed-ml').value) || 0;
  if (d.type === 'sleep') {
    if ($('#sl-temp')) d.tempC = readTemp();
    if ($('#sl-light') && $('#sl-light').checked !== !!d.nightLight) d.nightLight = $('#sl-light').checked;
  }
  d.note = ($('#note')?.value ?? d.note).trim();
}

function saveEdit() {
  readEditInputs();
  const d = S.sheet.draft;
  const orig = all().find(x => x.id === d.id) || {};
  if (d.end != null && d.end < d.start) return toast('End is before start', []);
  if (d.type === 'diaper' || (d.type === 'feed' && !L.isBreast(d))) d.end = d.start;
  const changed = {};
  for (const k of ['kind', 'start', 'end', 'ml', 'color', 'note', ...(d.type === 'sleep' ? L.SLEEP_FIELDS : [])]) if ((d[k] ?? null) !== (orig[k] ?? null)) changed[k] = d[k] ?? null;
  if (Object.keys(changed).length) db.saveEntry(d.id, changed);
  if (d.type === 'pump' && 'start' in changed) for (const pid of d.portions || []) db.saveMilk(pid, { pumpedAt: d.start });
  closeSheet();
  if (Object.keys(changed).length) toast('Saved', []);
}

// ---------- Contacts ----------
function renderContacts(app) {
  const list = S.contacts.filter(c => !c.deleted).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
  const tel = p => String(p || '').replace(/[^\d+]/g, '');
  app.innerHTML = `<div class="screen" style="padding-bottom:40px">
    <div class="topbar"><button class="iconbtn" data-nav="home" aria-label="Back">←</button><div class="grow"><h1>Contacts</h1></div>
      <button class="btn primary" data-act="addcontact">+ Add</button></div>
    ${list.map(c => `<div class="contact"><div class="head"><span class="name">${esc(c.name)}</span><span class="role">${esc(c.role || '')}</span></div>
      ${c.when ? `<div class="when"><b>Call when:</b> ${esc(c.when)}</div>` : ''}
      ${c.note ? `<div class="when" style="color:var(--muted)">${esc(c.note)}</div>` : ''}
      <div class="actions">${c.phone ? `<a class="call" href="tel:${esc(tel(c.phone))}">📞 Call</a>` : ''}
        ${c.email ? `<a href="mailto:${esc(c.email)}">✉️ Email</a>` : ''}
        <button data-contact="${c.id}">Edit</button></div></div>`).join('')
      || `<div class="empty">No contacts yet. Add the pediatrician, the hospital and the nurse line first.</div>`}
  </div>`;
}

function contactBody() {
  const c = S.sheet.draft;
  return `<div class="sheet-title"><h2>${c.isNew ? 'New contact' : 'Edit contact'}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <label class="field"><span>Name</span><input id="c-name" value="${esc(c.name)}" autocomplete="off"></label>
    <label class="field"><span>Role</span><select id="c-role">${ROLES.map(r => `<option ${c.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <label class="field"><span>Phone</span><input id="c-phone" type="tel" value="${esc(c.phone)}"></label>
    <label class="field"><span>Email</span><input id="c-email" type="email" value="${esc(c.email)}"></label>
    <label class="field"><span>When to call</span><textarea id="c-when" placeholder="e.g. fever over 38 °C, fewer than 6 wet diapers a day">${esc(c.when)}</textarea></label>
    <label class="field"><span>Notes</span><textarea id="c-note">${esc(c.note)}</textarea></label>
    <div class="btn-row">${c.isNew ? '' : `<button class="btn danger" data-act="delcontact">${S.sheet.confirmDelete ? 'Tap again to delete' : 'Delete'}</button>`}
      <button class="btn primary" data-act="savecontact">Save</button></div>`;
}

function saveContact() {
  const c = S.sheet.draft;
  const v = id => $(id).value.trim();
  const fields = { name: v('#c-name'), role: v('#c-role'), phone: v('#c-phone'), email: v('#c-email'), when: v('#c-when'), note: v('#c-note'), deleted: false };
  if (!fields.name) return toast('Add a name first', []);
  db.saveContact(c.id, fields);
  closeSheet();
}

// ---------- Settings ----------
function inviteLink() { return `${location.origin}${location.pathname}#join=${S.fid}`; }

function renderSettings(app) {
  app.innerHTML = `<div class="screen" style="padding-bottom:40px">
    <div class="topbar"><button class="iconbtn" data-nav="home" aria-label="Back">←</button><div class="grow"><h1>Settings</h1></div></div>
    <div class="panel"><h3>Baby</h3>
      <label class="field"><span>Name</span><input id="s-name" value="${esc(S.baby?.name || '')}"></label>
      <label class="field"><span>Birth date (or due date)</span><input id="s-birth" type="date" value="${esc(S.baby?.birth || '')}"></label>
      <button class="btn primary wide" data-act="savebaby">Save</button></div>
    <div class="panel"><h3>This phone belongs to</h3>
      <div class="seg">${PEOPLE.map(p => `<button class="chip ${S.me === p ? 'on' : ''}" data-me="${p}">${p}</button>`).join('')}</div></div>
    <div class="panel"><h3>Look</h3>
      <div class="seg">${[['light', 'Light'], ['night', 'Dark at night'], ['dark', 'Dark']].map(([v, l]) => `<button class="chip ${(store.get('theme') || 'light') === v ? 'on' : ''}" data-theme-pick="${v}">${l}</button>`).join('')}</div>
      <p style="margin:8px 0 0">"Dark at night" switches to dark from 8 PM to 7 AM, so the screen doesn't glare during night feeds.</p></div>
    <div class="panel"><h3>Add the other phone</h3>
      <p>Send this link to the other phone and open it in Chrome. Anyone with the link can see and add entries, so only share it between the two of you.</p>
      <div class="mono" id="invite">${esc(inviteLink())}</div>
      <div class="btn-row"><button class="btn" data-act="share">Share link</button><button class="btn" data-act="copy">Copy</button></div></div>
    <div class="panel"><h3>Backup</h3><p>Download everything logged in the last ${WINDOW_DAYS} days plus anything you loaded, as a spreadsheet file.</p>
      <button class="btn wide" data-act="csv">Download CSV</button></div>
    <div class="panel"><h3>Sync</h3><p>${syncBadge()}</p><p>Entries are saved on this phone first and sent as soon as there's signal. Closing the app doesn't lose them.</p>
      <p>Family ID (for the Notion copy): <span class="mono" style="display:block;margin-top:6px">${esc(S.fid)}</span></p></div>
  </div>`;
}

function exportCsv() {
  const rows = [['type', 'kind', 'start', 'end', 'minutes', 'ml', 'color', 'note', 'logged_by',
    'day_night', 'cover', 'location', 'sound', 'night_light', 'room_temp_c', 'pump_code', 'bottle_source', 'milk_used']];
  for (const e of all()) {
    rows.push([e.type, e.kind || '', new Date(e.start).toISOString(), e.end ? new Date(e.end).toISOString() : '',
      e.end ? Math.round((e.end - e.start) / L.MIN) : '', e.ml ?? '', e.color || '', e.note || '', e.by || '',
      e.period || '', optLabel('cover', e.cover), optLabel('location', e.location), optLabel('sound', e.sound),
      e.type === 'sleep' && e.nightLight != null ? (e.nightLight ? 'yes' : 'no') : '', e.tempC ?? '',
      e.code || '', e.source || '', (e.uses || []).map(u => `${u.code} ${u.ml} ml`).join('; ')]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `picos-baby-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ---------- Setup ----------
function renderSetup(app) {
  const joining = S.joinFid;
  app.innerHTML = `<div class="setup">
    <h1>${joining ? 'Join the baby log' : 'Welcome 👶'}</h1>
    <p>${joining ? 'This phone will share the same log as the other one.' : 'Two quick things and you\'re ready. The other phone joins with a link from Settings.'}</p>
    ${joining ? '' : `<label class="field"><span>Baby's name</span><input id="su-name" autocomplete="off"></label>
    <label class="field"><span>Birth date (or due date)</span><input id="su-birth" type="date"></label>`}
    <div class="section-label">Who uses this phone?</div>
    <div class="choices">${PEOPLE.map(p => `<button class="big-choice" data-setup="${p}">${p}</button>`).join('')}</div>
  </div>`;
}

function finishSetup(person) {
  if (S.joinFid) {
    S.fid = S.joinFid;
  } else {
    const name = $('#su-name').value.trim(), birth = $('#su-birth').value;
    if (!name) { $('#su-name').focus(); return toast('Add the baby\'s name first', []); }
    S.fid = db.newFamilyId();
    db.connect(S.fid);
    db.saveBaby({ name, birth });
  }
  S.me = person;
  store.set('family', S.fid); store.set('me', person);
  history.replaceState(null, '', location.pathname + location.search);
  start();
  render();
}

// ---------- Toast ----------
let toastTimer;
let toastActions = [];
function toast(text, actions = []) {
  const el = $('#toast');
  toastActions = actions;
  el.innerHTML = `<span class="msg">${esc(text)}</span>${actions.map((a, i) => `<button data-toast="${i}">${esc(a.label)}</button>`).join('')}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actions.length ? 7000 : 2500);
}

// ---------- Taps ----------
document.addEventListener('click', ev => {
  const t = ev.target.closest('button, [data-edit]');
  if (!t) return;
  const ds = t.dataset;
  const list = all();

  if (ds.toast != null) { $('#toast').hidden = true; return toastActions[+ds.toast]?.fn(); }
  if (ds.setup) return finishSetup(ds.setup);
  if (ds.nav) { if (ds.nav !== 'home') history.pushState({ view: ds.nav }, ''); else if (S.view !== 'home') return history.back(); S.view = ds.nav; window.scrollTo(0, 0); return render(); }
  if (ds.edit) return openEdit(ds.edit);
  if (ds.themePick) { store.set('theme', ds.themePick); applyTheme(); return render(); }
  if (ds.me) { S.me = ds.me; store.set('me', ds.me); return render(); }
  if (ds.contact) { const c = S.contacts.find(x => x.id === ds.contact); return openSheet('contact', { draft: { ...c }, confirmDelete: false }); }

  // Inside sheets
  if (ds.offset != null) {
    if (S.sheet.showNote) S.sheet.note = readNote();
    if (S.sheet.kind === 'sleep') keepSleepInputs();
    S.sheet.startOffset = ds.offset === '' ? null : ds.offset === 'custom' ? 'custom' : +ds.offset;
    if (S.sheet.kind === 'sleep' && !S.sheet.periodTouched) S.sheet.d.period = L.dayOrNight(sheetStart());
    return drawSheet();
  }
  if (ds.sback) {
    keepSleepInputs();
    const sh = S.sheet; sh.sleepStart -= +ds.sback * L.MIN;
    db.saveEntry(sh.runningId, { start: sh.sleepStart });
    if (!sh.periodTouched && L.dayOrNight(sh.sleepStart) !== sh.d.period) { sh.d.period = L.dayOrNight(sh.sleepStart); db.saveEntry(sh.runningId, { period: sh.d.period }); }
    toast(`Asleep since ${clock(sh.sleepStart)}`, []);
    return drawSheet();
  }
  if (ds.sl) {
    const [f, v] = ds.sl.split(':');
    const edit = S.sheet.kind === 'edit';
    if (edit) readEditInputs(); else keepSleepInputs();
    const d = edit ? S.sheet.draft : S.sheet.d;
    d[f] = f !== 'period' && d[f] === v ? null : v; // tap a picked option again to clear it
    if (f === 'period') S.sheet.periodTouched = true;
    if (!edit && S.sheet.runningId) db.saveEntry(S.sheet.runningId, { [f]: d[f] });
    return drawSheet();
  }
  if (ds.step) {
    const [k, d] = ds.step.split(':');
    if (S.sheet.showNote) S.sheet.note = readNote();
    S.sheet[k] = Math.max(0, S.sheet[k] + +d);
    if (S.sheet.kind === 'pump') {
      const sh = S.sheet;
      sh.freezer = sh.store === 'freezer' ? sh.ml : sh.store === 'fridge' ? 0 : Math.min(sh.freezer, sh.ml);
    }
    return drawSheet();
  }
  if (ds.color) { S.sheet.color = S.sheet.color === ds.color ? null : ds.color; if (S.sheet.showNote) S.sheet.note = readNote(); return drawSheet(); }
  if (ds.feed) {
    const startAt = sheetStart(), note = readNote(), k = ds.feed;
    const ml = S.sheet.bottle;
    const backdated = Date.now() - startAt > L.MIN;
    const source = S.sheet.source || 'breast';
    const uses = source === 'breast' ? L.planUse(S.milk, bottlePicks(), ml).uses : [];
    closeSheet();
    if (k === 'left' || k === 'right') {
      return logEntry({ type: 'feed', kind: k, start: startAt, note }, { toastText: `${side(k)} breast started${backdated ? ` at ${clock(startAt)}` : ''}`, extra: () => [] });
    }
    const from = uses.length ? ` from ${uses.map(u => u.code).join(' + ')}` : source === 'formula' ? ' formula' : '';
    return logEntry({ type: 'feed', kind: 'bottle', start: startAt, ml, note, source, uses }, { toastText: `Bottle · ${ml} ml${from} saved`, extra: () => [] });
  }
  if (ds.src) { if (S.sheet.showNote) S.sheet.note = readNote(); S.sheet.source = ds.src; return drawSheet(); }
  if (ds.pick) {
    if (S.sheet.showNote) S.sheet.note = readNote();
    const cur = bottlePicks();
    S.sheet.picks = cur.includes(ds.pick) ? cur.filter(x => x !== ds.pick) : [...cur, ds.pick];
    return drawSheet();
  }
  if (ds.pside) { if (S.sheet.showNote) S.sheet.note = readNote(); S.sheet.side = ds.pside; return drawSheet(); }
  if (ds.store) {
    if (S.sheet.showNote) S.sheet.note = readNote();
    S.sheet.store = ds.store;
    S.sheet.freezer = ds.store === 'freezer' ? S.sheet.ml : ds.store === 'fridge' ? 0 : Math.round(S.sheet.ml / 2 / 5) * 5;
    return drawSheet();
  }
  if (ds.milk) { const p = S.milk.find(x => x.id === ds.milk); return p && openSheet('milk', { id: p.id, draft: { ...p }, confirmDiscard: false }); }
  if (ds.diaper) {
    const startAt = sheetStart(), note = readNote(), color = S.sheet.color;
    closeSheet();
    return logEntry({ type: 'diaper', kind: ds.diaper, start: startAt, color: ds.diaper === 'wet' ? null : color, note }, { toastText: `${{ wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' }[ds.diaper]} diaper saved`, extra: () => [] });
  }
  if (ds.kind) { readEditInputs(); S.sheet.draft.kind = ds.kind; if (L.isBreast(S.sheet.draft) && S.sheet.draft.end === S.sheet.draft.start) S.sheet.draft.end = S.sheet.draft.start + 10 * L.MIN; return drawSheet(); }
  if (ds.dcolor != null) { readEditInputs(); S.sheet.draft.color = ds.dcolor || null; return drawSheet(); }

  switch (ds.act) {
    case 'feed': return openSheet('feed', { source: 'breast', picks: null });
    case 'pump': return openPump();
    case 'savepump': return savePump();
    case 'switchbreast': return openPump({ side: S.sheet.side === 'left' ? 'right' : 'left', startOffset: null });
    case 'thaw': return thawMilk();
    case 'discard':
      if (!S.sheet.confirmDiscard) { S.sheet.confirmDiscard = true; return drawSheet(); }
      return discardMilk();
    case 'savemilk': return saveMilkEdit();
    case 'showfreezer': S.sheet.showFreezer = true; return drawSheet();
    case 'diaper': return openSheet('diaper');
    case 'sleep': return openSleep();
    case 'stopsleep': return stopSleep();
    case 'stopfeed': { const r = L.runningFeed(list); return r && stopFeed(r); }
    case 'close': return closeSheet();
    case 'shownote': S.sheet.showNote = true; drawSheet(); return $('#note')?.focus();
    case 'endnow': readEditInputs(); S.sheet.draft.end = Date.now(); return drawSheet();
    case 'saveedit': return saveEdit();
    case 'delete':
      if (!S.sheet.confirmDelete) { readEditInputs(); S.sheet.confirmDelete = true; return drawSheet(); }
      { const e = S.sheet.draft, id = e.id; db.saveEntry(id, { deleted: true }); returnMilk(e); closeSheet();
        return toast('Deleted', [{ label: 'Undo', fn: () => { db.saveEntry(id, { deleted: false }); retakeMilk(e); } }]); }
    case 'addcontact': return openSheet('contact', { draft: { id: db.newId(), isNew: true, role: 'Pediatrician' }, confirmDelete: false });
    case 'savecontact': return saveContact();
    case 'delcontact':
      if (!S.sheet.confirmDelete) { S.sheet.confirmDelete = true; return drawSheet(); }
      db.saveContact(S.sheet.draft.id, { deleted: true }); return closeSheet();
    case 'savebaby': db.saveBaby({ name: $('#s-name').value.trim(), birth: $('#s-birth').value }); return toast('Saved', []);
    case 'share': return navigator.share ? navigator.share({ title: 'Baby log', url: inviteLink() }).catch(() => {}) : navigator.clipboard?.writeText(inviteLink()).then(() => toast('Link copied', []));
    case 'copy': return navigator.clipboard?.writeText(inviteLink()).then(() => toast('Link copied', []));
    case 'csv': return exportCsv();
    case 'older': return loadOlder();
  }
});


$('#sheet-backdrop').addEventListener('click', () => closeSheet());

// Night light checkbox and temperature (sleep card and edit sheet).
document.addEventListener('change', ev => {
  if (!S.sheet) return;
  if (ev.target.id === 'sl-temp' && S.sheet.kind === 'sleep' && S.sheet.runningId) return saveRunningSleepText();
  if (ev.target.id !== 'sl-light') return;
  if (S.sheet.kind === 'edit') { S.sheet.draft.nightLight = ev.target.checked; return; }
  S.sheet.d.nightLight = ev.target.checked;
  if (S.sheet.runningId) db.saveEntry(S.sheet.runningId, { nightLight: ev.target.checked });
});

async function loadOlder() {
  const to = S.olderFrom, from = to - 7 * L.DAY;
  try {
    const more = await db.loadEntries(from, to);
    S.older.push(...more); S.olderFrom = from;
    toast(more.length ? `Loaded ${more.length} older entries` : 'Nothing earlier than this', []);
    render();
  } catch { toast('Can\'t load older days while offline', []); }
}

// Android back button closes sheets and returns home.
window.addEventListener('popstate', () => {
  if (S.ignorePop) { S.ignorePop = false; return; }
  if (S.sheet) return closeSheet(true);
  if (S.view !== 'home') { S.view = 'home'; render(); }
});

// ---------- Boot ----------
const join = new URLSearchParams(location.hash.slice(1)).get('join');
if (join && join !== S.fid) {
  S.joinFid = join;
  if (S.fid) { S.fid = null; } // switching family on purpose via a new link
}
if (S.fid && S.me) start();
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
