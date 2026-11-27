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
  af: null, // Activity screen filters; reset every time the screen opens (see afDefaults)
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
const side = k => (k === 'left' ? 'Left' : k === 'both' ? 'Left + Right' : 'Right');
// "Other" was called "Formula" before Nov 2026; old entries show as Other.
const isOther = e => e.source === 'other' || e.source === 'formula';
function bottleSource(e) {
  if (isOther(e)) return ' · other';
  if (e.uses?.length) return ` · ${e.uses.map(u => u.code).join(' + ')}`;
  return '';
}
function bottleWhat(e) {
  if (e.end == null) return `Bottle feeding… · ${e.preparedMl ?? e.ml ?? 0} ml${bottleSource(e)}`;
  const timed = e.preparedMl != null && e.end > e.start ? ` · ${dur(e.end - e.start)}` : '';
  const left = e.leftoverMl > 0 ? ` (${e.leftoverMl} left over)` : '';
  return `Bottle · ${e.ml || 0} ml${left}${timed}${bottleSource(e)}`;
}
const PLACE = { room: 'Room temp', fridge: 'Fridge', freezer: 'Freezer', thawed: 'Defrosted' };
const PLACE_EMOJI = { room: '🏠', fridge: '❄️', freezer: '🧊', thawed: '💧' };
const PLACE_KEEP = { room: `use within ${L.MILK_RULES.roomHours} hours`, fridge: `use within ${L.MILK_RULES.fridgeDays} days`,
  freezer: `use within ${L.MILK_RULES.freezerMonths} months`, thawed: `use within ${L.MILK_RULES.thawedHours} h of defrosting` };
const longDate = t => new Date(t).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// 'defrosting' (grey, not ready for 12 h), 'defrosted' (light blue, ready) or '' for other bags.
const defrostClass = p => (p.place !== 'thawed' ? '' : L.isDefrosting(p) ? 'defrosting' : 'defrosted');
const CONTAINER = { bag: 'Bag', bottle: 'Bottle' };
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
    if (e.kind === 'bottle') return { ic: '🍼', what: bottleWhat(e) };
    return { ic: '🫙', what: `Pumped · ${e.ml || 0} ml` }; // logged before Pump had its own button
  }
  if (e.type === 'pump') {
    const m = e.end > e.start ? ` · ${dur(e.end - e.start)}` : '';
    return { ic: '🫙', what: `Pumped ${side(e.kind)} · ${e.ml || 0} ml${m}${e.code ? ` · ${e.code}` : ''}` };
  }
  if (e.type === 'pumpsession') return { ic: '🫙', what: e.end == null ? 'Pumping…' : `Pump ${dur(e.end - e.start)} · not saved yet, tap to finish` };
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
    db.watchEntries(since, ({ list, pending }) => { S.entries = list; S.pending = pending; render(); if (S.sheet?.kind === 'feed' && (L.runningBottle(all())?.id ?? null) !== (S.sheet.runningId ?? null)) { keepFeedInputs(); if (!L.runningBottle(all())) { S.sheet.runningId = null; S.sheet.stopping = false; } drawSheet(); } }),
    db.watchContacts(({ list, pending }) => { S.contacts = list; S.contactsPending = pending; if (S.view === 'contacts') render(); }),
    db.watchBaby(b => { S.baby = b; render(); }),
    db.watchMilk(({ list, pending }) => { S.milk = list; S.milkPending = pending; if (S.sheet?.kind === 'feed' && S.sheet.bottleOpen && !S.sheet.runningId && document.activeElement?.id !== 'note') { keepFeedInputs(); drawSheet(); } render(); }),
    db.watchMilkCounter(),
  ];
}

