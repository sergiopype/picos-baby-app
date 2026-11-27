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
// Simulated finger drag (touchstart → moves → touchend) on the element matching sel.
const drag = (p, sel, dx, dy) => p.evaluate(({ sel, dx, dy }) => {
  const el = document.querySelector(sel), r = el.getBoundingClientRect();
  const x0 = r.left + r.width / 2, y0 = r.top + Math.min(r.height / 2, 10);
  const t = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
  const fire = (type, x, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
    touches: type === 'touchend' ? [] : [t(x, y)], changedTouches: [t(x, y)] }));
  fire('touchstart', x0, y0);
  for (let i = 1; i <= 6; i++) fire('touchmove', x0 + dx * i / 6, y0 + dy * i / 6);
  fire('touchend', x0 + dx, y0 + dy);
}, { sel, dx, dy });
const has = async (p, text, ms = 8000) => { try { await p.getByText(text, { exact: false }).first().waitFor({ timeout: ms }); return true; } catch { return false; } };
// Records live on the Activity screen (📋 in the top bar).
const onAct = p => p.isVisible('.activity-screen');
const toAct = async p => { if (!(await onAct(p))) await p.click('[data-nav="activity"]'); await p.locator('.activity-screen').waitFor(); };
const toHome = async p => { if (await onAct(p)) await p.click('.activity-screen [data-nav="home"]'); await p.locator('.bar').waitFor(); };
const hasRow = async (p, text) => { await toAct(p); const r = await has(p, text); await toHome(p); return r; };

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

// Records are not on the home screen; the 📋 button opens the Activity screen
check(await A.locator('#app .row').count() === 0 && await A.isVisible('.topbar [data-nav="activity"]'), 'Home has no record list, Activity button in the top bar');
await toAct(A); check(await has(A, 'Nothing logged yet'), 'Activity screen opens (empty)');
await drag(A, '.activity-screen .topbar', 0, 200); await sleep(400);
check(await A.isVisible('.bar') && !(await onAct(A)), 'Swiping down on the Activity top bar goes back home');

// A starts left feed (2 taps)
const t0 = Date.now();
await A.click('[data-act="feed"]'); await A.click('[data-feed="left"]');
console.log('     feed start took', Date.now() - t0, 'ms of automation');
check(await has(A, 'Stop feed'), 'A: feed running, button turns into Stop feed');
check(await has(B, 'Stop feed'), 'B: sees the running feed live');
await sleep(1200);
await B.click('[data-act="stopfeed"]');
check(await has(B, 'saved'), 'B: stopped the feed, toast shown');
await drag(B, '#toast', 30, 0); await sleep(300);
check(await B.isVisible('#toast'), 'Toast: a short drag does not dismiss it');
await drag(B, '#toast', 160, 0); await sleep(400);
check(!(await B.isVisible('#toast')), 'Toast: swiping it sideways dismisses it');
check(await has(A, 'next: Right'), 'A: next side now Right');

// Diaper with colour on B
await B.click('[data-act="diaper"]'); await B.click('[data-color="Yellow"]'); await B.click('[data-diaper="dirty"]');
check(await has(A, 'Dirty · Yellow'), 'A: sees B\'s dirty yellow diaper');

// Feed card layout: chips (with 10 min ago), Left/Right, full-width Bottle button
await A.click('[data-act="feed"]');
check(await A.isVisible('[data-offset="10"]:has-text("10 min ago")'), 'Feed card has a "10 min ago" chip');
check(await A.isVisible('.bottle-btn') && await A.locator('[data-act="startbottle"]').count() === 0, 'Bottle is a button; its panel opens on tap');
{ const r = await A.evaluate(() => { const g = s => document.querySelector(s).getBoundingClientRect(); return { ch: g('.choices'), b: g('.bottle-btn') }; });
  check(Math.abs(r.b.width - r.ch.width) < 2 && r.b.top > r.ch.bottom, 'Bottle button is as wide as Left + Right, below them'); }
