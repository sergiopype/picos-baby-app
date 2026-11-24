// End-to-end test of the real app on two simulated Android phones (local emulator).
import { chromium, devices } from 'playwright';
const URL0 = 'http://localhost:5173/?emu=1';
const shots = process.env.SHOTS || '/tmp/shots';
import fs from 'node:fs'; fs.mkdirSync(shots, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
const phone = { ...devices['Galaxy S9+'], viewport: { width: 384, height: 832 }, deviceScaleFactor: 2, colorScheme: 'dark' };
const browser = await chromium.launch();
const ctxA = await browser.newContext(phone), ctxB = await browser.newContext(phone);
await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5173' });
const A = await ctxA.newPage(), B = await ctxB.newPage();
for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', e => { console.log(n, 'pageerror', e.message); fails++; });
const has = async (p, text, ms = 8000) => { try { await p.getByText(text, { exact: false }).first().waitFor({ timeout: ms }); return true; } catch { return false; } };

// Setup on A
await A.goto(URL0);
await A.fill('#su-name', 'Pico'); await A.fill('#su-birth', '2026-11-01');
await A.click('[data-setup="Sergio"]');
check(await has(A, 'Pico'), 'A: setup done, home shows baby name');
await A.screenshot({ path: shots + '/1-empty.png' });

// Invite link → B
await A.click('[data-nav="settings"]');
const link = (await A.textContent('#invite')).trim();
check(link.includes('#join='), 'Settings shows an invite link');
await A.click('[data-nav="home"]');
await B.goto(link.replace('?', '') .replace('localhost:5173/', 'localhost:5173/?emu=1'));
check(await has(B, 'Join the baby log'), 'B: join screen');
await B.click('[data-setup="Ana Rita"]');
check(await has(B, 'Pico'), 'B: joined and sees baby name from A');

// A starts left feed (2 taps)
const t0 = Date.now();
await A.click('[data-act="feed"]'); await A.click('[data-feed="left"]');
console.log('     feed start took', Date.now() - t0, 'ms of automation');
check(await has(A, 'Stop feed'), 'A: feed running, button turns into Stop feed');
check(await has(B, 'Stop feed'), 'B: sees the running feed live');
await sleep(1200);
await B.click('[data-act="stopfeed"]');
check(await has(B, 'saved'), 'B: stopped the feed, toast shown');
check(await has(A, 'next: Right'), 'A: next side now Right');

// Diaper with colour on B
await B.click('[data-act="diaper"]'); await B.click('[data-color="Yellow"]'); await B.click('[data-diaper="dirty"]');
check(await has(A, 'Dirty · Yellow'), 'A: sees B\'s dirty yellow diaper');

// Bottle with stepper, backdated 30 min
await A.click('[data-act="feed"]'); await A.click('[data-offset="30"]'); await A.click('[data-step="bottle:10"]'); await A.click('[data-step="bottle:10"]');
await A.click('[data-feed="bottle"]');
check(await has(A, 'Bottle · 80 ml'), 'A: bottle 80 ml logged (default 60 + 20)');
await A.click('[data-act="feed"]');
check(await A.isVisible('text=Log bottle · 80 ml'), 'Bottle remembers last amount (80 ml)');
await A.click('[data-act="close"]');

// Sleep: one tap starts the timer and opens the card; details save live; stop inside the card
await A.click('[data-act="sleep"]');
check(await A.isVisible('[data-act="stopsleep"]'), 'Sleep tap starts the timer and opens the card with Woke up · stop');
check(await A.locator('[data-act="startsleep"]').count() === 0, 'No separate Start step in the card');
check(await has(B, 'Woke up'), 'B: sees baby asleep right after the tap');
check(await A.inputValue('#sl-temp') === '23', 'Room temperature starts at 23 °C');
const h = new Date().getHours(), expected = h >= 7 && h < 19 ? 'day' : 'night';
check(await A.isVisible(`.dn.on[data-sl="period:${expected}"]`), `Day/Night preselected from the clock (${expected})`);
await A.click('[data-sl="cover:sleeping_bag"]'); await A.click('[data-sl="location:crib"]'); await A.click('[data-sl="sound:white_noise"]');
await A.check('#sl-light'); await A.fill('#sl-temp', '22.5');
await A.click('[data-sl="cover:swaddle"]'); // one choice only: switches from sleeping bag
check(await A.inputValue('#sl-temp') === '22.5', 'Typed temperature survives a tap on another option');
check(await A.locator('[data-sl^="cover:"].on').count() === 1, 'Cover allows one choice only');
await A.screenshot({ path: shots + '/2-sleep-card.png' });
await A.click('[data-act="close"]'); // closing keeps it counting and saves the typed temperature
check(await A.isVisible('.act.sleep.running'), 'Closing the card keeps the sleep running');
check(await has(B, 'Sleeping… · ' + (expected === 'day' ? '☀️' : '🌙') + ' · Crib · Swaddle'), 'B: sleep row shows day/night, place and cover');
await B.click('[data-act="sleep"]');
check(await B.isVisible('[data-act="stopsleep"]'), 'B: card shows Woke up · stop while asleep');
let seen = false; for (let i = 0; i < 20 && !seen; i++) { seen = await B.inputValue('#sl-temp') === '22.5' && await B.isChecked('#sl-light'); if (!seen) { await B.click('[data-act="close"]'); await sleep(400); await B.click('[data-act="sleep"]'); } }
check(seen, 'B: card shows the details A picked');
await B.click('[data-sl="sound:music"]');
await B.click('[data-act="close"]');
await A.click('[data-act="sleep"]');
check(await A.locator('.chip.on[data-sl="sound:music"]').waitFor({ timeout: 8000 }).then(() => true, () => false), 'A: sees sound changed on B while asleep');
await A.click('[data-act="close"]');
await A.screenshot({ path: shots + '/2-home.png' });
await B.click('[data-act="sleep"]'); await B.click('[data-act="stopsleep"]');
check(await has(B, 'Woke up · slept'), 'B: stopping from the card saves the sleep');
check(await has(A, 'Slept '), 'A: sees the finished sleep');
await A.click('[data-act="sleep"]');
check(await A.inputValue('#sl-temp') === '23' && await A.isVisible('.chip.on[data-sl="location:crib"]'), 'Next sleep: temp back to 23 °C, place remembered');
await A.click('[data-act="close"]');
await A.click('.row:has-text("Slept")'); await A.click('[data-sl="cover:blanket"]'); await A.click('[data-act="saveedit"]');
check(await has(B, '· Crib · Blanket'), 'Editing a sleep changes its details (cover → Blanket)');

// Edit: add a note to the diaper from A, and backdate
await A.click('.row:has-text("Dirty")');
await A.fill('#note', 'seedy, normal');
await A.click('[data-act="saveedit"]');
check(await has(B, 'seedy, normal'), 'B: sees note added on A');

// Delete with undo
await A.click('.row:has-text("Bottle")'); await A.click('[data-act="delete"]'); await A.click('[data-act="delete"]');
check(await B.locator('.row:has-text("Bottle · 80 ml")').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false), 'B: deleted bottle disappears');
await A.click('#toast [data-toast="0"]');
check(await has(B, 'Bottle · 80 ml'), 'B: undo brings it back');