function logEntry(fields, { toastText, undo = true, extra = [] } = {}) {
  const id = db.newId();
  const now = Date.now();
  const e = { id, type: fields.type, kind: fields.kind ?? null, start: fields.start ?? now, end: fields.end ?? null,
    ml: fields.ml ?? null, color: fields.color ?? null, note: fields.note ?? '', by: S.me, createdAt: now, deleted: false };
  if (e.type === 'diaper' || (e.type === 'feed' && !['left', 'right', 'bottle'].includes(e.kind))) e.end = e.start;
  if (e.type === 'sleep') for (const k of L.SLEEP_FIELDS) e[k] = fields[k] ?? null;
  if (e.type === 'pump') { e.end = fields.end ?? e.start; Object.assign(e, { code: fields.code ?? null, seq: fields.seq ?? null, bags: fields.bags ?? [], portions: fields.portions ?? [], sessionId: fields.sessionId ?? null }); }
  if (e.kind === 'bottle') for (const k of ['source', 'targetMl', 'preparedMl', 'leftoverMl', 'window']) e[k] = fields[k] ?? null;
  if (e.kind === 'bottle') e.uses = fields.uses ?? [];
  db.saveEntry(id, e);
  if (e.uses?.length) for (const u of e.uses) db.adjustMilk(u.id, -u.ml);
  buzz();
  const actions = [];
  if (undo) actions.push({ label: 'Undo', fn: () => { db.saveEntry(id, { deleted: true }); returnMilk(e); } });
  actions.push(...extra(id));
  if (e.type !== 'pump' && e.type !== 'pumpsession') actions.push({ label: 'Note', fn: () => openEdit(id, true) });
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
  // Tap while asleep (home "Woke up"): stop and save at once, no card. Changes are made on the record in Activity.
  const end = Date.now();
  db.saveEntry(running.id, { end });
  buzz();
  toast(`Woke up · slept ${dur(end - running.start)}`, [
    { label: 'Undo', fn: () => db.saveEntry(running.id, { end: null }) },
    { label: 'Edit', fn: () => openEdit(running.id) },
  ]);
}
// Keep typed values when the feed card redraws (a tap, or a change from the other phone).
function keepFeedInputs() {
  if (S.sheet.showNote) S.sheet.note = readNote();
  if (S.sheet.stopping) readLeftover();
  if (S.sheet.startOffset === 'custom') S.sheet.customTime = fromInput($('#custom-time')?.value) || S.sheet.customTime;
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
  // The home screen fits on one screen and doesn't scroll; other screens scroll as usual.
  document.documentElement.classList.toggle('home-fixed', !!(S.fid && S.me) && S.view === 'home');
  if (!S.fid || !S.me) return renderSetup(app);
  if (S.view === 'contacts') return renderContacts(app);
  if (S.view === 'stock') return renderStock(app);
  if (S.view === 'activity') return renderActivity(app);
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
  const feedRun = L.runningFeed(list), bottleRun = L.runningBottle(list);
  const diaper = L.lastDiaper(list);
  const sl = L.sleepState(list, now);
  const t = L.todayTotals(list, now);
  const next = L.nextSide(list);

  let feedTile;
  if (feedRun) feedTile = `<button class="tile feed running" data-edit="${feedRun.id}"><div class="label">Feeding now</div>
      <div class="big" data-timer="${feedRun.start}">${clockTimer(now - feedRun.start)}</div><div class="small">${side(feedRun.kind)} breast</div></button>`;
  else if (bottleRun) feedTile = `<button class="tile feed running" data-act="feed"><div class="label">${bottleRun.stoppedAt ? 'Bottle stopped' : 'Bottle feeding'}</div>
      <div class="big">${bottleClock(bottleRun)}</div><div class="small">${bottleRun.stoppedAt ? 'tap to enter left over' : `${bottleRun.preparedMl ?? bottleRun.ml ?? 0} ml prepared`}</div></button>`;
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

  const sleepBtn = sl?.asleep
    ? `<button class="act sleep running" data-act="sleep"><span class="emoji">🌤️</span>Woke up<span class="hint" data-ago="${sl.since}">${ago(sl.since)}</span></button>`
    : `<button class="act sleep" data-act="sleep"><span class="emoji">😴</span>Sleep<span class="hint">${sl ? `awake ${ago(sl.since)}` : 'start'}</span></button>`;
  const feedBtn = feedRun
    ? `<button class="act feed running" data-act="stopfeed"><span class="emoji">⏹️</span>Stop feed<span class="hint" data-timer="${feedRun.start}">${side(feedRun.kind)} ${clockTimer(now - feedRun.start)}</span></button>`
    : bottleRun ? `<button class="act feed running" data-act="feed"><span class="emoji">🍼</span>${bottleRun.stoppedAt ? 'Finish bottle' : 'Stop bottle'}<span class="hint">${bottleClock(bottleRun)}</span></button>`
    : `<button class="act feed" data-act="feed"><span class="emoji">🍼</span>Feed<span class="hint">next: ${side(next)}</span></button>`;

  const st = L.stockTotals(S.milk, now);
  const flag = st.expired ? `<span class="flag bad">${st.expired} expired</span>` : st.soon ? `<span class="flag soon">${st.soon} use soon</span>` : '';
  // Title on top, then the amounts side by side in columns: (🏠 Room) ❄️ Fridge 🧊 Freezer, each with its ml.
  const amounts = st.room || st.fridge || st.freezer
    ? [st.room ? ['room', 'Room', st.room] : null, ['fridge', 'Fridge', st.fridge], ['freezer', 'Freezer', st.freezer]].filter(Boolean)
      .map(([k, l, ml]) => `<span class="sl-col"><small>${PLACE_EMOJI[k]} ${l}</small> <b>${ml} ml</b></span>`).join('')
    : '<span>Empty</span>';
  const stockLine = `<button class="stockline" data-nav="stock"><span class="sl-body"><small class="sl-title">Milk stock</small>
    <span class="sl-row">${amounts}</span></span>${flag}<span class="chev">›</span></button>`;
  const lastP = L.lastPump(list), ps = L.openPumpSession(list);
  const pumpBtn = ps && ps.end == null
    ? `<button class="act pump running" data-act="pump"><span class="emoji">⏹️</span>Stop pump<span class="hint" data-timer="${ps.start}">${clockTimer(now - ps.start)}</span></button>`
    : ps ? `<button class="act pump running" data-act="pump"><span class="emoji">🫙</span>Finish pump<span class="hint">not saved · ${dur(ps.end - ps.start)}</span></button>`
    : `<button class="act pump" data-act="pump"><span class="emoji">🫙</span>Pump<span class="hint">${lastP ? agoLong(lastP.end ?? lastP.start) : 'starts timer'}</span></button>`;

  app.innerHTML = `<div class="screen">
    <div class="topbar"><div class="grow"><h1>${esc(S.baby?.name || 'Baby')}</h1>
      <div class="sub">${esc(babyAge(S.baby?.birth))} ${syncBadge()}</div></div>
      <button class="iconbtn" data-nav="activity" aria-label="Activity">📋</button>
      <button class="iconbtn" data-nav="contacts" aria-label="Contacts">📞</button>
      <button class="iconbtn" data-nav="settings" aria-label="Settings">⚙️</button></div>
    <div class="now">${feedTile}${diaperTile}${sleepTile}${todayTile}</div>
    ${stockLine}
  </div>
  <div class="bar"><div class="bar-wrap"><div class="bar-inner">${feedBtn}
    ${pumpBtn}
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
  const fresh = !S.sheet;
  if (fresh) history.pushState({ sheet: true }, '');
  S.sheet = { kind, start: null, color: null, note: '', showNote: false, ...data };
  drawSheet();
  $('#sheet').hidden = false; document.documentElement.classList.add('sheet-open');
  if (fresh) $('#sheet').scrollTop = 0;
}
function closeSheet(fromBack = false) {
  if (!S.sheet) return;
  if (S.sheet.kind === 'sleep' && S.sheet.runningId) saveRunningSleepText();
  if (S.sheet.kind === 'feed' && S.sheet.runningId) {
    const e = all().find(x => x.id === S.sheet.runningId), note = readNote();
    if (e && e.end == null && note !== (e.note || '')) db.saveEntry(e.id, { note });
  }
  S.sheet = null;
  $('#sheet').hidden = true; document.documentElement.classList.remove('sheet-open');
  if (!fromBack) { S.ignorePop = true; history.back(); }
  render();
}

function timeChips() {
  const opts = [[null, 'Now'], [5, '5 min ago'], [10, '10 min ago'], [15, '15 min ago'], [30, '30 min ago'], [60, '1 h ago']];
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
    body = feedBody();
  } else if (sh.kind === 'pump') {
    body = pumpBody();
  } else if (sh.kind === 'pumped') {
    body = pumpedBody();
  } else if (sh.kind === 'milk') {
    body = milkBody();
  } else if (sh.kind === 'diaper') {
    body = `<div class="sheet-title"><h2>Diaper</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
      ${timeChips()}
      <div class="section-label">Colour (optional, pick before tapping)</div>
      <div class="timeline-chips">${Object.entries(COLORS).map(([n, c]) => `<button class="chip ${sh.color === n ? 'on' : ''}" data-color="${n}"><span class="swatch" style="background:${c}"></span>${n}</button>`).join('')}</div>
      ${noteBlock()}
      <div class="choices three diaper-go" style="--c:var(--diaper)">
        <button class="big-choice primary" data-diaper="wet"><span class="emoji">💧</span>Wet</button>
        <button class="big-choice primary" data-diaper="dirty"><span class="emoji">💩</span>Dirty</button>
        <button class="big-choice primary" data-diaper="both"><span class="emoji">💧💩</span>Both</button>
      </div>`;
  } else if (sh.kind === 'sleep') {
    const st = sh.sleepStart, back = [[5, '5 min'], [15, '15 min'], [30, '30 min']];
    body = `<div class="sheet-title"><h2>Sleep</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
      <button class="sleep-go running" data-act="stopsleep"><span class="emoji">🌤️</span>Baby woke up · stop<small>asleep since ${clock(st)} · ${dur(Date.now() - st)}</small></button>
      <div class="section-label">Fell asleep earlier?</div>
      <div class="timeline-chips">${back.map(([m, l]) => `<button class="chip" data-sback="${m}">${l} earlier</button>`).join('')}</div>
      ${sleepDetails(sh.d)}
      <p class="fine">Changes are saved to this sleep as you make them. Close the card any time; it keeps counting.</p>
      ${noteBlock()}`;
  } else if (sh.kind === 'edit') body = editBody();
  else if (sh.kind === 'contact') body = contactBody();
  el.innerHTML = body;
}

// ---------- Feed card ----------
// Top to bottom: time chips, Left / Right (each starts a breast timer), a full-width Bottle button
// that opens the bottle panel, + Add a note, then "Start bottle feeding".
// The bottle panel: Breast milk / Other, the target ml, and the bags to take from. Start only
// works once the bags picked cover the target. Starting takes the picked ml out of stock (the
// bottle is now prepared) and starts a timer. "Stop bottle feeding" then asks how many ml the
// baby left over (thrown away), and Save records eaten = prepared - leftover.
function feedBody() {
  const sh = S.sheet, list = all();
  const running = L.runningBottle(list);
  const head = `<div class="sheet-title"><h2>Feed</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>`;
  if (running) return head + runningBottleBody(running);
  const next = L.nextSide(list);
  sh.target ??= L.lastTarget(list, 60);
  return `${head}${timeChips()}
    <div class="choices">
      ${['left', 'right'].map(k => `<button class="big-choice ${k === next ? 'suggested' : ''}" data-feed="${k}">
        <span class="emoji">🤱</span>${side(k)}<small>${k === next ? 'next side · starts timer' : 'starts timer'}</small></button>`).join('')}
    </div>
    <button class="bottle-btn ${sh.bottleOpen ? 'on' : ''}" data-act="bottle"><span class="emoji">🍼</span>Bottle<small>${sh.bottleOpen ? 'tap to hide' : 'pick milk · starts timer'}</small></button>
    ${sh.bottleOpen ? bottlePanel() : ''}
    ${noteBlock()}
    ${sh.bottleOpen ? startBottleButton() : ''}`;
}
function bottlePanel() {
  const sh = S.sheet;
  const srcChips = `<div class="seg src"><button class="chip ${sh.source !== 'other' ? 'on' : ''}" data-src="breast">Breast milk</button>
    <button class="chip ${sh.source === 'other' ? 'on' : ''}" data-src="other">Other</button></div>`;
  const target = `<div class="amount"><div class="top"><span class="label">${sh.source === 'other' ? 'Amount' : 'Target'}</span>
      <div class="stepper"><button data-step="target:-10">−</button><span class="val">${sh.target} ml</span><button data-step="target:10">+</button></div></div></div>`;
  if (sh.source === 'other') return `${srcChips}${target}`;
  return `${srcChips}${target}${bagList()}`;
}
// The bag list for a breast-milk bottle. Tapping a bag picks it (taking only what's still needed);
// a picked bag gets − / + to change how much comes from it. Tap the bag again to unpick it.
function bagList() {
  const sh = S.sheet;
  const live = new Set(S.milk.filter(L.inStock).map(p => p.id));
  sh.picks = (sh.picks || []).filter(x => live.has(x.id)); // a bag used up on the other phone drops out
  const feedAt = sheetStart(), w = L.timeWindow(feedAt);
  const rows = L.bottleStock(S.milk, feedAt);
  const selected = L.pickedMl(sh.picks);
  const counter = `<p class="counter ${selected >= sh.target ? '' : 'off'}" id="bottle-count">${selected} of ${sh.target} ml selected${selected >= sh.target ? ' ✓' : ''}</p>`;
  if (!rows.length) return `<p class="fine">No milk in the fridge or at room temperature. Defrost a bag in Milk stock, or switch to Other.</p>${counter}`;
  let html = '', group = null;
  for (const { p, same, expired, defrosting } of rows) {
    const g = expired ? 'expired' : defrosting ? 'defrosting' : same ? 'same' : 'other';
    if (g !== group) {
      group = g;
      html += `<div class="section-label">${g === 'same' ? `Pumped in the ${L.WINDOWS[w].toLowerCase()} · use first` : g === 'other' ? 'Other times of day' : g === 'defrosting' ? `Defrosting · not ready yet (tap to use now)` : 'Expired · can\'t be used'}</div>`;
    }
    const pick = sh.picks.find(x => x.id === p.id);
    const pf = L.milkFlag(p);
    const extra = pick ? `<span class="num-in take-in"><button data-bstep="${p.id}:-5" aria-label="Less">−</button><b>${pick.ml} ml</b><button data-bstep="${p.id}:5" aria-label="More">+</button></span>` : '';
    const dc = defrostClass(p);
    html += `<div class="milkpick ${pick ? 'on' : ''} ${expired ? 'expired' : pf} ${dc}">
      <button class="milkrow ${pick ? 'on' : ''} ${pf} ${dc}" ${expired ? 'disabled' : defrosting ? `data-usenow="${p.id}"` : `data-pick="${p.id}"`}>
        <span class="code">${esc(p.code)}</span>
        <span class="mid"><b>${p.left === p.ml ? `${p.left} ml` : `${p.left} of ${p.ml} ml`}</b> · ${PLACE[p.place]} · ${L.WINDOWS[L.timeWindow(p.pumpedAt)]}
          <small>${defrosting ? `<b class="ready-in">ready in ${dur(L.readyAt(p) - Date.now())}</b> · ` : ''}pumped ${shortDate(p.pumpedAt)}, ${clock(p.pumpedAt)} · ${untilText(L.milkExpiry(p))}</small></span></button>${extra}</div>`;
  }
  return `${html}${counter}`;
}
function startBottleButton() {
  const sh = S.sheet, ok = L.canStartBottle(sh.source, sh.target, sh.picks || []);
  const short = sh.target - L.pickedMl(sh.picks || []);
  return `<button class="save bottle-go" data-act="startbottle" ${ok ? '' : 'disabled'}>▶ Start bottle feeding</button>
    ${ok ? '' : `<p class="fine center">${sh.source === 'other' ? 'Set an amount first.' : `Pick ${short} ml more from the bags to start.`}</p>`}`;
}
// Pressing Stop freezes the timer: the moment is saved on the bottle as stoppedAt (so the other phone
// and the home screen freeze too) and becomes the end time on Save. Back clears it and the timer carries on.
const bottleClock = e => e.stoppedAt
  ? `<span>${clockTimer(e.stoppedAt - e.start)}</span>`
  : `<span data-timer="${e.start}">${clockTimer(Date.now() - e.start)}</span>`;
function runningBottleBody(e) {
  const sh = S.sheet;
  sh.runningId = e.id;
  if (sh.showNote == null || sh.noteFor !== e.id) { sh.noteFor = e.id; sh.note = e.note || ''; sh.showNote = !!e.note; }
  if (sh.stopping == null) sh.stopping = !!e.stoppedAt; // reopened while stopped: straight to the leftover step
  const prepared = e.preparedMl ?? e.ml ?? 0;
  const from = isOther(e) ? 'Other' : (e.uses || []).map(u => `${u.ml} ml from ${esc(u.code)}`).join(' + ') || 'Breast milk';
  const info = `<div class="bottle-running"><div class="label">🍼 Bottle feeding</div>
      <div class="clock ${e.stoppedAt ? 'stopped' : ''}">${bottleClock(e)}</div>
      <div class="fine">${e.stoppedAt ? `Stopped at ${clock(e.stoppedAt)} · ` : ''}${prepared} ml prepared · ${from}<br>started ${clock(e.start)} · target ${e.targetMl ?? prepared} ml</div></div>`;
  if (!sh.stopping) return `${info}${noteBlock()}
    <button class="save bottle-go running" data-act="stopbottle">⏹ Stop bottle feeding</button>`;
  sh.leftover ??= 0;
  const eaten = L.bottleResult(prepared, sh.leftover).ml;
  return `${info}
    <div class="amount"><div class="top"><span class="label">Left over, thrown away</span>
      <span class="num-in big"><button data-lstep="-5">−</button><input type="number" inputmode="numeric" min="0" max="${prepared}" id="leftover" value="${sh.leftover}"><span>ml</span><button data-lstep="5">+</button></span></div>
      <p class="fine" id="eaten" style="margin:8px 0 0">Baby ate <b>${eaten} ml</b> of ${prepared} ml.</p></div>
    ${noteBlock()}
    <div class="btn-row"><button class="btn" data-act="stopback">Back</button><button class="btn primary" data-act="savebottle">Save</button></div>`;
}
function readLeftover() {
  const el = $('#leftover');
  if (el) S.sheet.leftover = Math.max(0, Math.round(Number(el.value) || 0));
  return S.sheet.leftover ?? 0;
}
function startBottle() {
  const sh = S.sheet;
  if (!L.canStartBottle(sh.source, sh.target, sh.picks || [])) return;
  const startAt = sheetStart(), note = readNote(), source = sh.source === 'other' ? 'other' : 'breast';
  const uses = source === 'breast' ? sh.picks.map(x => {
    const p = S.milk.find(m => m.id === x.id);
    return { id: x.id, code: p.code, ml: x.ml, place: p.place, pumpedAt: p.pumpedAt, window: L.timeWindow(p.pumpedAt) };
  }) : [];
  const preparedMl = source === 'breast' ? L.pickedMl(uses) : sh.target;
  const backdated = Date.now() - startAt > L.MIN;
  closeSheet();
  logEntry({ type: 'feed', kind: 'bottle', start: startAt, note, source, uses, targetMl: sh.target, preparedMl, ml: preparedMl,
    leftoverMl: null, window: L.timeWindow(startAt) },
    { toastText: `Bottle started · ${preparedMl} ml${backdated ? ` at ${clock(startAt)}` : ''}`, extra: () => [] });
}
function saveBottle() {
  const sh = S.sheet, e = all().find(x => x.id === sh.runningId);
  if (!e) return closeSheet();
  const prepared = e.preparedMl ?? e.ml ?? 0;
  const { ml, leftoverMl } = L.bottleResult(prepared, readLeftover());
  const end = Math.max(e.stoppedAt ?? Date.now(), e.start), note = readNote();
  db.saveEntry(e.id, { end, ml, leftoverMl, note });
  sh.runningId = null;
  closeSheet();
  buzz();
  toast(`Bottle · ate ${ml} ml${leftoverMl ? `, ${leftoverMl} thrown away` : ''} · ${dur(end - e.start)}`, [
    { label: 'Undo', fn: () => db.saveEntry(e.id, { end: null, ml: prepared, leftoverMl: null }) }, // stays stopped, leftover step again
    { label: 'Edit', fn: () => openEdit(e.id) },
  ]);
}
function milkRow(p, attrs, on, extra = '') {
  const f = L.milkFlag(p), dc = defrostClass(p);
  return `<button class="milkrow ${on ? 'on' : ''} ${f} ${dc}" ${attrs}>
    <span class="code">${esc(p.code)}</span>
    <span class="mid"><b>${p.left === p.ml ? `${p.left} ml` : `${p.left} of ${p.ml} ml`}</b> · ${PLACE[p.place]}${p.container ? ` · ${CONTAINER[p.container]}` : ''}
      <small>${dc === 'defrosting' ? `<b class="ready-in">ready in ${dur(L.readyAt(p) - Date.now())}</b> · ` : ''}pumped ${shortDate(p.pumpedAt)}, ${clock(p.pumpedAt)} · ${untilText(L.milkExpiry(p))}</small></span>${extra}</button>`;
}
// "Use now" on a bag that is still defrosting: asks first, then marks it ready.
function askUseNow(id) {
  const p = S.milk.find(x => x.id === id);
  if (!p) return;
  confirmBox(`Use ${p.code} before the ${L.MILK_RULES.defrostHours} h defrost is over?`, 'Use', () => {
    const at = Date.now();
    S.milk = S.milk.map(x => (x.id === id ? { ...x, readyAt: at, usedEarly: true } : x));
    db.saveMilk(id, { readyAt: at, usedEarly: true });
    if (S.sheet?.kind === 'milk') { S.sheet.draft = { ...S.sheet.draft, readyAt: at, usedEarly: true }; }
    if (S.sheet) { if (S.sheet.kind === 'feed') keepFeedInputs(); drawSheet(); }
    render();
    toast(`${p.code} ready to use`, []);
  });
}
// A small in-app popup with Cancel and one action button.
function confirmBox(text, okLabel, onOk) {
  const el = document.createElement('div');
  el.className = 'confirm';
  el.innerHTML = `<div class="confirm-box" role="dialog"><p>${esc(text)}</p>
    <div class="btn-row"><button class="btn" data-cf="no">Cancel</button><button class="btn primary" data-cf="yes">${esc(okLabel)}</button></div></div>`;
  el.addEventListener('click', ev => {
    const b = ev.target.closest('[data-cf]');
    ev.stopPropagation();
    if (!b) return;
    el.remove();
    if (b.dataset.cf === 'yes') onOk();
  });
  document.body.appendChild(el);
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
// Tap 1 starts a session timer (no card). Tap 2 stops it and opens the card, where each breast gets
// its ml, its own minutes and its bags. Closing the card without saving keeps the session as
// "Finish pump" so nothing is lost.
function pumpTap() {
  const ps = L.openPumpSession(all());
  if (!ps) {
    const id = logEntry({ type: 'pumpsession' }, { toastText: 'Pumping started', extra: () => [] });
    return id;
  }
  if (ps.end == null) {
    const end = Date.now();
    db.saveEntry(ps.id, { end });
    buzz();
    return openPumpCard({ ...ps, end });
  }
  openPumpCard(ps);
}
function newBag(ml) { return { ml, place: store.get('pumpPlace') || 'fridge', container: store.get('pumpContainer') || 'bag' }; }
// Each side stores its milk separately ("Store separately") or both sides go into shared bags ("Combine all"),
// never both. Combined bags: the first bag holds whatever the other bags don't, so they always add up to Left + Right.
function openPumpCard(ps) {
  const mins = Math.max(1, Math.round((ps.end - ps.start) / L.MIN));
  const sideState = () => ({ ml: 0, min: mins, bags: [newBag(0)], open: false });
  openSheet('pump', { sessionId: ps.id, pStart: ps.start, pEnd: ps.end, sides: { left: sideState(), right: sideState() },
    combo: { open: false, bags: [newBag(0)] }, note: ps.note || '', showNote: !!ps.note, confirmDiscard: false });
}
const pumpTotal = sh => sh.sides.left.ml + sh.sides.right.ml;
const pumpMode = sh => (sh.combo.open ? 'combined' : sh.sides.left.open || sh.sides.right.open ? 'separate' : null);
// The first combined bag is the rest of the total.
function fixCombo(sh) {
  const total = pumpTotal(sh), bags = sh.combo.bags;
  let rest = bags.slice(1).reduce((a, b) => a + (b.ml || 0), 0);
  for (let i = bags.length - 1; i > 0 && rest > total; i--) { const cut = Math.min(bags[i].ml, rest - total); bags[i].ml -= cut; rest -= cut; }
  bags[0].ml = total - rest;
}
function pumpProblem(sh) {
  const mode = pumpMode(sh);
  if (mode === 'combined') return L.comboProblem(sh.combo.bags);
  if (mode === 'separate') return ['left', 'right'].map(k => sh.sides[k].open && L.sideProblem(sh.sides[k]) && `${side(k)}: ${L.sideProblem(sh.sides[k])}`).filter(Boolean)[0] || null;
  return null;
}
const pumpHint = (sh, total) => !total ? 'Add the ml for at least one side.'
  : !pumpMode(sh) ? 'Choose Store separately or Combine all.' : 'The codes to write on the bags show after saving.';
const placeChips = (b, attr) => `<div class="seg">${['room', 'fridge', 'freezer'].map(v => `<button class="chip ${b.place === v ? 'on' : ''}" ${attr('place', v)}>${PLACE[v]}</button>`).join('')}</div>
      <div class="seg" style="margin-top:6px">${['bag', 'bottle'].map(v => `<button class="chip ${b.container === v ? 'on' : ''}" ${attr('cont', v)}>${CONTAINER[v]}</button>`).join('')}</div>`;
function pumpSideBlock(k) {
  const sd = S.sheet.sides[k];
  const many = sd.bags.length > 1;
  const assigned = sd.bags.reduce((a, b) => a + (b.ml || 0), 0);
  const bag = (b, i) => `<div class="bag">
      <div class="bag-top"><b>${many ? `Bag ${i + 1}` : 'Storage'}</b>
        ${many ? `<span class="num-in"><button data-pstep="${k}.bags.${i}.ml:-5">−</button><input type="number" inputmode="numeric" min="0" data-pin="${k}.bags.${i}.ml" value="${b.ml || 0}"><span>ml</span><button data-pstep="${k}.bags.${i}.ml:5">+</button></span>
          <button class="rm" data-rmbag="${k}:${i}" aria-label="Remove bag">✕</button>` : ''}</div>
      ${placeChips(b, (w, v) => `data-p${w}="${k}:${i}:${v}"`)}
    </div>`;
  const left = sd.ml - assigned;
  return `<div class="amount pside ${sd.ml > 0 ? 'on' : ''}"><div class="top"><span class="label">${side(k)}</span>
      <span class="num-in big"><button data-pstep="${k}.ml:-5">−</button><input type="number" inputmode="numeric" min="0" data-pin="${k}.ml" value="${sd.ml}"><span>ml</span><button data-pstep="${k}.ml:5">+</button></span></div>
    ${sd.ml > 0 ? `<div class="top" style="margin-top:8px"><span class="fine" style="margin:0">Minutes</span>
      <span class="num-in"><button data-pstep="${k}.min:-1">−</button><input type="number" inputmode="numeric" min="0" data-pin="${k}.min" value="${sd.min}"><span>min</span><button data-pstep="${k}.min:1">+</button></span></div>
      <button class="storebtn ${sd.open ? 'on' : ''}" data-pstore="${k}" aria-expanded="${sd.open}">Store separately<span>${sd.open ? '▴' : '▾'}</span></button>
      ${sd.open ? `${sd.bags.map(bag).join('')}
      ${many ? `<p class="counter ${left ? 'off' : ''}" id="cnt-${k}">${left > 0 ? `${left} ml still to put in a bag` : left < 0 ? `${-left} ml too many` : 'All ml in bags ✓'}</p>` : ''}
      <button class="notebtn" data-addbag="${k}">+ Add bag</button>` : ''}` : '<p class="fine" style="margin:6px 0 0">0 ml = not pumped</p>'}
  </div>`;
}
function comboBlock() {
  const sh = S.sheet, c = sh.combo, total = pumpTotal(sh);
  if (!total) return '';
  const many = c.bags.length > 1;
  const bag = (b, i) => `<div class="bag">
      <div class="bag-top"><b>${many ? `Bag ${i + 1}` : 'Quantity'}</b>
        ${many || i > 0 ? `<span class="num-in"><button data-cstep="${i}:-5">−</button><input type="number" inputmode="numeric" min="0" data-cin="${i}" value="${b.ml || 0}"><span>ml</span><button data-cstep="${i}:5">+</button></span>
          <button class="rm" data-crmbag="${i}" aria-label="Remove bag">✕</button>` : `<span class="combo-ml"><b data-cml="0">${b.ml}</b> ml</span>`}</div>
      ${placeChips(b, (w, v) => `data-c${w}="${i}:${v}"`)}
    </div>`;
  return `<button class="btn wide storebtn-all ${c.open ? 'on' : ''}" data-act="combine" aria-expanded="${c.open}">Combine all${c.open ? ` · ${total} ml ▴` : ' ▾'}</button>
    ${c.open ? `<div class="amount pside on combo"><div class="top"><span class="label">Left + Right</span><span class="label">${total} ml</span></div>
      ${c.bags.map(bag).join('')}
      ${many ? '<p class="fine" style="margin:8px 0 0">Bag 1 holds what the other bags don\'t, so the bags always add up to the total.</p>' : ''}
      <button class="notebtn" data-caddbag="1">+ Add bag</button></div>` : ''}`;
}
function pumpBody() {
  const sh = S.sheet;
  sh.needsRedraw = false;
  for (const k of ['left', 'right']) sh.sides[k].shown = sh.sides[k].ml > 0;
  sh.comboShown = pumpTotal(sh) > 0;
  fixCombo(sh);
  const problem = pumpProblem(sh), total = pumpTotal(sh);
  return `<div class="sheet-title"><h2>Pump · ${dur(sh.pEnd - sh.pStart)}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    ${pumpSideBlock('left')}${pumpSideBlock('right')}
    ${comboBlock()}
    ${noteBlock()}
    <p class="fine" id="pump-problem">${problem || pumpHint(sh, total)}</p>
    <div class="btn-row end"><button class="btn" data-act="close">Cancel</button>
      <button class="btn primary pumpsave" data-act="savepump" ${sh.saving || problem || !total ? 'disabled' : ''}>${sh.saving ? 'Saving…' : `Save · ${total} ml`}</button></div>
    ${sh.saved ? '' : `<button class="btn danger wide" style="margin-top:18px" data-act="discardsession">${sh.confirmDiscard ? 'Tap again to discard this session' : 'Discard session'}</button>`}`;
}
// Number fields in the pump card update the state as you type (no redraw, so the keyboard stays up).
function pumpInput(el) {
  const sh = S.sheet;
  const v = Math.max(0, Math.round(Number(el.value) || 0));
  if (el.dataset.cin != null) return setComboMl(sh, +el.dataset.cin, v);
  const path = el.dataset.pin.split('.');
  let o = sh.sides;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path.at(-1)] = v;
  const [k, f] = path;
  if (f === 'ml' && path.length === 2) {
    const sd = sh.sides[k];
    if (sd.bags.length === 1) sd.bags[0].ml = v;
    if ((v > 0) !== !!sd.shown || (pumpTotal(sh) > 0) !== !!sh.comboShown) sh.needsRedraw = true; // bags appear/disappear
    fixCombo(sh);
  }
}
// Setting a combined bag: bag 1 takes the difference. Setting bag 1 itself moves the difference to the last bag.
function setComboMl(sh, i, v) {
  const bags = sh.combo.bags, total = pumpTotal(sh);
  if (i === 0) {
    if (bags.length < 2) return fixCombo(sh);
    const last = bags.at(-1), others = bags.slice(1, -1).reduce((a, b) => a + (b.ml || 0), 0);
    last.ml = Math.max(0, total - others - Math.min(v, total - others));
  } else {
    const others = bags.slice(1).reduce((a, b, j) => a + (j + 1 === i ? 0 : b.ml || 0), 0);
    bags[i].ml = Math.min(v, Math.max(0, total - others));
  }
  fixCombo(sh);
}
// Saving with no storage chosen: say so and open Store separately on each side that has milk.
function needStorage(sh) {
  const missing = ['left', 'right'].filter(k => sh.sides[k].ml > 0 && !sh.sides[k].open);
  if (pumpMode(sh) === 'combined' || !missing.length) return false;
  sh.combo.open = false;
  for (const k of ['left', 'right']) if (sh.sides[k].ml > 0) sh.sides[k].open = true;
  drawSheet();
  alertBox('Choose how to store the milk', missing.length === 2 || !pumpMode(sh) ? 'Pick the storage for Left and Right under Store separately, or use Combine all.' : `Pick the storage for ${side(missing[0])} too.`);
  return true;
}
// Saves the pump. After Back on the codes page, saving again updates the same records, bags and codes.
async function savePump() {
  const sh = S.sheet;
  if (sh.saving) return;
  sh.note = readNote();
  if (needStorage(sh)) return;
  sh.saving = true; drawSheet();
  const prev = sh.saved || { entry: {}, milk: [], seq: {} };
  const pool = [...prev.milk];
  const saved = { entry: {}, milk: [], seq: { ...prev.seq } };
  const labels = [], made = [];
  let offline = false;
  const seqFor = async k => {
    if (saved.seq[k]) return saved.seq[k];
    const r = await db.nextPumpSeq(k, L.maxSeq(all())[k]);
    offline ||= r.offline;
    return (saved.seq[k] = r.seq);
  };
  const makeBags = (code, bags, sideKey, pumpedAt) => {
    const codes = L.bagCodes(code, bags);
    const portions = bags.map((b, i) => {
      const id = pool.shift() || db.newMilkId();
      db.saveMilk(id, { code: codes[i], pumpCode: code, side: sideKey, place: b.place, container: b.container, ml: b.ml, left: b.ml, pumpedAt,
        thawedAt: null, by: S.me, note: '', deleted: false, discarded: false, createdAt: Date.now() });
      labels.push({ side: sideKey, code: codes[i], place: b.place, container: b.container, ml: b.ml });
      saved.milk.push(id);
      return id;
    });
    return { portions, bags: bags.map((b, i) => ({ code: codes[i], place: b.place, container: b.container, ml: b.ml })) };
  };
  const sideEnd = k => Math.min(sh.pEnd, sh.pStart + sh.sides[k].min * L.MIN);
  const sidesWithMilk = ['left', 'right'].filter(k => sh.sides[k].ml > 0);
  const saveSide = (k, fields) => {
    const sd = sh.sides[k], id = prev.entry[k] || db.newId();
    db.saveEntry(id, { id, type: 'pump', kind: k, start: sh.pStart, end: sideEnd(k), ml: sd.ml, sessionId: sh.sessionId,
      note: sh.note, by: S.me, createdAt: Date.now(), deleted: false, color: null, ...fields });
    saved.entry[k] = id;
    made.push({ id, portions: fields.portions });
  };
  if (pumpMode(sh) === 'combined') {
    fixCombo(sh);
    const seq = await seqFor('both'), code = L.pumpCode('both', seq), total = pumpTotal(sh);
    const { portions, bags } = makeBags(code, sh.combo.bags, 'both', Math.max(...sidesWithMilk.map(sideEnd)));
    for (const k of sidesWithMilk) saveSide(k, { code, seq: null, lrSeq: seq, combined: true, combinedMl: total, bags, portions });
    const last = sh.combo.bags.at(-1); store.set('pumpPlace', last.place); store.set('pumpContainer', last.container);
  } else {
    for (const k of sidesWithMilk) {
      const sd = sh.sides[k];
      if (sd.bags.length === 1) sd.bags[0].ml = sd.ml;
      const seq = await seqFor(k), code = L.pumpCode(k, seq);
      const { portions, bags } = makeBags(code, sd.bags, k, sideEnd(k));
      saveSide(k, { code, seq, lrSeq: null, combined: false, combinedMl: null, bags, portions });
      const last = sd.bags.at(-1); store.set('pumpPlace', last.place); store.set('pumpContainer', last.container);
    }
  }
  // Bags and records from the earlier save that aren't needed any more.
  for (const id of pool) db.saveMilk(id, { deleted: true });
  for (const k of ['left', 'right']) if (prev.entry[k] && !saved.entry[k]) db.saveEntry(prev.entry[k], { deleted: true });
  db.saveEntry(sh.sessionId, { deleted: true });
  buzz();
  toast(`Pump saved · ${labels.map(l => l.code).join(', ')}`, [{ label: 'Undo', fn: () => {
    for (const m of made) { db.saveEntry(m.id, { deleted: true }); for (const pid of m.portions) db.saveMilk(pid, { deleted: true }); }
    db.saveEntry(sh.sessionId, { deleted: false });
  } }]);
  if (!S.sheet) return; // closed while saving
  const form = { ...sh, saving: false, saved };
  S.sheet = { kind: 'pumped', labels, offline, total: pumpTotal(sh), minutes: Math.round((sh.pEnd - sh.pStart) / L.MIN), form };
  drawSheet();
}
function pumpedBody() {
  const sh = S.sheet;
  const group = k => sh.labels.filter(l => l.side === k);
  return `<div class="sheet-title"><h2>Saved · ${sh.total} ml</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <div class="section-label">Write on the bag${sh.labels.length > 1 ? 's' : ''}</div>
    ${['left', 'right', 'both'].filter(k => group(k).length).map(k => `<div class="fine" style="margin:8px 0 4px"><b>${k === 'both' ? 'Left + Right combined' : side(k)}</b></div>
      ${group(k).map(l => `<div class="label-card ${l.place}"><span class="code">${esc(l.code)}</span><span>${PLACE[l.place]} · ${CONTAINER[l.container]} · ${l.ml} ml</span></div>`).join('')}`).join('')}
    ${sh.offline ? '<p class="fine">No signal, so the numbers were given on this phone. They only clash if the other phone saved the same breast while offline too.</p>' : ''}
    <div class="btn-row" style="margin-top:14px"><button class="btn" data-act="pumpback">Back</button><button class="btn primary" data-act="close">Done</button></div>`;
}
// Back on the codes page: the Pump page again, as it was, to change the storage.
function pumpBack() {
  const form = S.sheet?.form;
  if (!form) return;
  S.sheet = form;
  drawSheet();
  $('#sheet').scrollTop = 0;
}
function alertBox(text, sub) {
  const el = document.createElement('div');
  el.className = 'confirm';
  el.innerHTML = `<div class="confirm-box" role="alertdialog"><p>${esc(text)}</p>${sub ? `<p class="fine" style="margin:0 0 14px;font-weight:400;font-size:16px">${esc(sub)}</p>` : ''}
    <div class="btn-row"><button class="btn primary" data-cf="ok">OK</button></div></div>`;
  el.addEventListener('click', ev => { ev.stopPropagation(); if (ev.target.closest('[data-cf]')) el.remove(); });
  document.body.appendChild(el);
}
function discardSession() {
  const id = S.sheet.sessionId;
  db.saveEntry(id, { deleted: true });
  closeSheet();
  toast('Pump session discarded', [{ label: 'Undo', fn: () => db.saveEntry(id, { deleted: false }) }]);
}

// ---------- Activity ----------
// Every record, grouped by day, with filters. Tap a record to edit it.
const afDefaults = () => ({ types: [], when: '7d', who: 'any', order: 'new', open: false });
const AF_TYPES = [['feed', '🍼 Feed'], ['diaper', '🧷 Diaper'], ['sleep', '😴 Sleep'], ['pump', '🫙 Pump']];
const AF_WHEN = [['today', 'Today'], ['24h', 'Last 24 h'], ['7d', '7 days'], ['all', 'All']];
const AF_WHO = [['any', 'Anyone'], ['Sergio', 'Sergio'], ['Ana Rita', 'Ana Rita']];
const AF_ORDER = [['new', 'Newest first'], ['old', 'Oldest first']];
const afActive = f => { const d = afDefaults(); return f.types.length > 0 || f.when !== d.when || f.who !== d.who || f.order !== d.order; };
function afFilter(list, f, now = Date.now()) {
  const from = { today: L.startOfDay(now), '24h': now - L.DAY, '7d': L.startOfDay(now) - 6 * L.DAY, all: -Infinity }[f.when];
  const typeOf = e => (e.type === 'pumpsession' ? 'pump' : e.type);
  const out = list.filter(e => e.start >= from && (!f.types.length || f.types.includes(typeOf(e))) && (f.who === 'any' || e.by === f.who));
  return out.sort((a, b) => (f.order === 'old' ? a.start - b.start : b.start - a.start));
}
function recordRows(list) {
  let rows = '', lastDay = null;
  for (const e of list) {
    const d = dayLabel(e.start);
    if (d !== lastDay) { rows += `<div class="day">${d}</div>`; lastDay = d; }
    const { ic, what } = describe(e);
    rows += `<button class="row" data-edit="${e.id}"><span class="ic">${ic}</span><span class="main">
      <div class="what">${esc(what)}${whoTag(e.by)}${S.pending.has(e.id) ? ' <span class="waiting-mark">⏳</span>' : ''}</div>
      ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</span><span class="time">${clock(e.start)}</span></button>`;
  }
  return rows;
}
function renderActivity(app) {
  const f = S.af ||= afDefaults();
  const everything = all(), list = afFilter(everything, f), on = afActive(f);
  const chips = (opts, attr, isOn) => `<div class="timeline-chips">${opts.map(([v, l]) => `<button class="chip ${isOn(v) ? 'on' : ''}" data-${attr}="${v}">${l}</button>`).join('')}</div>`;
  const panel = f.open ? `<div class="filters">
      <div class="flabel">Type <small>· pick one or more</small></div>
      <div class="timeline-chips"><button class="chip ${f.types.length ? '' : 'on'}" data-fall="">All</button>${AF_TYPES.map(([v, l]) => `<button class="chip ${f.types.includes(v) ? 'on' : ''}" data-ftype="${v}">${l}</button>`).join('')}</div>
      <div class="flabel">When</div>${chips(AF_WHEN, 'fwhen', v => f.when === v)}
      <div class="flabel">Logged by</div>${chips(AF_WHO, 'fwho', v => f.who === v)}
      <div class="flabel">Order</div>${chips(AF_ORDER, 'forder', v => f.order === v)}
    </div>` : '';
  let body = recordRows(list);
  if (!list.length) body = `<div class="empty">${everything.length ? 'Nothing matches these filters.' : 'Nothing logged yet.'}</div>`;
  app.innerHTML = `<div class="screen activity-screen" style="padding-bottom:40px">
    <div class="topbar"><button class="iconbtn" data-nav="home" aria-label="Back">←</button><div class="grow"><h1>Activity</h1>
      <div class="sub">${list.length} record${list.length === 1 ? '' : 's'} ${syncBadge()}</div></div>
      ${on ? '<button class="fclear" data-act="fclear">Clear</button>' : ''}
      <button class="filterbtn ${f.open ? 'open' : ''}" data-act="filters" aria-expanded="${f.open}">Filter${on ? '<span class="fdot"></span>' : ''}</button></div>
    ${panel}
    ${body}
    ${f.when === 'all' ? '<button class="more" data-act="older">Show earlier days</button>' : ''}
  </div>`;
}

// ---------- Milk stock ----------
function renderStock(app) {
  const stock = L.stockList(S.milk), st = L.stockTotals(S.milk);
  const room = stock.filter(p => p.place === 'room'), fridge = stock.filter(p => L.inFridge(p) && p.place !== 'room'), frozen = stock.filter(p => !L.inFridge(p));
  const section = (name, list, empty) => `<div class="day">${PLACE_EMOJI[{ 'Room temp': 'room', Fridge: 'fridge', Freezer: 'freezer' }[name]]} ${name} · ${list.reduce((a, p) => a + p.left, 0)} ml</div>
    ${list.length ? list.map(p => milkRow(p, `data-milk="${p.id}"`, false, `${S.milkPending.has(p.id) ? '<span class="waiting-mark">⏳</span>' : ''}<span class="chev">›</span>`)).join('') : `<div class="empty" style="padding:12px">${empty}</div>`}`;
  app.innerHTML = `<div class="screen" style="padding-bottom:40px">
    <div class="topbar"><button class="iconbtn" data-nav="home" aria-label="Back">←</button><div class="grow"><h1>Milk stock</h1>
      <div class="sub">${st.fridge + st.freezer} ml in ${stock.length} bag${stock.length === 1 ? '' : 's'}${st.expired ? ` · <span class="flag bad">${st.expired} expired</span>` : ''}${st.soon ? ` · <span class="flag soon">${st.soon} use soon</span>` : ''}</div></div></div>
    ${room.length ? section('Room temp', room, '') : ''}
    ${section('Fridge', fridge, 'Nothing in the fridge.')}
    ${section('Freezer', frozen, 'Nothing in the freezer.')}
    <p class="fine" style="margin-top:18px">Oldest first. Room temperature milk keeps ${L.MILK_RULES.roomHours} hours, fridge milk ${L.MILK_RULES.fridgeDays} days from pumping, frozen milk ${L.MILK_RULES.freezerMonths} months, and defrosted milk ${L.MILK_RULES.thawedHours} hours from defrosting. A defrosted bag is grey for its first ${L.MILK_RULES.defrostHours} hours while it defrosts, then light blue when ready. Tap a bag to defrost it, change what's left, or discard it.</p>
  </div>`;
}
// The bag card: code, place, pumped, side and container, expiry, milk left, note, Defrost, Discard / Save.
function milkBody() {
  const sh = S.sheet, p = sh.draft, f = L.milkFlag(p), dc = defrostClass(p);
  const defrostLine = p.place === 'thawed'
    ? `<p class="mk-line defrost-state ${dc}">${dc === 'defrosting'
        ? `⏳ Defrosting since ${clock(p.thawedAt)} · ready in <b>${dur(L.readyAt(p) - Date.now())}</b>`
        : `✅ Ready to use${p.usedEarly ? ' (used before the 12 h)' : ''} · defrosted ${shortDate(p.thawedAt)}, ${clock(p.thawedAt)}`}</p>` : '';
  const note = sh.showNote
    ? `<label class="field"><span>Note (optional)</span><textarea id="mk-note">${esc(sh.note)}</textarea></label>`
    : `<button class="notebtn" data-act="mknote">+ Add note</button>`;
  return `<div class="sheet-title"><h2 class="code-title">${esc(p.code)}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <p class="mk-line mk-place"><span class="emoji">${PLACE_EMOJI[p.place]}</span> <b>${PLACE[p.place]}</b> <span class="muted">(${PLACE_KEEP[p.place]})</span></p>
    <p class="mk-line mk-pumped">🫙 Pumped ${shortDate(p.pumpedAt)}, ${clock(p.pumpedAt)}</p>
    <p class="mk-line mk-side">🤱 ${side(p.side)} breast${p.container ? ` · ${CONTAINER[p.container]}` : ''}</p>
    ${defrostLine}
    <div class="expiry ${f}"><span>${f === 'expired' ? 'Expired:' : 'Expiry:'}</span><b>${longDate(L.milkExpiry(p))}</b></div>
    <label class="field"><span>Milk left (ml, of ${p.ml})</span><input type="number" inputmode="numeric" id="mk-left" value="${sh.leftVal ?? p.left}"></label>
    ${note}
    ${p.place === 'freezer' ? '<button class="btn wide defrost-btn" data-act="defrost">💧 Defrost · move to fridge</button>' : ''}
    ${dc === 'defrosting' ? `<button class="btn wide defrost-btn" data-usenow="${p.id}">Use now</button>` : ''}
    <div class="btn-row"><button class="btn danger" data-act="discard">${S.sheet.confirmDiscard ? 'Tap again to discard' : 'Discard'}</button>
      <button class="btn primary" data-act="savemilk">Save</button></div>`;
}
function saveMilkEdit() {
  const p = S.sheet.draft, fields = {};
  const left = Math.max(0, Math.round(Number($('#mk-left').value) || 0));
  if (left !== p.left) fields.left = left;
  const note = ($('#mk-note')?.value ?? p.note ?? '').trim(); if (note !== (p.note || '')) fields.note = note;
  if (Object.keys(fields).length) db.saveMilk(p.id, fields);
  closeSheet();
  if (Object.keys(fields).length) toast(left === 0 ? `${p.code} used up` : 'Saved', []);
}
function defrostMilk() {
  const p = S.sheet.draft, now = Date.now();
  db.saveMilk(p.id, { place: 'thawed', thawedAt: now, readyAt: null, usedEarly: false });
  closeSheet();
  toast(`${p.code} defrosting · ready in ${L.MILK_RULES.defrostHours} h, use within ${L.MILK_RULES.thawedHours} h`, [{ label: 'Undo', fn: () => db.saveMilk(p.id, { place: 'freezer', thawedAt: null }) }]);
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
  const timedBottle = L.isBottle(d) && d.preparedMl != null; // bottles from Nov 2026 on have a timer
  const hasEnd = d.type === 'sleep' || L.isBreast(d) || timedBottle || (d.type === 'pump' && d.end != null && d.end !== d.start);
  const hasMl = d.type === 'feed' && (d.kind === 'bottle' || d.kind === 'pump') && !timedBottle;
  const title = { feed: 'Edit feed', diaper: 'Edit diaper', sleep: 'Edit sleep', pump: `Edit pump${d.code ? ` · ${d.code}` : ''}` }[d.type];
  const milkInfo = d.type === 'pump'
    ? `<p class="fine">${side(d.kind)} breast · ${d.ml || 0} ml${d.bags?.length ? ` · ${d.bags.map(b => `${esc(b.code)} ${PLACE[b.place]} ${b.ml} ml`).join(', ')}`
        : `${d.fridgeMl ? ` · fridge ${d.fridgeMl} ml (${esc(d.code)})` : ''}${d.freezerMl ? ` · freezer ${d.freezerMl} ml (${esc(d.code)}-F)` : ''}`}.
        Changing the end time also moves the use-by dates. To change amounts, open the bag in Milk stock. Deleting this removes its bags from stock.</p>`
    : d.kind === 'bottle' && d.uses?.length
      ? `<p class="fine">Took ${d.uses.map(u => `${u.ml} ml from ${esc(u.code)}`).join(', ')}. Changing amounts here doesn't change the stock; deleting puts the milk back.</p>`
      : d.kind === 'bottle' && isOther(d) ? '<p class="fine">Other (not from stock)</p>' : '';
  const bottleFields = timedBottle ? `<p class="fine">Target ${d.targetMl ?? '–'} ml · prepared ${d.preparedMl} ml${d.window ? ` · ${L.WINDOWS[d.window]}` : ''}</p>
    <label class="field"><span>Left over, thrown away (ml)</span><input type="number" inputmode="numeric" min="0" id="ed-leftover" value="${d.leftoverMl ?? 0}"></label>
    <p class="fine">Baby ate ${L.bottleResult(d.preparedMl, d.leftoverMl).ml} ml.</p>` : '';
  return `<div class="sheet-title"><h2>${title}</h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    ${kinds.length ? `<div class="seg" style="margin-bottom:12px">${kinds.map(([k, l]) => `<button class="chip ${d.kind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('')}</div>` : ''}
    <label class="field"><span>${hasEnd ? 'Started' : 'Time'}</span><input type="datetime-local" id="ed-start" value="${toInput(d.start)}"></label>
    ${hasEnd ? (d.end == null
      ? `<div class="field"><span>Ended</span><button class="btn wide" data-act="endnow">Still going · tap to stop now</button></div>`
      : `<label class="field"><span>Ended</span><input type="datetime-local" id="ed-end" value="${toInput(d.end)}"></label>`) : ''}
    ${d.type === 'sleep' ? sleepDetails(d) : ''}${milkInfo}${bottleFields}
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
  if ($('#ed-leftover')) Object.assign(d, L.bottleResult(d.preparedMl, Number($('#ed-leftover').value) || 0));
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
  if (d.type === 'diaper' || (d.type === 'feed' && !L.isBreast(d) && !(L.isBottle(d) && d.preparedMl != null))) d.end = d.start;
  if (L.isBottle(d) && d.preparedMl != null) d.window = L.timeWindow(d.start);
  const changed = {};
  for (const k of ['kind', 'start', 'end', 'ml', 'color', 'note', 'leftoverMl', 'window', ...(d.type === 'sleep' ? L.SLEEP_FIELDS : [])]) if ((d[k] ?? null) !== (orig[k] ?? null)) changed[k] = d[k] ?? null;
  if (Object.keys(changed).length) db.saveEntry(d.id, changed);
  if (d.type === 'pump' && ('start' in changed || 'end' in changed)) for (const pid of d.portions || []) db.saveMilk(pid, { pumpedAt: d.end ?? d.start });
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
    'day_night', 'cover', 'location', 'sound', 'night_light', 'room_temp_c', 'pump_code', 'bottle_source', 'milk_used',
    'bottle_target_ml', 'bottle_prepared_ml', 'bottle_leftover_ml', 'time_of_day']];
  for (const e of all()) {
    rows.push([e.type, e.kind || '', new Date(e.start).toISOString(), e.end ? new Date(e.end).toISOString() : '',
      e.end ? Math.round((e.end - e.start) / L.MIN) : '', e.ml ?? '', e.color || '', e.note || '', e.by || '',
      e.period || '', optLabel('cover', e.cover), optLabel('location', e.location), optLabel('sound', e.sound),
      e.type === 'sleep' && e.nightLight != null ? (e.nightLight ? 'yes' : 'no') : '', e.tempC ?? '',
      e.code || '', isOther(e) ? 'other' : e.source || '', (e.uses || []).map(u => `${u.code} ${u.ml} ml`).join('; '),
      e.targetMl ?? '', e.preparedMl ?? '', e.leftoverMl ?? '', e.window || '']);
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
  el.style.transform = ''; el.style.opacity = ''; el.classList.remove('leaving');
  el.hidden = false; document.body.classList.add('toast-on');
  toastAutoHide(actions.length ? 7000 : 2500);
}
function toastAutoHide(ms) { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms); }
function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true; document.body.classList.remove('toast-on');
}

