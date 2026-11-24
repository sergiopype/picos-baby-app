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
  return { start: parts[0].start, parts, running: parts.some(p => isBreast(p) && p.end == null) };
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
      if (e.kind === 'pump') t.pumpMl += e.ml || 0;
      if (isBreast(e)) t.breastMin += Math.round(((e.end ?? now) - e.start) / MIN);
    }
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
