// Pure calculations for bottle feeding (no browser or database needed): node tests/logic.test.mjs
import * as L from '../app/js/logic.js';
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
const at = (h, m = 0, dayOffset = 0) => { const d = new Date(2026, 10, 26 + dayOffset, h, m); return d.getTime(); };

// Parts of the day: Morning 5-12, Afternoon 12-20, Evening 20-5
check(L.timeWindow(at(4, 59)) === 'evening' && L.timeWindow(at(5)) === 'morning' && L.timeWindow(at(11, 59)) === 'morning', 'Morning starts at 5 AM, ends at noon');
check(L.timeWindow(at(12)) === 'afternoon' && L.timeWindow(at(19, 59)) === 'afternoon' && L.timeWindow(at(20)) === 'evening' && L.timeWindow(at(0, 30)) === 'evening', 'Afternoon 12 to 8 PM, Evening 8 PM to 5 AM');

// Bag order for a 9 AM feed
const now = at(9);
const bag = (id, pumpedAt, place = 'fridge', left = 50) => ({ id, code: id, place, pumpedAt, ml: 50, left, deleted: false, discarded: false });
const portions = [
  bag('eve-old', at(21, 0, -2)),       // evening, expires soonest of the fridge bags
  bag('morn-new', at(8, 0)),           // morning, today
  bag('morn-old', at(7, 0, -1)),       // morning, yesterday: expires before morn-new
  bag('aft', at(14, 0, -1)),
  bag('expired', at(8, 0, -5)),        // fridge > 4 days: expired
  bag('frozen', at(8, 0, -1), 'freezer'),
  bag('empty', at(8, 0), 'fridge', 0),
  bag('room', at(7, 30), 'room'),      // room temp, morning, 4 h: expires 11:30
];
const order = L.bottleStock(portions, now, now).map(x => x.p.id);
check(order.join() === 'room,morn-old,morn-new,eve-old,aft,expired', `Same part of day first, then soonest expiry; expired last; no frozen or empty bags (${order.join(' ')})`);
const rows = L.bottleStock(portions, now, now);
check(rows.find(x => x.p.id === 'expired').expired && !rows.find(x => x.p.id === 'room').expired, 'Expired bag is flagged');
check(rows.filter(x => x.same && !x.expired).map(x => x.p.id).join() === 'room,morn-old,morn-new', 'Same-window flag marks the morning bags');
check(L.bottleStock(portions, at(21), now)[0].p.id === 'eve-old', 'An evening feed puts evening milk first');

// Defrosting: grey for 12 h after Defrost, then ready; Use now makes it ready early
const thawing = { ...bag('thaw', at(8, 0, -1), 'thawed'), thawedAt: now - 3 * 3600e3 };
const ready = { ...bag('thawready', at(8, 0, -1), 'thawed'), thawedAt: now - 13 * 3600e3 };
const early = { ...thawing, id: 'early', readyAt: now - 60e3, usedEarly: true };
check(L.isDefrosting(thawing, now) && !L.isDefrosting(ready, now) && !L.isDefrosting(early, now), 'Defrosted bag is not ready until 12 h, unless Use now was pressed');
check(L.readyAt(thawing) === thawing.thawedAt + 12 * 3600e3 && L.milkExpiry(thawing) === thawing.thawedAt + 24 * 3600e3, 'Ready 12 h after Defrost, use-by still 24 h after Defrost');
const bs = L.bottleStock([thawing, ready, bag('f', at(8, 0, -1))], now, now);
check(bs.at(-1).p.id === 'thaw' && bs.at(-1).defrosting && !bs[0].defrosting, 'Bottle list shows defrosting bags after the ready ones');

// Taking from bags
check(L.takeFrom(50, 60, 0) === 50 && L.takeFrom(50, 60, 50) === 10 && L.takeFrom(50, 60, 60) === 1, 'A tapped bag takes only what is still needed (at least 1 ml)');
check(!L.canStartBottle('breast', 60, [{ ml: 50 }]) && L.canStartBottle('breast', 60, [{ ml: 50 }, { ml: 10 }]) && L.canStartBottle('breast', 60, [{ ml: 70 }]), 'Start needs the picked ml to cover the target');
check(L.canStartBottle('other', 60, []) && !L.canStartBottle('other', 0, []), 'Other only needs an amount');
const r = L.bottleResult(80, 15);
check(r.ml === 65 && r.leftoverMl === 15 && L.bottleResult(80, 200).ml === 0 && L.bottleResult(80, -3).leftoverMl === 0, 'Eaten = prepared - leftover, leftover kept between 0 and prepared');

// Running bottle and old bottles
const list = [{ type: 'feed', kind: 'bottle', start: now, end: null, preparedMl: 60, ml: 60 }, { type: 'feed', kind: 'bottle', start: now - 3600e3, end: now - 3600e3, ml: 90 }];
check(L.runningBottle(list) === list[0] && L.runningBottle(list.slice(1)) === null, 'A bottle without an end is running; old bottles never are');
check(L.lastTarget([{ type: 'feed', kind: 'bottle', targetMl: 70, ml: 55 }]) === 70 && L.lastTarget([{ type: 'feed', kind: 'bottle', ml: 90 }]) === 90 && L.lastTarget([]) === 60, 'Target starts at the last target (old bottles: their ml)');
check(L.lastFeedSession(list).running, 'A running bottle counts as feeding now');

// Combined Left + Right bags
check(L.pumpCode('both', 7) === 'LR-007' && L.bagCodes('LR-007', [{ place: 'fridge' }, { place: 'freezer' }]).join() === 'LR-007-B,LR-007-C', 'Combined bags get LR codes');
check(L.comboProblem([{ ml: 50 }]) === null && L.comboProblem([{ ml: 45 }, { ml: 5 }]) === null && !!L.comboProblem([{ ml: 50 }, { ml: 0 }]), 'Every combined bag needs some ml');
check(L.maxSeq([{ type: 'pump', kind: 'left', seq: 4 }, { type: 'pump', kind: 'left', lrSeq: 3, combined: true }]).both === 3, 'LR numbers counted on their own');

console.log(fails ? `\n${fails} FAILED` : '\nALL LOGIC TESTS PASSED'); process.exit(fails ? 1 : 0);