// "Other" bottle, backdated 30 min: amount only, timer, then stop with 0 left over
await A.click('[data-offset="30"]'); await A.click('.bottle-btn'); await A.click('[data-src="other"]');
check(await A.locator('.milkrow').count() === 0, 'Other hides the stock list');
await A.click('[data-step="target:10"]'); await A.click('[data-step="target:10"]');
check(await A.evaluate(() => document.querySelector('.notebtn').getBoundingClientRect().bottom < document.querySelector('[data-act="startbottle"]').getBoundingClientRect().top), '+ Add a note sits above Start bottle feeding');
await A.click('[data-act="startbottle"]');
check(await A.locator('.act.feed.running:has-text("Stop bottle")').waitFor({ timeout: 8000 }).then(() => true, e => (console.log(e.message.slice(0, 300)), false)), 'Home: Feed button turns into Stop bottle with a timer');
check(await has(B, 'Bottle feeding'), 'B: sees the bottle feeding live');
await A.click('[data-act="feed"]');
check(await A.isVisible('[data-act="stopbottle"]:has-text("Stop bottle feeding")') && await A.isVisible('.bottle-running:has-text("80 ml prepared")'), 'Card shows the running bottle, 80 ml prepared, and Stop bottle feeding');
await A.click('[data-act="stopbottle"]');
check(await A.isVisible('#leftover') && await A.isVisible('[data-act="stopback"]') && await A.isVisible('[data-act="savebottle"]'), 'Stop asks for left over ml with Save and Back');
{ const c1 = await A.textContent('.bottle-running .clock'); await sleep(2200); const c2 = await A.textContent('.bottle-running .clock');
  check(c1 === c2 && await A.isVisible('.bottle-running:has-text("Stopped at")'), `Stop freezes the timer (${c1} → ${c2})`);
  check(await has(B, 'Bottle stopped'), 'B: home shows the bottle as stopped'); }
await A.click('[data-act="stopback"]');
check(await A.isVisible('[data-act="stopbottle"]'), 'Back returns to the running bottle');
{ const c1 = await A.textContent('.bottle-running .clock'); await sleep(2200); const c2 = await A.textContent('.bottle-running .clock');
  check(c1 !== c2, `After Back the timer runs again (${c1} → ${c2})`); }
await A.click('[data-act="stopbottle"]'); await A.click('[data-act="savebottle"]');
check(await hasRow(A, 'Bottle · 80 ml'), 'A: bottle 80 ml saved (default 60 + 20)');
check(await A.isVisible('.act.feed:not(.running)'), 'Feed button back to normal');
await A.click('[data-act="feed"]'); await A.click('.bottle-btn');
check(await A.isVisible('.stepper .val:has-text("80 ml")'), 'Bottle remembers the last target (80 ml)');
{ const r = await A.evaluate(() => { const b = document.querySelector('#sheet').getBoundingClientRect(); return [b.top, b.left, b.width - innerWidth, b.height - innerHeight]; });
  check(r.every(v => Math.abs(v) < 2), `Card: opens as a full page (${r.join(', ')})`); }
check(await A.locator('#sheet .grab, #sheet-backdrop').count() === 0, 'Card: no handle or dimmed area any more');
await drag(A, '#sheet .sheet-title h2', 0, 200); await sleep(400);
check(await A.isVisible('#sheet'), 'Card: dragging down does not close the page');
await A.goBack(); await sleep(300);
check(!(await A.isVisible('#sheet')) && await has(A, 'Last feed'), 'Card: phone back button closes the page and returns home');
await A.click('[data-act="feed"]'); await A.click('#sheet [data-act="close"]'); await sleep(200);
check(!(await A.isVisible('#sheet')) && await has(A, 'Last feed'), 'Card: ✕ closes the page and returns home');

