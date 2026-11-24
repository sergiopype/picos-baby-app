// Tests the Notion copy job against the local database and a fake Notion server.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';

const SCHEMA = { // property names and options from Sergio's Notion databases
  '420f1d38-5f63-8105-9508-000ba7459a77': { Entry: 0, Time: 0, Type: ['Breast L', 'Breast R', 'Bottle', 'Pump'], 'Duration (min)': 0, 'Amount (ml)': 0, 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0,
    Source: ['Breast milk', 'Formula'], 'Milk used': 0 },
  '422f1d38-5f63-8111-bcef-000b1d389622': { Code: 0, Time: 0, Side: ['Left', 'Right'], 'Amount (ml)': 0, 'Fridge (ml)': 0, 'Freezer (ml)': 0, 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0 },
  '422f1d38-5f63-81a2-95af-000b2ddeb25b': { Code: 0, Side: ['Left', 'Right'], Place: ['Fridge', 'Freezer', 'Thawed'], Status: ['In stock', 'Used', 'Discarded'],
    Pumped: 0, Expires: 0, 'Amount (ml)': 0, 'Left (ml)': 0, 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0 },
  '420f1d38-5f63-8145-a838-000b54a1d810': { Entry: 0, Time: 0, Kind: ['Wet', 'Dirty', 'Both'], Color: ['Yellow', 'Green', 'Brown', 'Black', 'Red', 'White'], 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0 },
  '420f1d38-5f63-814a-ab7b-000b67b7af62': { Entry: 0, Start: 0, End: 0, 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0,
    'Day/Night': ['Day', 'Night'], Cover: ['Swaddle', 'Sleeping bag', 'Blanket'], Location: ['Bedside bassinet', 'Crib', 'Cot', 'Other'],
    Sound: ['Silence', 'White noise', 'Music'], 'Night light': 0, 'Room temp (°C)': 0 },
  '420f1d38-5f63-81c8-acd7-000b249f81a9': { Name: 0, Role: ['Pediatrician', 'Hospital', 'Emergency', 'Nurse line', 'Pharmacy', 'Family', 'Babysitter', 'Other'], Phone: 0, Email: 0, 'When to call': 0, Notes: 0 },
};
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
const pages = {}; let n = 0; const problems = [];
function validate(ds, props) {
  const sch = SCHEMA[ds];
  for (const [k, v] of Object.entries(props)) {
    if (!(k in sch)) problems.push(`unknown property ${k}`);
    else if (Array.isArray(sch[k]) && v.select && !sch[k].includes(v.select.name)) problems.push(`bad option ${k}=${v.select.name}`);
  }
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const b = JSON.parse(body || '{}');
    if (req.headers['notion-version'] !== '2025-09-03' || !req.headers.authorization) problems.push('bad headers');
    if (req.method === 'POST' && req.url === '/v1/pages') {
      validate(b.parent.data_source_id, b.properties);
      const id = 'page' + (++n); pages[id] = { ds: b.parent.data_source_id, props: b.properties, trash: false };
      res.end(JSON.stringify({ id }));
    } else if (req.method === 'PATCH') {
      const id = req.url.split('/').pop(); const p = pages[id];
      if (b.properties) { validate(p.ds, b.properties); p.props = b.properties; }
      if ('in_trash' in b) p.trash = b.in_trash;
      res.end(JSON.stringify({ id }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
}).listen(5999);

const app = initializeApp({ projectId: 'demo-picos', apiKey: 'demo' });
const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
const FAMILY = 'notiontest' + Date.now() + 'xxxxxxxxxx';
const put = (c, id, f) => setDoc(doc(db, 'families', FAMILY, c, id), { ...f, syncedAt: serverTimestamp() }, { merge: true });
const now = Date.now();
await put('entries', 'f1', { type: 'feed', kind: 'left', start: now - 30 * 60e3, end: now - 15 * 60e3, by: 'Sergio', note: 'good latch' });
await put('entries', 'f2', { type: 'feed', kind: 'bottle', start: now - 10 * 60e3, end: now - 10 * 60e3, ml: 90, by: 'Ana Rita',
  source: 'breast', uses: [{ id: 'm1', code: 'BPL-001', ml: 50 }, { id: 'm2', code: 'BPL-001-F', ml: 40 }] });
await put('entries', 'p1', { type: 'pump', kind: 'left', start: now - 2 * 3600e3, end: now - 2 * 3600e3, ml: 100, code: 'BPL-001', seq: 1,
  fridgeMl: 50, freezerMl: 50, portions: ['m1', 'm2'], by: 'Ana Rita', note: 'evening' });
await put('milk', 'm1', { code: 'BPL-001', side: 'left', place: 'fridge', ml: 50, left: 50, pumpedAt: now - 2 * 3600e3, by: 'Ana Rita', deleted: false, discarded: false });
await put('milk', 'm2', { code: 'BPL-001-F', side: 'left', place: 'freezer', ml: 50, left: 50, pumpedAt: now - 2 * 3600e3, by: 'Ana Rita', deleted: false, discarded: false });
await put('entries', 'f3', { type: 'feed', kind: 'right', start: now - 60e3, end: null, by: 'Sergio' }); // running
await put('entries', 'd1', { type: 'diaper', kind: 'both', color: 'Yellow', start: now, end: now, by: 'Ana Rita' });
await put('entries', 's1', { type: 'sleep', start: now - 3 * 3600e3, end: now - 3600e3, by: 'Sergio' }); // old style, no details
await put('entries', 's2', { type: 'sleep', start: now - 5 * 3600e3, end: now - 4 * 3600e3, by: 'Ana Rita',
  period: 'night', cover: 'sleeping_bag', location: 'bassinet', sound: 'white_noise', nightLight: true, tempC: 22.5 });
await put('contacts', 'c1', { name: 'Dr. Silva', role: 'Pediatrician', phone: '+1 555 0100', email: 'dr@example.com', when: 'Fever over 38' });

const run = async () => (await promisify(execFile)('node', ['notion-sync/sync.mjs'], { env: { ...process.env, FIREBASE_PROJECT_ID: 'demo-picos', FAMILY_ID: FAMILY,
  NOTION_TOKEN: 'secret_test', FIRESTORE_BASE: 'http://127.0.0.1:8080', NOTION_BASE: 'http://127.0.0.1:5999' } })).stdout;

console.log((await run()).trim().replace(/^/gm, '     '));
check(Object.keys(pages).length === 9, `First run creates 9 Notion pages (got ${Object.keys(pages).length}); running feed skipped`);
const pp = Object.values(pages).find(p => p.ds.startsWith('422f1d38-5f63-8111'))?.props;
check(pp?.Code.title[0].text.content === 'BPL-001' && pp.Side.select.name === 'Left' && pp['Fridge (ml)'].number === 50 && pp['Freezer (ml)'].number === 50, 'Pump goes to Pumps with code, side and split');
const mk = c => Object.values(pages).find(p => p.props.Code?.title[0].text.content === c && p.props.Place);
check(mk('BPL-001')?.props.Status.select.name === 'In stock' && mk('BPL-001-F')?.props.Place.select.name === 'Freezer', 'Milk portions go to Milk Stock (fridge + freezer -F)');
const exp = new Date(mk('BPL-001').props.Expires.date.start).getTime() - (now - 2 * 3600e3);
check(Math.abs(exp - 4 * 86400e3) < 1000, 'Fridge portion expires 4 days after pumping');
const bt = Object.values(pages).find(p => p.props.Type?.select?.name === 'Bottle')?.props;
check(bt?.Source.select.name === 'Breast milk' && bt['Milk used'].rich_text[0].text.content === 'BPL-001 (50 ml), BPL-001-F (40 ml)', 'Bottle shows source and milk used');
const f1 = Object.values(pages).find(p => p.props.Entry.title[0].text.content.startsWith('Left'));
check(f1?.props['Duration (min)'].number === 15 && f1.props.Type.select.name === 'Breast L', 'Breast feed has type Breast L and 15 min');
check((await getDoc(doc(db, 'families', FAMILY, 'entries', 'f1'))).data().notionId, 'Notion page ID written back to the entry');
const s2 = Object.values(pages).find(p => p.props.Cover?.select?.name === 'Sleeping bag')?.props;
check(s2 && s2['Day/Night'].select.name === 'Night' && s2.Location.select.name === 'Bedside bassinet' && s2.Sound.select.name === 'White noise'
  && s2['Night light'].checkbox === true && s2['Room temp (°C)'].number === 22.5, 'Sleep details reach Notion (night, sleeping bag, bassinet, white noise, light on, 22.5 °C)');
const s1 = Object.values(pages).find(p => p.props.Start && !p.props.Cover?.select)?.props;
check(s1 && s1['Day/Night'].select === null && s1['Room temp (°C)'].number === null, 'Older sleeps without details still copy (empty fields)');

console.log((await run()).trim().replace(/^/gm, '     '));
check(Object.keys(pages).length === 9, 'Second run with no changes creates nothing new');

await put('entries', 'f3', { end: now + 9 * 60e3 });   // feed stopped
await put('entries', 'f2', { ml: 120 });              // edited
await put('entries', 'd1', { deleted: true });        // deleted
await put('milk', 'm1', { left: 0 });                 // used up
await put('milk', 'm2', { place: 'thawed', thawedAt: now }); // thawed
console.log((await run()).trim().replace(/^/gm, '     '));
check(Object.keys(pages).length === 10, 'Stopped feed gets copied');
check(mk('BPL-001').props.Status.select.name === 'Used' && mk('BPL-001-F').props.Place.select.name === 'Thawed', 'Used-up and thawed portions update in Notion');
check(Object.values(pages).find(p => p.props.Type?.select?.name === 'Bottle')?.props['Amount (ml)'].number === 120, 'Edit updates the same Notion page (90 → 120 ml)');
check(Object.values(pages).find(p => p.props.Kind)?.trash === true, 'Deleted diaper moves to Notion trash');
check(problems.length === 0, 'Every property and option matches the real Notion databases' + (problems.length ? ': ' + problems.join('; ') : ''));
server.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL NOTION TESTS PASSED'); process.exit(fails ? 1 : 0);
