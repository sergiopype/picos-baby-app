// Tests the Notion copy job against the local database and a fake Notion server.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';

const SCHEMA = { // property names and options from Sergio's Notion databases
  '420f1d38-5f63-8105-9508-000ba7459a77': { Entry: 0, Time: 0, Type: ['Breast L', 'Breast R', 'Bottle', 'Pump'], 'Duration (min)': 0, 'Amount (ml)': 0, 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0 },
  '420f1d38-5f63-8145-a838-000b54a1d810': { Entry: 0, Time: 0, Kind: ['Wet', 'Dirty', 'Both'], Color: ['Yellow', 'Green', 'Brown', 'Black', 'Red', 'White'], 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0 },
  '420f1d38-5f63-814a-ab7b-000b67b7af62': { Entry: 0, Start: 0, End: 0, 'Logged by': ['Sergio', 'Ana Rita'], Notes: 0 },
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
await put('entries', 'f2', { type: 'feed', kind: 'bottle', start: now - 10 * 60e3, end: now - 10 * 60e3, ml: 90, by: 'Ana Rita' });
await put('entries', 'f3', { type: 'feed', kind: 'right', start: now - 60e3, end: null, by: 'Sergio' }); // running
await put('entries', 'd1', { type: 'diaper', kind: 'both', color: 'Yellow', start: now, end: now, by: 'Ana Rita' });
await put('entries', 's1', { type: 'sleep', start: now - 3 * 3600e3, end: now - 3600e3, by: 'Sergio' });
await put('contacts', 'c1', { name: 'Dr. Silva', role: 'Pediatrician', phone: '+1 555 0100', email: 'dr@example.com', when: 'Fever over 38' });

const run = async () => (await promisify(execFile)('node', ['notion-sync/sync.mjs'], { env: { ...process.env, FIREBASE_PROJECT_ID: 'demo-picos', FAMILY_ID: FAMILY,
  NOTION_TOKEN: 'secret_test', FIRESTORE_BASE: 'http://127.0.0.1:8080', NOTION_BASE: 'http://127.0.0.1:5999' } })).stdout;

console.log((await run()).trim().replace(/^/gm, '     '));
check(Object.keys(pages).length === 5, `First run creates 5 Notion pages (got ${Object.keys(pages).length}); running feed skipped`);
const f1 = Object.values(pages).find(p => p.props.Entry.title[0].text.content.startsWith('Left'));
check(f1?.props['Duration (min)'].number === 15 && f1.props.Type.select.name === 'Breast L', 'Breast feed has type Breast L and 15 min');
check((await getDoc(doc(db, 'families', FAMILY, 'entries', 'f1'))).data().notionId, 'Notion page ID written back to the entry');

console.log((await run()).trim().replace(/^/gm, '     '));
check(Object.keys(pages).length === 5, 'Second run with no changes creates nothing new');

await put('entries', 'f3', { end: now + 9 * 60e3 });   // feed stopped
await put('entries', 'f2', { ml: 120 });              // edited
await put('entries', 'd1', { deleted: true });        // deleted
console.log((await run()).trim().replace(/^/gm, '     '));
check(Object.keys(pages).length === 6, 'Stopped feed gets copied');
check(Object.values(pages).find(p => p.props.Type?.select?.name === 'Bottle')?.props['Amount (ml)'].number === 120, 'Edit updates the same Notion page (90 → 120 ml)');
check(Object.values(pages).find(p => p.props.Kind)?.trash === true, 'Deleted diaper moves to Notion trash');
check(problems.length === 0, 'Every property and option matches the real Notion databases' + (problems.length ? ': ' + problems.join('; ') : ''));
server.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL NOTION TESTS PASSED'); process.exit(fails ? 1 : 0);
