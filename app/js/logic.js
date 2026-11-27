// Pure calculations for the "Now" panel and today's totals.
// No Firebase or screen code here, so it can be tested on its own.

export const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

// Feeds that started within this gap of the previous feed's end count as one session
// (e.g. Left then Right straight after). Time since last feed is measured from the session's start.
const SESSION_GAP = 20 * MIN;

export const isBreast = e => e.type === 'feed' && (e.kind === 'left' || e.kind === 'right');
const isBabyFeed = e => e.type === 'feed' && e.kind !== 'pump';

// Newest first, deleted entries removed.
export function visible(entries) {
  return entries.filter(e => !e.deleted).sort((a, b) => b.start - a.start);
}

export function runningFeed(list) {
  return list.find(e => isBreast(e) && e.end == null) || null;
}

// A bottle that was started (timer running) but not yet finished with "Stop bottle feeding".
// Bottles logged before Nov 2026's rework always have an end, so they never count as running.
export const isBottle = e => e.type === 'feed' && e.kind === 'bottle';
export function runningBottle(list) {
  return list.find(e => isBottle(e) && e.end == null) || null;
}

export function runningSleep(list) {
  const last = list.find(e => e.type === 'sleep');
  return last && last.end == null ? last : null;
}

export function nextSide(list) {
  const last = list.find(isBreast);
  return last ? (last.kind === 'left' ? 'right' : 'left') : 'left';
}

export function lastAmount(list, kind, fallback = 60) {
  const last = list.find(e => e.type === 'feed' && e.kind === kind && e.ml > 0);
  return last ? last.ml : fallback;
}

// Starting target for a new bottle: the last bottle's target (or, for older bottles, what it gave).
export function lastTarget(list, fallback = 60) {
  const last = list.find(e => isBottle(e) && (e.targetMl > 0 || e.ml > 0));
  return last ? (last.targetMl > 0 ? last.targetMl : last.ml) : fallback;
}

// The most recent feeding session: its start, the entries in it, and whether it's still going.
export function lastFeedSession(list) {
  const feeds = list.filter(isBabyFeed);
  if (!feeds.length) return null;
  const parts = [feeds[0]];
  for (let i = 1; i < feeds.length; i++) {
    const prev = feeds[i];
    const prevEnd = prev.end ?? prev.start;
    if (parts[parts.length - 1].start - prevEnd <= SESSION_GAP) parts.push(prev);
    else break;
  }
  parts.reverse(); // oldest first
  return { start: parts[0].start, parts, running: parts.some(p => (isBreast(p) || isBottle(p)) && p.end == null) };
}

export function lastDiaper(list) {
  return list.find(e => e.type === 'diaper') || null;
}

// { asleep: bool, since: ms } or null when no sleep has been logged.
export function sleepState(list, now = Date.now()) {
  const last = list.find(e => e.type === 'sleep');
  if (!last) return null;
  if (last.end == null) return { asleep: true, since: last.start };
  return { asleep: false, since: Math.min(last.end, now) };
}

export function startOfDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function todayTotals(list, now = Date.now()) {
  const from = startOfDay(now);
  const t = { feeds: 0, bottleMl: 0, pumpMl: 0, breastMin: 0, wet: 0, dirty: 0, sleepMs: 0 };
  // Count feeding sessions, not individual sides.
  const feeds = list.filter(e => isBabyFeed(e) && e.start >= from).sort((a, b) => a.start - b.start);
  let lastEnd = -Infinity;
  for (const f of feeds) {
    if (f.start - lastEnd > SESSION_GAP) t.feeds++;
    lastEnd = Math.max(lastEnd, f.end ?? f.start);
  }
  for (const e of list) {
    if (e.type === 'feed' && e.start >= from) {
      if (e.kind === 'bottle') t.bottleMl += e.ml || 0;
      if (e.kind === 'pump') t.pumpMl += e.ml || 0; // pumps logged before Pump had its own button
      if (isBreast(e)) t.breastMin += Math.round(((e.end ?? now) - e.start) / MIN);
    }
    if (e.type === 'pump' && e.start >= from) t.pumpMl += e.ml || 0;
    if (e.type === 'diaper' && e.start >= from) {
      if (e.kind === 'wet' || e.kind === 'both') t.wet++;
      if (e.kind === 'dirty' || e.kind === 'both') t.dirty++;
    }
    if (e.type === 'sleep') t.sleepMs += overlap(e.start, e.end ?? now, from, now);
  }
  return t;
}

// ---------- Sleep details ----------
export const SLEEP_TEMP_DEFAULT = 23; // °C, every new sleep starts here
export const SLEEP_FIELDS = ['cover', 'location', 'sound', 'nightLight', 'period', 'tempC'];

// Day is 7 AM to 7 PM by the phone's clock, night is the rest.
export function dayOrNight(t = Date.now()) {
  const h = new Date(t).getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}