// Pump and milk stock
const stockText = async p => (await p.textContent('.stockline')).replace(/\s+/g, ' ').trim();
check((await stockText(A)).includes('empty'), 'Home: milk stock line shows empty');
check(await A.locator('.bar-inner .act').count() === 4, 'Home: four big buttons (Feed, Pump, Sleep, Diaper)');
await B.click('[data-act="pump"]');
check(await B.isVisible('.big-choice.suggested[data-pside="left"]'), 'Pump card opens with Left picked');
await B.click('[data-store="split"]');
for (let i = 0; i < 4; i++) await B.click('[data-step="ml:5"]');
await B.screenshot({ path: shots + '/8-pump-card.png' });
await B.click('[data-act="savepump"]');
check(await B.locator('.label-card .code', { hasText: 'BPL-001-F' }).waitFor({ timeout: 8000 }).then(() => true, () => false)
  && await B.isVisible('.label-card.fridge:has-text("BPL-001")'), 'Saved pump shows bag codes BPL-001 (fridge) and BPL-001-F (freezer)');
check(await B.isVisible('.label-card.fridge:has-text("50 ml")') && await B.isVisible('.label-card.freezer:has-text("30 ml")'), '80 ml split into fridge 50 ml and freezer 30 ml');
await B.screenshot({ path: shots + '/9-pump-saved.png' });
await B.click('[data-act="switchbreast"]');
check(await B.isVisible('.big-choice.suggested[data-pside="right"]'), 'Switch breast opens the card on Right');
await B.click('[data-store="fridge"]');
await B.click('[data-act="savepump"]');
check(await B.locator('.label-card .code', { hasText: 'BPR-001' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'Right breast gets its own numbering: BPR-001');
await B.click('[data-act="close"]');
check(await has(A, 'Pumped Right · 80 ml · BPR-001'), 'A: sees the pump records in the timeline');
// Both phones pump Left at the same moment: numbers must not clash
await A.click('[data-act="pump"]'); await A.click('[data-pside="left"]'); await A.click('[data-store="fridge"]');
await B.click('[data-act="pump"]'); await B.click('[data-pside="left"]'); await B.click('[data-store="fridge"]');
await Promise.all([A.click('[data-act="savepump"]'), B.click('[data-act="savepump"]')]);
await A.locator('.label-card .code').first().waitFor(); await B.locator('.label-card .code').first().waitFor();
const ca = await A.textContent('.label-card .code'), cb = await B.textContent('.label-card .code');
check(ca !== cb && [ca, cb].sort().join() === 'BPL-002,BPL-003', `Two phones saving at once get different codes (${ca}, ${cb})`);
await A.click('[data-act="close"]'); await B.click('[data-act="close"]');
let line = ''; for (let i = 0; i < 20; i++) { line = await stockText(A); if (line.includes('Fridge 290 ml')) break; await sleep(300); }
check(line.includes('Fridge 290 ml') && line.includes('Freezer 30 ml'), `Stock line totals fridge and freezer (${line})`);
// Bottle from stock: oldest fridge bag preselected, partial use
await A.click('[data-act="feed"]');
check(await A.isVisible('.milkrow.on:has-text("BPL-001")'), 'Bottle preselects the oldest fridge bag (BPL-001)');
check(await A.locator('.milkrow:has-text("BPL-001-F")').count() === 0, 'Frozen bags are hidden until asked for');
await A.screenshot({ path: shots + '/10-bottle-from-stock.png' });
for (let i = 0; i < 5; i++) await A.click('[data-step="bottle:-10"]'); // 80 → 30 ml
await A.click('[data-feed="bottle"]');
check(await has(A, 'Bottle · 30 ml · BPL-001'), 'Bottle row shows which bag it came from');
line = ''; for (let i = 0; i < 20; i++) { line = await stockText(B); if (line.includes('Fridge 260 ml')) break; await sleep(300); }
check(line.includes('Fridge 260 ml'), 'B: stock drops by 30 ml');
await A.click('#toast [data-toast="0"]'); // undo
line = ''; for (let i = 0; i < 20; i++) { line = await stockText(B); if (line.includes('Fridge 290 ml')) break; await sleep(300); }
check(line.includes('Fridge 290 ml'), 'Undo puts the milk back');
await A.click('[data-act="feed"]'); await A.click('[data-src="formula"]');
check(await A.locator('.milkrow').count() === 0 && await A.isVisible('text=Log bottle · 80 ml formula'), 'Formula option hides the stock');
await A.click('[data-act="close"]');
// Milk stock screen: thaw and discard
await A.click('.stockline');
check(await has(A, 'Milk stock') && await A.isVisible('.milkrow:has-text("BPL-001-F")'), 'Stock screen lists bags');
const codes = await A.locator('.milkrow .code').allTextContents();
check(codes.slice(0, 4).join() === 'BPL-001,BPR-001,BPL-002,BPL-003' || codes.slice(0, 4).join() === 'BPL-001,BPR-001,BPL-003,BPL-002', `Fridge list is oldest first (${codes.join(' ')})`);
await A.screenshot({ path: shots + '/11-stock.png' });
await A.click('.milkrow:has-text("BPL-001-F")'); await A.click('[data-act="thaw"]');
check(await A.locator('.milkrow:has-text("BPL-001-F"):has-text("Thawed")').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Thawed bag moves to the fridge list');
check(await A.isVisible('.milkrow:has-text("BPL-001-F"):has-text("use within 24 h")'), 'Thawed bag must be used within 24 h');
await A.click('.milkrow:has-text("BPR-001")'); await A.click('[data-act="discard"]'); await A.click('[data-act="discard"]');
check(await A.locator('.milkrow:has-text("BPR-001")').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false), 'Discarded bag leaves the stock');
await A.goBack(); await has(A, 'Last feed');

// Contacts
await B.click('[data-nav="contacts"]'); await B.click('[data-act="addcontact"]');
await B.fill('#c-name', 'Dr. Test'); await B.fill('#c-phone', '+1 555 0100'); await B.fill('#c-when', 'Fever over 38 °C');
await B.click('[data-act="savecontact"]');
check(await B.locator('a[href="tel:+15550100"]').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Contact has tap-to-call link');
await A.click('[data-nav="contacts"]');
check(await has(A, 'Dr. Test'), 'A: sees contact added on B');
await A.screenshot({ path: shots + '/3-contacts.png' });
await A.goBack(); // Android back
check(await has(A, 'Last feed'), 'Back button returns home');

// Offline: A loses signal, logs a diaper, closes app, reopens offline
await sleep(1500); // let the service worker cache files
const wetRows = p => p.locator('.row .what').filter({ hasText: /^Wet(?! \+)/ }).count();
await B.goBack(); await has(B, 'Last feed');
const bWetBefore = await wetRows(B); console.log('     B wet rows before:', bWetBefore);
await ctxA.setOffline(true);
await A.click('[data-act="diaper"]'); await A.click('[data-diaper="wet"]');
check(await has(A, 'waiting to sync'), 'A offline: shows "waiting to sync"');
await A.reload();
check(await has(A, 'Pico') && await has(A, 'Wet'), 'A offline: app reopens from the phone with the unsent entry');
await sleep(2000); check(await wetRows(B) === bWetBefore, 'B: has not got it yet (A offline)');
await ctxA.setOffline(false);
let got = false; for (let i = 0; i < 30 && !got; i++) { got = (await wetRows(B)) === bWetBefore + 1; if (!got) await sleep(500); }
check(got, 'B: receives it once A is back online');
check(await has(A, 'Synced', 15000), 'A: back to Synced');
await A.screenshot({ path: shots + '/4-after-offline.png' });

// Sheets screenshots
await A.click('[data-act="feed"]'); await A.screenshot({ path: shots + '/5-feed-sheet.png' }); await A.click('[data-act="close"]');
await A.click('[data-act="diaper"]'); await A.screenshot({ path: shots + '/6-diaper-sheet.png' }); await A.click('[data-act="close"]');
await ctxA.close(); await ctxB.close();
// light-mode shot
const ctxL = await browser.newContext({ ...phone, colorScheme: 'light' }); const P = await ctxL.newPage();
await P.goto(link.replace('localhost:5173/', 'localhost:5173/?emu=1')); await P.click('[data-setup="Sergio"]'); await has(P, 'Last feed'); await sleep(1500);
await P.screenshot({ path: shots + '/7-light.png' });
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL APP TESTS PASSED'); process.exit(fails ? 1 : 0);