// Sleep: one tap starts the timer and opens the card; details save live; stop inside the card
await A.click('[data-act="sleep"]');
check(await A.isVisible('[data-act="stopsleep"]'), 'Sleep tap starts the timer and opens the card with Woke up · stop');
check(await A.isVisible('text=Baby woke up · stop'), 'Stop button reads "Baby woke up · stop"');
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
check(await hasRow(B, 'Sleeping… · ' + (expected === 'day' ? '☀️' : '🌙') + ' · Crib · Swaddle'), 'B: sleep row shows day/night, place and cover');
await A.screenshot({ path: shots + '/2-home.png' });
// Tapping Woke up on home stops and saves at once, without opening the card
await B.click('[data-act="sleep"]');
check(await has(B, 'Woke up · slept') && await B.locator('#sheet').isHidden(), 'B: Woke up stops the sleep and saves it, no card');
check(await B.isVisible('#toast [data-toast="0"]:has-text("Undo")'), 'B: Undo offered after stopping');
await B.click('#toast [data-toast="0"]');
check(await B.locator('.act.sleep.running').waitFor({ timeout: 8000 }).then(() => true, () => false), 'B: Undo puts the sleep back to running');
await B.click('[data-act="sleep"]');
check(await B.locator('.act.sleep:not(.running)').waitFor({ timeout: 8000 }).then(() => true, () => false) && await B.locator('#sheet').isHidden(), 'B: stopped again, still no card');
check(await hasRow(A, 'Slept '), 'A: sees the finished sleep');
await A.click('[data-act="sleep"]');
check(await A.inputValue('#sl-temp') === '23' && await A.isVisible('.chip.on[data-sl="location:crib"]'), 'Next sleep: temp back to 23 °C, place remembered');
await A.click('[data-act="close"]');
await toAct(A); await A.click('.row:has-text("Slept")'); await A.click('[data-sl="cover:blanket"]'); await A.click('[data-act="saveedit"]');
check(await onAct(A), 'After editing, you are back on the Activity screen');
check(await hasRow(B, '· Crib · Blanket'), 'Editing a sleep changes its details (cover → Blanket)');

// Edit: add a note to the diaper from A, and backdate
await A.click('.row:has-text("Dirty")');
await A.fill('#note', 'seedy, normal');
await A.click('[data-act="saveedit"]');
check(await hasRow(B, 'seedy, normal'), 'B: sees note added on A');

// Delete with undo
await toAct(B);
await A.click('.row:has-text("Bottle")'); await A.click('[data-act="delete"]'); await A.click('[data-act="delete"]');
check(await B.locator('.row:has-text("Bottle · 80 ml")').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false), 'B: deleted bottle disappears');
await A.click('#toast [data-toast="0"]');
check(await has(B, 'Bottle · 80 ml'), 'B: undo brings it back');
await toHome(A); await toHome(B);

// Home is one fixed screen: no scrolling, milk stock line right under the tiles, on both phone sizes
for (const [w, hgt] of [[384, 832], [412, 915]]) {
  await A.setViewportSize({ width: w, height: hgt }); await sleep(200);
  const m = await A.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect();
    window.scrollTo(0, 500); return { y: window.scrollY, tiles: r('.now').bottom, stock: r('.stockline'), bar: r('.bar-inner').top, h: innerHeight }; });
  check(m.y === 0 && m.stock.top > m.tiles && m.stock.top - m.tiles < 20 && m.stock.bottom < m.bar && m.bar < m.h, `Home ${w}x${hgt}: no scroll, stock line under the tiles and above the buttons`);
}
await A.setViewportSize({ width: 384, height: 832 });
await A.click('[data-act="diaper"]');
check(await A.evaluate(() => document.querySelector('[data-diaper="wet"]').getBoundingClientRect().top > document.querySelector('.notebtn').getBoundingClientRect().bottom), 'Diaper card: Wet/Dirty/Both sit below + Add a note');
await A.click('[data-act="close"]');