// Starting values for a new sleep: cover, place, sound and night light repeat the last sleep
// (most nights look the same), day/night comes from the clock, temperature is always 23 °C.
export function sleepDefaults(list, t = Date.now()) {
  const last = list.find(e => e.type === 'sleep') || {};
  return {
    cover: last.cover ?? null, location: last.location ?? null, sound: last.sound ?? null,
    nightLight: last.nightLight ?? false, period: dayOrNight(t), tempC: SLEEP_TEMP_DEFAULT,
  };
}

// ---------- Pump and milk stock ----------
// A pump session can have a Left and a Right record. Each record's milk is split into one or more
// "portions" (a bag or a bottle), each in one place: room temperature, fridge or freezer.
// Codes: side + number + place letter, e.g. L-004-B. When one place on a side holds two or more
// portions, those get numbers instead (L-004-1, L-004-2). Records made before Nov 2026's rework
// keep their old BPL-/BPR- codes.
export const MILK_RULES = { roomHours: 4, fridgeDays: 4, freezerMonths: 6, thawedHours: 24, defrostHours: 12 };

// A bag moved from the freezer ("Defrost") needs 12 h in the fridge before it's ready. Until then it's
// "defrosting" (grey). "Use now" marks it ready early (readyAt + usedEarly), e.g. after the bottle warmer.
// Its 24 h use-by still counts from when Defrost was pressed.
export function readyAt(p) {
  if (p.place !== 'thawed') return null;
  return p.readyAt ?? (p.thawedAt ?? 0) + MILK_RULES.defrostHours * HOUR;
}
export const isDefrosting = (p, now = Date.now()) => p.place === 'thawed' && now < readyAt(p);
export const PLACE_LETTER = { room: 'A', fridge: 'B', freezer: 'C' };

export function pumpCode(side, seq) {
  return `${side === 'left' ? 'L' : side === 'both' ? 'LR' : 'R'}-${String(seq).padStart(3, '0')}`;
}
export const portionCode = (code, place) => (place === 'freezer' ? `${code}-F` : code); // old style, kept for reference

// Codes for a side's bags, in order. bags: [{ place }]
export function bagCodes(code, bags) {
  const count = {};
  for (const b of bags) count[b.place] = (count[b.place] || 0) + 1;
  let n = 0;
  return bags.map(b => (count[b.place] > 1 ? `${code}-${++n}` : `${code}-${PLACE_LETTER[b.place]}`));
}

// Checks a side of the pump card. Returns null when fine, else a short message.
export function sideProblem(sd) {
  if (!(sd.ml > 0)) return null;
  if (sd.bags.length > 1) {
    const sum = sd.bags.reduce((a, b) => a + (b.ml || 0), 0);
    if (sum !== sd.ml) return sum < sd.ml ? `${sd.ml - sum} ml still to put in a bag` : `${sum - sd.ml} ml too many in the bags`;
    if (sd.bags.some(b => !(b.ml > 0))) return 'Every bag needs some ml';
  }
  return null;
}

// Checks the combined bags (Left + Right together). Returns null when fine, else a short message.
export function comboProblem(bags) {
  if (bags.length > 1 && bags.some(b => !(b.ml > 0))) return 'Every bag needs some ml';
  return null;
}

// The running or stopped-but-unsaved pump session, if any.
export function openPumpSession(list) {
  return list.find(e => e.type === 'pumpsession') || null;
}

// Split a pump's total into the portions to store. freezerMl is clamped to 0..total.
export function splitPortions(total, freezerMl) {
  const fz = Math.max(0, Math.min(total, freezerMl || 0));
  return [['fridge', total - fz], ['freezer', fz]].filter(([, ml]) => ml > 0);
}

// Highest sequence number seen for each side, from pump records we know about.
export function maxSeq(list) {
  const m = { left: 0, right: 0, both: 0 };
  for (const e of list) {
    if (e.type !== 'pump') continue;
    if (e.seq > (m[e.kind] ?? 0)) m[e.kind] = e.seq;
    if (e.lrSeq > m.both) m.both = e.lrSeq; // combined Left + Right bags (LR-007)
  }
  return m;
}

export function lastPump(list) {
  return list.find(e => e.type === 'pump') || null;
}

// When a portion must be used or thrown away.
// Room temperature: 4 h. Fridge: 4 days from pumping. Freezer: 6 months. Thawed: 24 h from thawing.
export function milkExpiry(p) {
  if (p.place === 'room') return p.pumpedAt + MILK_RULES.roomHours * HOUR;
  if (p.place === 'thawed') return (p.thawedAt ?? Date.now()) + MILK_RULES.thawedHours * HOUR;
  if (p.place === 'freezer') {
    const d = new Date(p.pumpedAt);
    d.setMonth(d.getMonth() + MILK_RULES.freezerMonths);
    return d.getTime();
  }
  return p.pumpedAt + MILK_RULES.fridgeDays * DAY;
}