// ---------- Swipe gestures ----------
// Swipe the toast left or right to dismiss it. A short movement still counts as a normal tap.
function swipe(el, { start, axis, done, threshold, move }) {
  let s = null;
  const src = el; el = move || el; // touches are read on src, the movement is shown on el
  src.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1 || !start(ev)) return;
    s = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: Date.now(), d: 0, on: false };
  }, { passive: true });
  src.addEventListener('touchmove', ev => {
    if (!s) return;
    const dx = ev.touches[0].clientX - s.x, dy = ev.touches[0].clientY - s.y;
    if (!s.on) {
      if (Math.hypot(dx, dy) < 10) return;
      // Only take over when the finger moves mostly along our direction.
      if (axis === 'x' ? Math.abs(dx) < Math.abs(dy) : dy < 0 || Math.abs(dy) < Math.abs(dx)) { s = null; return; }
      s.on = true; el.style.transition = 'none';
    }
    ev.preventDefault(); // stops the page scrolling, and the drag never counts as a tap
    s.d = axis === 'x' ? dx : Math.max(0, dy);
    el.style.transform = axis === 'x' ? `translateX(${s.d}px)` : `translateY(${s.d}px)`;
    if (axis === 'x') el.style.opacity = String(Math.max(0.2, 1 - Math.abs(s.d) / 250));
  }, { passive: false });
  const end = () => {
    if (!s) return;
    const g = s; s = null;
    if (!g.on) return;
    el.style.transition = '';
    const fast = Math.abs(g.d) / Math.max(1, Date.now() - g.t) > 0.6; // a quick flick counts too
    if (Math.abs(g.d) > threshold || (fast && Math.abs(g.d) > 30)) {
      el.style.transform = axis === 'x' ? `translateX(${Math.sign(g.d) * 120}%)` : 'translateY(100%)';
      if (axis === 'x') el.style.opacity = '0';
      setTimeout(() => { done(); el.style.transform = ''; el.style.opacity = ''; }, 180);
    } else { el.style.transform = ''; el.style.opacity = ''; }
  };
  src.addEventListener('touchend', end);
  src.addEventListener('touchcancel', () => { if (s) { s = null; el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; } });
}
swipe($('#toast'), {
  axis: 'x', threshold: 80, done: hideToast,
  start: () => { clearTimeout(toastTimer); return true; },
});
// If a swipe on the toast is let go without dismissing it, give it a few more seconds.
$('#toast').addEventListener('touchend', () => { if (!$('#toast').hidden) toastAutoHide(toastActions.length ? 5000 : 2500); });
swipe($('#app'), {
  axis: 'y', threshold: 90, done: () => { if (S.view === 'activity') history.back(); },
  start: ev => S.view === 'activity' && !S.sheet && window.scrollY <= 0 && !!ev.target.closest('.activity-screen .topbar'),
});

