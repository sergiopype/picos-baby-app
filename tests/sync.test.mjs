// Two simulated phones against the local Firestore emulator.
// Run: emulator + `node scripts/serve.mjs` must be running, then `node tests/sync.test.mjs`
import { chromium } from 'playwright';
const BASE = 'http://localhost:5173/synctest.html?emu=1&fid=';
const fid = 'test' + Math.random().toString(36).slice(2) + 'xxxxxxxxxxxxxxxx';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
async function waitFor(page, fn, arg, ms = 15000) {
  try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; } catch { return false; }
}
const ids = page => page.evaluate(() => window.state.list.filter(e => !e.deleted).map(e => e.id).sort());

const browser = await chromium.launch();
const ctxA = await browser.newContext(), ctxB = await browser.newContext();
let A = await ctxA.newPage(); const B = await ctxB.newPage();
for (const p of [A, B]) p.on('pageerror', e => console.log('pageerror', e.message));
await A.goto(BASE + fid); await B.goto(BASE + fid);
await sleep(1500);

// 1. Live sync both ways
await A.evaluate(() => db.saveEntry('e1', { type: 'feed', kind: 'left', start: Date.now(), end: null, by: 'Sergio' }));
check(await waitFor(B, () => window.state.list.some(e => e.id === 'e1')), 'B sees entry logged on A (live)');
await B.evaluate(() => db.saveEntry('e1', { end: Date.now() }));
check(await waitFor(A, () => window.state.list.find(e => e.id === 'e1')?.end > 0), 'A sees B stopping the feed');

// 2. A goes offline, logs entries, then the app is closed while still offline
await ctxA.setOffline(true); await sleep(500);
for (const id of ['off1', 'off2', 'off3'])
  await A.evaluate(id => db.saveEntry(id, { type: 'diaper', kind: 'wet', start: Date.now(), by: 'Sergio' }), id);
check(await waitFor(A, () => ['off1','off2','off3'].every(id => window.state.list.some(e => e.id === id)), null, 1000), 'A shows offline entries within 1 second');
check(await waitFor(A, () => window.state.pending.size === 3, null, 1000), 'A marks 3 entries as waiting to sync');
await B.evaluate(() => { db.saveEntry('onB1', { type: 'sleep', start: Date.now(), end: null, by: 'Ana Rita' }); db.saveEntry('onB2', { type: 'diaper', kind: 'dirty', start: Date.now(), by: 'Ana Rita' }); });
await sleep(1500);
check(!(await A.evaluate(() => window.state.list.some(e => e.id === 'onB1'))), 'A (offline) does not see B yet, as expected');
await A.close();               // app closed with unsent entries
await ctxA.setOffline(false);   // signal comes back
A = await ctxA.newPage(); A.on('pageerror', e => console.log('pageerror', e.message));
await A.goto(BASE + fid);       // app reopened
check(await waitFor(B, () => ['off1','off2','off3'].every(id => window.state.list.some(e => e.id === id))), 'B receives the 3 entries A logged offline, after A restarted');
check(await waitFor(A, () => ['onB1','onB2'].every(id => window.state.list.some(e => e.id === id))), 'A catches up on B\'s entries');
check(await waitFor(A, () => window.state.pending.size === 0), 'A has nothing left waiting to sync');

// 3. Both offline, edit different fields of the same entry
await ctxA.setOffline(true); await ctxB.setOffline(true); await sleep(500);
await A.evaluate(() => db.saveEntry('onB1', { note: 'fussy before sleep' }));
await B.evaluate(() => db.saveEntry('onB1', { end: Date.now() }));
await ctxA.setOffline(false); await ctxB.setOffline(false);
check(await waitFor(A, () => { const e = window.state.list.find(e => e.id === 'onB1'); return e?.note && e?.end; }), 'Offline edits from both phones to one entry are both kept (A)');
check(await waitFor(B, () => { const e = window.state.list.find(e => e.id === 'onB1'); return e?.note && e?.end; }), 'Offline edits from both phones to one entry are both kept (B)');

// 4. Delete syncs, duplicates impossible
await A.evaluate(() => db.saveEntry('off2', { deleted: true }));
check(await waitFor(B, () => window.state.list.find(e => e.id === 'off2')?.deleted === true), 'Delete on A reaches B');
await A.evaluate(() => db.saveEntry('off1', { note: 'retry' })); await A.evaluate(() => db.saveEntry('off1', { note: 'retry' }));
await sleep(1500);
const a = await ids(A), b = await ids(B);
check(JSON.stringify(a) === JSON.stringify(b), `Both phones hold the same entries (${a.length})`);
check(new Set(a).size === a.length, 'No duplicates');

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL SYNC TESTS PASSED');
process.exit(fails ? 1 : 0);