// 'expired', 'soon' (room: under 1 h; fridge: under 1 day; thawed: under 6 h; freezer: under 30 days) or 'ok'.
export function milkFlag(p, now = Date.now()) {
  const left = milkExpiry(p) - now;
  if (left <= 0) return 'expired';
  const soon = { freezer: 30 * DAY, thawed: 6 * HOUR, room: HOUR }[p.place] ?? DAY;
  return left < soon ? 'soon' : 'ok';
}

export const inStock = p => !p.deleted && !p.discarded && (p.left ?? 0) > 0;
// Ready to give now: room temperature, fridge or thawed (not frozen).
export const inFridge = p => p.place === 'fridge' || p.place === 'thawed' || p.place === 'room';

// Oldest pumped first (use the oldest milk first).
export function stockList(portions) {
  return portions.filter(inStock).sort((a, b) => a.pumpedAt - b.pumpedAt || String(a.code).localeCompare(String(b.code)));
}

export function stockTotals(portions, now = Date.now()) {
  const t = { room: 0, fridge: 0, freezer: 0, soon: 0, expired: 0 };
  for (const p of portions) {
    if (!inStock(p)) continue;
    if (p.place === 'room') t.room += p.left; else if (inFridge(p)) t.fridge += p.left; else t.freezer += p.left;
    const f = milkFlag(p, now);
    if (f === 'soon') t.soon++;
    if (f === 'expired') t.expired++;
  }
  return t;
}

// Which portions a bottle uses by default: fridge and thawed milk that hasn't expired,
// whatever expires first, until the bottle's ml are covered. Frozen milk is never picked
// automatically (it needs thawing first), but can be picked by hand.
export function autoPick(portions, ml, now = Date.now()) {
  const ready = portions.filter(p => inStock(p) && inFridge(p) && milkFlag(p, now) !== 'expired')
    .sort((a, b) => milkExpiry(a) - milkExpiry(b) || a.pumpedAt - b.pumpedAt);
  const ids = [];
  let need = ml;
  for (const p of ready) {
    if (need <= 0) break;
    ids.push(p.id);
    need -= p.left;
  }
  return ids;
}

// How many ml to take from each chosen portion, in the order given. Returns
// { uses: [{ id, code, ml }], short } where short is the ml the chosen portions can't cover.
export function planUse(portions, ids, ml) {
  const uses = [];
  let need = ml;
  for (const id of ids) {
    const p = portions.find(x => x.id === id);
    if (!p || need <= 0) continue;
    const take = Math.min(p.left, need);
    if (take > 0) uses.push({ id, code: p.code, ml: take });
    need -= take;
  }
  return { uses, short: Math.max(0, need) };
}

// ---------- Bottle feeding from stock ----------
// Parts of the day, by the phone's clock (Sergio, Nov 2026): Morning 5 AM to 12 PM,
// Afternoon 12 PM to 8 PM, Evening 8 PM to 5 AM. Milk pumped in a part of the day is best
// given in that same part of the day, so the bag list puts those bags first.
export const WINDOWS = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
export function timeWindow(t = Date.now()) {
  const h = new Date(t).getHours();
  return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 20 ? 'afternoon' : 'evening';
}

// Bags for the bottle list, in order: room temperature, fridge and thawed milk (frozen milk needs
// thawing first, so it isn't listed here). Bags pumped in the same part of the day as the feed come
// first, then the rest; inside each group the one that expires first comes first. Expired bags go
// last, marked so the screen can grey them out.
// Bags still defrosting (under 12 h) come after the ready ones, shown but not pickable.
// Returns [{ p, same, expired, defrosting }].
export function bottleStock(portions, feedTime = Date.now(), now = Date.now()) {
  const w = timeWindow(feedTime);
  return portions.filter(p => inStock(p) && inFridge(p))
    .map(p => {
      const expired = milkFlag(p, now) === 'expired';
      return { p, same: timeWindow(p.pumpedAt) === w, expired, defrosting: !expired && isDefrosting(p, now) };
    })
    .sort((a, b) => a.expired - b.expired || a.defrosting - b.defrosting || b.same - a.same || milkExpiry(a.p) - milkExpiry(b.p) || a.p.pumpedAt - b.p.pumpedAt);
}

// Tapping a bag takes only what is still needed to reach the target (at least 1 ml), up to what's in it.
export function takeFrom(left, target, selectedMl) {
  return Math.max(1, Math.min(left, target - selectedMl));
}

export const pickedMl = picks => picks.reduce((a, x) => a + (x.ml || 0), 0);

// Can "Start bottle feeding" be pressed? Breast milk needs the picked bags to cover the target;
// "Other" only needs an amount.
export function canStartBottle(source, target, picks) {
  if (!(target > 0)) return false;
  return source === 'other' || pickedMl(picks) >= target;
}

// What a finished bottle records: prepared = what went into the bottle, eaten = prepared - leftover.
export function bottleResult(preparedMl, leftoverMl) {
  const left = Math.max(0, Math.min(preparedMl, Math.round(leftoverMl || 0)));
  return { leftoverMl: left, ml: preparedMl - left };
}