// Pump and milk stock
const stockText = async p => (await p.textContent('.stockline')).replace(/\s+/g, ' ').trim();
const waitStock = async (p, txt) => { let l = ''; for (let i = 0; i < 25; i++) { l = await stockText(p); if (l.includes(txt)) return l; await sleep(300); } return l; };
check(await A.textContent('.stockline .sl-title') === 'Milk stock' && (await stockText(A)).includes('Empty'), 'Home: milk stock line has its title and shows Empty');
check(await A.locator('.bar-inner .act').count() === 4, 'Home: four big buttons (Feed, Pump, Sleep, Diaper)');
await B.click('[data-act="pump"]');
check(await B.locator('.act.pump.running:has-text("Stop pump")').waitFor({ timeout: 8000 }).then(() => true, () => false) && await B.locator('#sheet').isHidden(), 'First tap on Pump starts the timer without a card');
check(await has(A, 'Stop pump'), 'A: sees the pump session running');
await sleep(1200);
await B.click('[data-act="pump"]');
check(await B.isVisible('#sheet h2:has-text("Pump ·")'), 'Second tap stops it and opens the card with the duration on top');
check(await B.locator('[data-addbag]').count() === 0, 'Sides start at 0 ml (not pumped), no bags shown');
// Left: 80 ml in three bags (two fridge, one freezer)
await B.fill('[data-pin="left.ml"]', '80'); await B.press('[data-pin="left.ml"]', 'Tab');
check(await B.isVisible('[data-pin="left.min"]') && await B.isVisible('[data-pstore="left"]') && await B.locator('[data-pplace]').count() === 0, 'Left with ml shows minutes and a closed Store separately button');
// Save without choosing storage: popup, both sides' Store separately open, nothing saved
await B.fill('[data-pin="right.ml"]', '20'); await B.press('[data-pin="right.ml"]', 'Tab');
await B.click('[data-act="savepump"]');
check(await B.isVisible('.confirm-box:has-text("Choose how to store the milk")') && await B.isVisible('[data-pcont="left:0:bag"].on') && await B.isVisible('[data-pcont="right:0:bag"].on'), 'Save with no storage chosen: popup and both Store separately open');
await B.screenshot({ path: shots + '/8a-pump-popup.png' });
await B.click('[data-cf="ok"]');
check(await B.isVisible('[data-act="savepump"]'), 'Nothing saved, still on the Pump page');
// Combine all closes Store separately; bags always add up to Left + Right
await B.click('[data-act="combine"]');
check(await B.locator('[data-pplace]').count() === 0 && await B.isVisible('[data-cml="0"]:has-text("100")'), 'Combine all closes Store separately, Quantity = 80 + 20 = 100 ml');
await B.click('[data-caddbag]');
await B.fill('[data-cin="1"]', '5'); await B.press('[data-cin="1"]', 'Tab');
check(await B.inputValue('[data-cin="0"]') === '95' && await B.inputValue('[data-cin="1"]') === '5', 'Added bag takes its ml from the first bag (95 + 5)');
await B.click('[data-cplace="1:freezer"]');
await B.evaluate(() => { document.querySelector('[data-act="combine"]').scrollIntoView(); });
await B.screenshot({ path: shots + '/8b-pump-combined.png' });
check(await B.isVisible('.btn-row.end [data-act="close"]:has-text("Cancel")'), 'Cancel next to Save');
await B.click('[data-act="savepump"]');
{ await B.locator('.label-card .code').first().waitFor({ timeout: 8000 });
  const c = await B.locator('.label-card .code').allTextContents();
  check(c.join() === 'LR-001-B,LR-001-C', `Combined bags get LR codes (${c.join(' ')})`); }