// ---------- Taps ----------
document.addEventListener('click', ev => {
  const t = ev.target.closest('button, [data-edit]');
  if (!t) return;
  const ds = t.dataset;
  const list = all();

  if (ds.toast != null) { hideToast(); return toastActions[+ds.toast]?.fn(); }
  if (ds.setup) return finishSetup(ds.setup);
  if (ds.nav === 'activity') S.af = afDefaults(); // filters start fresh every time
  if (ds.ftype) { const t = S.af.types; S.af.types = t.includes(ds.ftype) ? t.filter(x => x !== ds.ftype) : [...t, ds.ftype]; return render(); }
  if (ds.fall != null) { S.af.types = []; return render(); }
  if (ds.fwhen) { S.af.when = ds.fwhen; return render(); }
  if (ds.fwho) { S.af.who = ds.fwho; return render(); }
  if (ds.forder) { S.af.order = ds.forder; return render(); }
  if (ds.nav) { if (ds.nav !== 'home') history.pushState({ view: ds.nav }, ''); else if (S.view !== 'home') return history.back(); S.view = ds.nav; window.scrollTo(0, 0); return render(); }
  if (ds.edit) {
    const e = list.find(x => x.id === ds.edit);
    if (e?.type === 'pumpsession') return e.end == null ? undefined : openPumpCard(e);
    if (e && L.isBottle(e) && e.end == null) return openSheet('feed', { source: 'breast', picks: [], showNote: null }); // running bottle: its card
    return openEdit(ds.edit);
  }
  if (ds.themePick) { store.set('theme', ds.themePick); applyTheme(); return render(); }
  if (ds.me) { S.me = ds.me; store.set('me', ds.me); return render(); }
  if (ds.contact) { const c = S.contacts.find(x => x.id === ds.contact); return openSheet('contact', { draft: { ...c }, confirmDelete: false }); }

  // Inside sheets
  if (ds.offset != null) {
    if (S.sheet.showNote) S.sheet.note = readNote();
    if (S.sheet.kind === 'sleep') keepSleepInputs();
    if (S.sheet.kind === 'feed') keepFeedInputs();
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
    keepFeedInputs();
    S.sheet[k] = Math.max(0, S.sheet[k] + +d);
    return drawSheet();
  }
  if (ds.color) { S.sheet.color = S.sheet.color === ds.color ? null : ds.color; if (S.sheet.showNote) S.sheet.note = readNote(); return drawSheet(); }
  if (ds.feed) {
    const startAt = sheetStart(), note = readNote(), k = ds.feed;
    const backdated = Date.now() - startAt > L.MIN;
    closeSheet();
    return logEntry({ type: 'feed', kind: k, start: startAt, note }, { toastText: `${side(k)} breast started${backdated ? ` at ${clock(startAt)}` : ''}`, extra: () => [] });
  }
  if (ds.src) { keepFeedInputs(); S.sheet.source = ds.src; return drawSheet(); }
  if (ds.usenow) return askUseNow(ds.usenow);
  if (ds.pick) {
    keepFeedInputs();
    const sh = S.sheet, p = S.milk.find(x => x.id === ds.pick);
    if (!p) return drawSheet();
    if (sh.picks.some(x => x.id === p.id)) sh.picks = sh.picks.filter(x => x.id !== p.id);
    else sh.picks.push({ id: p.id, ml: L.takeFrom(p.left, sh.target, L.pickedMl(sh.picks)) });
    return drawSheet();
  }
  if (ds.bstep) {
    keepFeedInputs();
    const [id, d] = ds.bstep.split(':'), x = S.sheet.picks.find(y => y.id === id), p = S.milk.find(m => m.id === id);
    if (x && p) x.ml = Math.max(1, Math.min(p.left, x.ml + +d));
    return drawSheet();
  }
  if (ds.lstep) { keepFeedInputs(); S.sheet.leftover = Math.max(0, (S.sheet.leftover || 0) + +ds.lstep); return drawSheet(); }
  if (ds.pstep || ds.pplace || ds.pcont || ds.addbag || ds.rmbag || ds.pstore || ds.cstep || ds.cplace || ds.ccont || ds.caddbag || ds.crmbag) {
    const sh = S.sheet; if (sh.showNote) sh.note = readNote();
    if (ds.pstep) {
      const [path, d] = ds.pstep.split(':'), parts = path.split('.');
      let o = sh.sides; for (const k of parts.slice(0, -1)) o = o[k];
      const f = parts.at(-1); o[f] = Math.max(0, (o[f] || 0) + +d);
      if (parts.length === 2 && f === 'ml' && sh.sides[parts[0]].bags.length === 1) sh.sides[parts[0]].bags[0].ml = o[f];
    }
    if (ds.pstore) { const sd = sh.sides[ds.pstore]; sd.open = !sd.open; if (sd.open) sh.combo.open = false; }
    if (ds.cstep) { const [i, d] = ds.cstep.split(':').map(Number); setComboMl(sh, i, Math.max(0, (sh.combo.bags[i].ml || 0) + d)); }
    if (ds.cplace) { const [i, v] = ds.cplace.split(':'); sh.combo.bags[+i].place = v; }
    if (ds.ccont) { const [i, v] = ds.ccont.split(':'); sh.combo.bags[+i].container = v; }
    if (ds.caddbag) { const prev = sh.combo.bags.at(-1); sh.combo.bags.push({ ml: 0, place: prev.place, container: prev.container }); }
    if (ds.crmbag) sh.combo.bags.splice(+ds.crmbag, 1);
    if (ds.pplace) { const [k, i, v] = ds.pplace.split(':'); sh.sides[k].bags[+i].place = v; }
    if (ds.pcont) { const [k, i, v] = ds.pcont.split(':'); sh.sides[k].bags[+i].container = v; }
    if (ds.addbag) {
      const sd = sh.sides[ds.addbag], used = sd.bags.reduce((a, b) => a + (b.ml || 0), 0);
      const prev = sd.bags.at(-1);
      sd.bags.push({ ml: Math.max(0, sd.ml - used), place: prev.place, container: prev.container });
    }
    if (ds.rmbag) {
      const [k, i] = ds.rmbag.split(':'), sd = sh.sides[k];
      sd.bags.splice(+i, 1);
      if (sd.bags.length === 1) sd.bags[0].ml = sd.ml;
    }
    return drawSheet();
  }
  if (ds.milk) { const p = S.milk.find(x => x.id === ds.milk); return p && openSheet('milk', { id: p.id, draft: { ...p }, confirmDiscard: false, showNote: !!p.note, note: p.note || '' }); }
  if (ds.diaper) {
    const startAt = sheetStart(), note = readNote(), color = S.sheet.color;
    closeSheet();
    return logEntry({ type: 'diaper', kind: ds.diaper, start: startAt, color: ds.diaper === 'wet' ? null : color, note }, { toastText: `${{ wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' }[ds.diaper]} diaper saved`, extra: () => [] });
  }
  if (ds.kind) { readEditInputs(); S.sheet.draft.kind = ds.kind; if (L.isBreast(S.sheet.draft) && S.sheet.draft.end === S.sheet.draft.start) S.sheet.draft.end = S.sheet.draft.start + 10 * L.MIN; return drawSheet(); }
  if (ds.dcolor != null) { readEditInputs(); S.sheet.draft.color = ds.dcolor || null; return drawSheet(); }

  switch (ds.act) {
    case 'feed': return openSheet('feed', { source: 'breast', picks: [], bottleOpen: false, showNote: null });
    case 'bottle': keepFeedInputs(); S.sheet.bottleOpen = !S.sheet.bottleOpen; return drawSheet();
    case 'startbottle': return startBottle();
    case 'stopbottle': {
      keepFeedInputs(); const at = Date.now(), id = S.sheet.runningId;
      S.entries = S.entries.map(e => (e.id === id ? { ...e, stoppedAt: at } : e)); // freeze on screen at once
      db.saveEntry(id, { stoppedAt: at }); S.sheet.stopping = true; S.sheet.leftover = 0; buzz(); return drawSheet();
    }
    case 'stopback': {
      keepFeedInputs(); const id = S.sheet.runningId;
      S.entries = S.entries.map(e => (e.id === id ? { ...e, stoppedAt: null } : e));
      db.saveEntry(id, { stoppedAt: null }); S.sheet.stopping = false; return drawSheet();
    }
    case 'savebottle': return saveBottle();
    case 'pump': return pumpTap();
    case 'savepump': return savePump();
    case 'pumpback': return pumpBack();
    case 'combine': {
      const sh = S.sheet; if (sh.showNote) sh.note = readNote();
      sh.combo.open = !sh.combo.open;
      if (sh.combo.open) for (const k of ['left', 'right']) sh.sides[k].open = false;
      return drawSheet();
    }
    case 'discardsession':
      if (!S.sheet.confirmDiscard) { S.sheet.note = readNote(); S.sheet.confirmDiscard = true; return drawSheet(); }
      return discardSession();
    case 'defrost': return defrostMilk();
    case 'mknote': S.sheet.leftVal = $('#mk-left')?.value; S.sheet.showNote = true; drawSheet(); return $('#mk-note')?.focus();
    case 'discard':
      if (!S.sheet.confirmDiscard) {
        if (S.sheet.kind === 'milk') { S.sheet.leftVal = $('#mk-left')?.value; S.sheet.note = $('#mk-note')?.value ?? S.sheet.note; }
        S.sheet.confirmDiscard = true; return drawSheet();
      }
      return discardMilk();
    case 'savemilk': return saveMilkEdit();
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
    case 'filters': S.af.open = !S.af.open; return render();
    case 'fclear': S.af = { ...afDefaults(), open: S.af.open }; return render();
  }
});