// Back: Pump page with everything as entered; Store separately instead; same records, no duplicate stock
await B.click('[data-act="pumpback"]');
check(await B.inputValue('[data-cin="1"]') === '5' && await B.inputValue('[data-pin="left.ml"]') === '80', 'Back reopens the Pump page with the entries kept');
await B.click('[data-pstore="left"]');
check(await B.locator('[data-cin]').count() === 0 && await B.isVisible('[data-pplace="left:0:fridge"]'), 'Store separately closes Combine all');
await B.fill('[data-pin="right.ml"]', '0'); await B.press('[data-pin="right.ml"]', 'Tab');
await B.fill('[data-pin="left.ml"]', '80'); await B.press('[data-pin="left.ml"]', 'Tab');
check(await B.isVisible('[data-pcont="left:0:bag"].on'), 'Left storage open, Bag preselected');
await B.click('[data-pplace="left:0:fridge"]');
await B.click('[data-addbag="left"]');
await B.fill('[data-pin="left.bags.0.ml"]', '40');
check(await B.isVisible('#cnt-left:has-text("40 ml still to put in a bag")') && await B.isDisabled('[data-act="savepump"]'), 'Counter shows ml still to assign, Save waits');
await B.fill('[data-pin="left.bags.1.ml"]', '20');
await B.click('[data-addbag="left"]');
await B.click('[data-pplace="left:2:freezer"]');
check(await B.inputValue('[data-pin="left.bags.2.ml"]') === '20' && await B.isVisible('#cnt-left:has-text("All ml in bags")'), 'New bag gets the ml left over (20)');
// Right: 60 ml at room temperature in a bottle, stopped earlier (18 min)
await B.fill('[data-pin="right.ml"]', '60'); await B.press('[data-pin="right.ml"]', 'Tab');
await B.click('[data-pstore="right"]');
await B.click('[data-pplace="right:0:room"]'); await B.click('[data-pcont="right:0:bottle"]');
await B.fill('[data-pin="right.min"]', '18');
await B.screenshot({ path: shots + '/8-pump-card.png', fullPage: false });
await B.click('[data-act="savepump"]');
const codesOf = async p => { await p.locator('.label-card .code').first().waitFor({ timeout: 8000 }); return p.locator('.label-card .code').allTextContents(); };
const saved = await codesOf(B);
check(saved.join() === 'L-001-1,L-001-2,L-001-C,R-001-A', `Codes: two fridge bags numbered, freezer and room keep letters (${saved.join(' ')})`);
check(await B.isVisible('.label-card.room:has-text("Room temp · Bottle · 60 ml")'), 'Saved card shows place, container and ml');
await B.screenshot({ path: shots + '/9-pump-saved.png' });
await B.click('[data-act="close"]');
await toAct(A);
check(await has(A, 'Pumped Right · 60 ml') && await has(A, '· R-001'), 'A: sees both sides saved as their own records');
check(await A.locator('.row:has-text("Pumping")').count() === 0, 'Session row gone once saved');
await toHome(A); check(await A.isVisible('.act.pump:not(.running)'), 'Pump button back to normal');
// Both phones finish the same session at once: numbers must not clash
await A.click('[data-act="pump"]'); await sleep(300); await A.click('[data-act="pump"]');
await B.locator('.act.pump:has-text("Finish pump")').waitFor({ timeout: 8000 }); await B.click('[data-act="pump"]');
for (const P of [A, B]) { await P.fill('[data-pin="left.ml"]', '50'); await P.press('[data-pin="left.ml"]', 'Tab'); await P.click('[data-pstore="left"]'); await P.click('[data-pplace="left:0:fridge"]'); }
await Promise.all([A.click('[data-act="savepump"]'), B.click('[data-act="savepump"]')]);
const ca = (await codesOf(A))[0], cb = (await codesOf(B))[0];
check(ca !== cb && [ca, cb].sort().join() === 'L-002-B,L-003-B', `Two phones saving at once get different numbers (${ca}, ${cb})`);
await A.click('[data-act="close"]'); await B.click('[data-act="close"]');
let line = await waitStock(A, 'Fridge 160 ml');
check(line.includes('Room 60 ml') && line.includes('Fridge 160 ml') && line.includes('Freezer 20 ml'), `Stock line totals room, fridge and freezer (${line})`);
{ const m = await A.evaluate(() => { const r = document.querySelector('.stockline .sl-row'), t = document.querySelector('.stockline .sl-title');
    return { h: r.getBoundingClientRect().height, over: r.scrollWidth > r.clientWidth + 1, title: t.getBoundingClientRect().bottom <= r.getBoundingClientRect().top + 1 }; });
  check(m.h < 48 && !m.over && m.title, `Stock line: title on top, amounts side by side, nothing cut off (${JSON.stringify(m)})`); }
await A.screenshot({ path: shots + '/15-home-stock.png' });
// Closing the card without saving keeps the session
await A.click('[data-act="pump"]'); await sleep(300); await A.click('[data-act="pump"]'); await A.click('[data-act="close"]');
check(await A.isVisible('.act.pump:has-text("Finish pump")'), 'Closing the card unsaved leaves "Finish pump"');
await A.click('[data-act="pump"]');
check(await A.isVisible('[data-act="savepump"]'), 'Finish pump reopens the card');
await A.click('[data-act="discardsession"]'); await A.click('[data-act="discardsession"]');
check(await A.locator('.act.pump:not(.running)').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Discard session clears it');
// Bottle from stock: pick bags until the target is covered, timer, leftover, eaten
await A.click('[data-act="feed"]'); await A.click('.bottle-btn');
const order = await A.locator('.milkpick .code').allTextContents();
check(order[0] === 'R-001-A' && !order.includes('L-001-C'), `Bags listed with the soonest to expire first, no frozen bags (${order.join(' ')})`);
check(await A.isVisible('.section-label:has-text("use first")'), 'Bags from this part of the day are grouped first');
check(await A.isDisabled('[data-act="startbottle"]') && await A.isVisible('#bottle-count:has-text("0 of 80 ml")'), 'Start waits until bags are picked');
await A.click('[data-pick]:has-text("R-001-A")');
check(await A.isVisible('#bottle-count:has-text("60 of 80 ml")') && await A.isDisabled('[data-act="startbottle"]'), 'Picking a 60 ml bag: 60 of 80 ml, still not enough');
await A.click('[data-pick]:has-text("L-001-1")');
check(await A.isVisible('.milkpick.on:has-text("L-001-1") .take-in:has-text("20 ml")') && await A.isVisible('#bottle-count:has-text("80 of 80 ml")') && await A.isEnabled('[data-act="startbottle"]'), 'Second bag takes only the 20 ml still needed; Start is enabled');
const l1 = await A.getAttribute('[data-pick]:has-text("L-001-1")', 'data-pick');
await A.click(`[data-bstep="${l1}:-5"]`);
check(await A.isVisible('#bottle-count:has-text("75 of 80 ml")') && await A.isDisabled('[data-act="startbottle"]'), 'Taking 5 ml less from a bag disables Start again');
await A.click(`[data-bstep="${l1}:5"]`);
await A.screenshot({ path: shots + '/10-bottle-from-stock.png' });
await A.click('[data-act="startbottle"]');
line = await waitStock(B, 'Fridge 140 ml'); check(!line.includes('Room') && line.includes('Fridge 140 ml'), `B: stock drops when the bottle starts (${line})`);
await A.click('#toast [data-toast="0"]'); // undo
line = await waitStock(B, 'Room 60 ml'); check(line.includes('Room 60 ml') && line.includes('Fridge 160 ml'), 'Undo puts the milk back');
// 30 ml from one fridge bag; part of the bag stays in stock
await A.click('[data-act="feed"]'); await A.click('.bottle-btn');
for (let i = 0; i < 5; i++) await A.click('[data-step="target:-10"]'); // 80 → 30 ml
await A.click('[data-pick]:has-text("L-001-1")');
await A.click('[data-act="shownote"]'); await A.fill('#note', 'sleepy');
await A.click('[data-act="startbottle"]');
line = await waitStock(B, 'Fridge 130 ml'); check(line.includes('Fridge 130 ml'), 'Only the 30 ml taken leaves stock');
await A.click('.act.feed.running');
await A.click('[data-act="stopbottle"]'); await A.fill('#leftover', '10');
check(await A.isVisible('#eaten:has-text("Baby ate 20 ml")'), 'Leftover 10 of 30: shows baby ate 20 ml');
await A.screenshot({ path: shots + '/13-bottle-stop.png' });
await A.click('[data-act="savebottle"]');
check(await hasRow(B, 'Bottle · 20 ml (10 left over)') && await hasRow(B, 'sleepy'), 'B: bottle row shows eaten, left over, and the note');
await toAct(A); await A.click('.row:has-text("10 left over")');
check(await A.inputValue('#ed-leftover') === '10' && await A.isVisible('#ed-end'), 'Edit shows the left over and end time');
await A.click('[data-act="close"]'); await toHome(A);
await A.click('[data-act="feed"]'); await A.click('.bottle-btn'); await A.click('[data-src="other"]');
check(await A.locator('.milkrow').count() === 0 && await A.isEnabled('[data-act="startbottle"]'), 'Other: no stock list, Start works with just the amount');
await A.click('[data-act="close"]');
// Activity filters
await toAct(A);
const rowCount = () => A.locator('.activity-screen .row').count();
const total = await rowCount();
check(total > 5 && await A.locator('.fdot').count() === 0, `Activity lists every record (${total}), no filter dot`);
await A.click('[data-act="filters"]'); await A.click('[data-ftype="diaper"]');
const diaperOnly = await A.locator('.activity-screen .row .ic').allTextContents();
check(diaperOnly.length > 0 && diaperOnly.every(t => t === '🧷'), `Type filter shows only diapers (${diaperOnly.length})`);
check(await A.isVisible('.fdot') && await A.isVisible('[data-act="fclear"]'), 'Filter on: dot and Clear show');
await A.click('[data-ftype="sleep"]');
const twoTypes = await A.locator('.activity-screen .row .ic').allTextContents();
check(twoTypes.some(t => t === '😴') && twoTypes.every(t => t === '🧷' || t === '😴'), 'Two types at once');
await A.click('[data-fall]'); await A.click('[data-fwho="Ana Rita"]');
const tags = await A.locator('.activity-screen .row .who').allTextContents();
check(await rowCount() > 0 && await rowCount() < total && tags.every(t => t === 'AR'), 'Logged-by filter shows only Ana Rita\'s records');
await A.click('[data-fwho="any"]');
const firstNew = await A.locator('.activity-screen .row .time').first().textContent();
await A.click('[data-forder="old"]');
const firstOld = await A.locator('.activity-screen .row .time').first().textContent();
check(firstNew !== firstOld || total < 2, `Oldest first flips the order (${firstNew} → ${firstOld})`);
await A.screenshot({ path: shots + '/12-activity-filters.png' });
await A.click('[data-act="fclear"]');
check(await rowCount() === total && await A.locator('.fdot').count() === 0, 'Clear brings everything back');
await A.click('[data-ftype="feed"]'); await toHome(A); await toAct(A);
check(await rowCount() === total && await A.locator('.fdot').count() === 0 && !(await A.isVisible('.filters')), 'Filters reset when Activity is opened again');
await toHome(A);

// Milk stock screen: thaw and discard
await A.click('.stockline');
check(await has(A, 'Milk stock') && await A.isVisible('.day:has-text("Room temp")') && await A.isVisible('.milkrow:has-text("L-001-C")'), 'Stock screen lists bags by place');
await A.screenshot({ path: shots + '/11-stock.png' });
await A.click('.milkrow:has-text("L-001-C")');
{ const order = await A.evaluate(() => ['.mk-place', '.mk-pumped', '.mk-side', '.expiry', '#mk-left', '.notebtn', '[data-act="defrost"]', '[data-act="discard"]']
    .map(s => document.querySelector('#sheet ' + s)?.getBoundingClientRect().top ?? -1));
  check(order.every((y, i) => y > 0 && (i === 0 || y >= order[i - 1])), `Bag card order: place, pumped, side, expiry, milk left, + Add note, Defrost, Discard/Save (${order.map(Math.round).join(' ')})`); }
check(await A.isVisible('.mk-place:has-text("🧊 Freezer (use within 6 months)")') && await A.isVisible('.expiry:has-text("Expiry:")'), 'Card shows 🧊 Freezer (use within 6 months) and Expiry:');
await A.click('[data-act="mknote"]'); check(await A.isVisible('#mk-note'), '+ Add note opens the note box');
await A.screenshot({ path: shots + '/14-bag-card.png' });
await A.click('[data-act="defrost"]');
check(await A.locator('.milkrow.defrosting:has-text("L-001-C"):has-text("Defrosted"):has-text("ready in")').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Defrosted bag moves to the fridge list, grey with "ready in"');
await A.goBack(); await has(A, 'Last feed');
await A.click('[data-act="feed"]'); await A.click('.bottle-btn');
check(await A.isVisible('.section-label:has-text("Defrosting")') && await A.locator('[data-pick]:has-text("L-001-C")').count() === 0 && await A.isVisible('[data-usenow]:has-text("L-001-C")'), 'Bottle list shows the defrosting bag, not pickable');
await A.click('[data-usenow]:has-text("L-001-C")');
check(await A.isVisible('.confirm-box:has-text("before the 12 h defrost")'), 'Tapping it asks to use it before the 12 h');
await A.click('[data-cf="no"]');
check(await A.locator('.confirm').count() === 0 && await A.locator('[data-pick]:has-text("L-001-C")').count() === 0, 'Cancel leaves it defrosting');
await A.click('[data-act="close"]');
await A.click('.stockline'); await A.click('.milkrow:has-text("L-001-C")');
check(await A.isVisible('.defrost-state.defrosting') && await A.isVisible('[data-usenow]:has-text("Use now")'), 'A grey bag still opens, with a Use now button');
await A.click('[data-usenow]'); await A.click('[data-cf="yes"]');
check(await A.isVisible('.defrost-state.defrosted:has-text("used before the 12 h")'), 'Use now marks it ready (used early)');
await A.click('[data-act="close"]');
check(await A.locator('.milkrow.defrosted:has-text("L-001-C")').waitFor({ timeout: 8000 }).then(() => true, () => false), 'Ready defrosted bag turns light blue in the list');
await A.screenshot({ path: shots + '/11-stock.png' });
await A.click('.milkrow:has-text("R-001-A")'); await A.click('[data-act="discard"]'); await A.click('[data-act="discard"]');
check(await A.locator('.milkrow:has-text("R-001-A")').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false), 'Discarded bag leaves the stock');
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
await B.goBack(); await has(B, 'Last feed'); await toAct(B); // B watches the list during the offline test
const wetRows = p => p.locator('.row .what').filter({ hasText: /^Wet(?! \+)/ }).count();
const bWetBefore = await wetRows(B); console.log('     B wet rows before:', bWetBefore);
await ctxA.setOffline(true);
await A.click('[data-act="diaper"]'); await A.click('[data-diaper="wet"]');
check(await has(A, 'waiting to sync'), 'A offline: shows "waiting to sync"');
await A.reload();
check(await has(A, 'Pico'), 'A offline: app reopens');
check(await hasRow(A, 'Wet'), 'A offline: app reopens from the phone with the unsent entry');
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