// Tapping the dimmed area does nothing, so a mistap can't lose an entry. Swipe down there (or on the handle) to close.

document.addEventListener('input', ev => {
  if (S.sheet?.kind === 'feed' && ev.target.id === 'leftover') {
    const e = all().find(x => x.id === S.sheet.runningId), prepared = e ? e.preparedMl ?? e.ml ?? 0 : 0;
    const r = L.bottleResult(prepared, readLeftover());
    const el = $('#eaten'); if (el) el.innerHTML = `Baby ate <b>${r.ml} ml</b> of ${prepared} ml.${r.leftoverMl !== S.sheet.leftover ? ' (left over can\'t be more than prepared)' : ''}`;
    return;
  }
  const isPin = ev.target.dataset.pin || ev.target.dataset.cin != null;
  if (!S.sheet || S.sheet.kind !== 'pump' || !isPin) return;
  pumpInput(ev.target);
  // Refresh counters, combined bags and the save button without redrawing (keeps the keyboard open).
  const sh = S.sheet;
  for (const k of ['left', 'right']) {
    const el = document.getElementById('cnt-' + k), sd = sh.sides[k];
    if (el) { const l = sd.ml - sd.bags.reduce((a, b) => a + (b.ml || 0), 0); el.textContent = l > 0 ? `${l} ml still to put in a bag` : l < 0 ? `${-l} ml too many` : 'All ml in bags ✓'; el.classList.toggle('off', !!l); }
  }
  sh.combo.bags.forEach((b, i) => {
    const inp = document.querySelector(`[data-cin="${i}"]`); if (inp && inp !== ev.target) inp.value = b.ml;
    const t = document.querySelector(`[data-cml="${i}"]`); if (t) t.textContent = b.ml;
  });
  const problem = pumpProblem(sh), total = pumpTotal(sh), btn = $('[data-act="savepump"]');
  if (btn) { btn.disabled = !!problem || !total; btn.textContent = `Save · ${total} ml`; }
  const pr = $('#pump-problem'); if (pr) pr.textContent = problem || pumpHint(sh, total);
});
// A side's ml going from 0 to more (or back) shows/hides its bags, and a typed combined bag may have been capped:
// redraw when the field is left.
document.addEventListener('change', ev => {
  if (S.sheet?.kind !== 'pump') return;
  if ((ev.target.dataset.pin && S.sheet.needsRedraw) || ev.target.dataset.cin != null || (ev.target.dataset.pin && S.sheet.combo.open)) { if (S.sheet.showNote) S.sheet.note = readNote(); drawSheet(); }
});

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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
  // When a new version has just been installed, reload once so it shows straight away
  // (not only on the next open). Skipped while a card is open, so nothing typed is lost.
  const hadOld = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadOld && !S.sheet) location.reload(); });
}
