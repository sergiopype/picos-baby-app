// Copies new and changed entries from the app's database into Notion.
// Runs every hour on GitHub (see .github/workflows/notion-sync.yml). No packages needed.
//
// How it stays correct:
// - Every app write stamps "syncedAt" with the server's clock. This job remembers the last
//   syncedAt it copied (families/<id>/meta/notion) and only asks for newer changes.
// - When it creates a Notion page it writes the page ID back onto the entry, so later edits
//   update that same page and deletes move it to Notion's trash. Running it twice is harmless.
// - Feeds and sleeps that are still running are skipped; they're copied once stopped.

const env = k => { const v = process.env[k]; if (!v) throw new Error(`Missing setting ${k}`); return v; };
const PROJECT = env('FIREBASE_PROJECT_ID');
const API_KEY = process.env.FIREBASE_API_KEY || '';
const FAMILY = env('FAMILY_ID');
const NOTION_TOKEN = env('NOTION_TOKEN');
const FS = (process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com') + `/v1/projects/${PROJECT}/databases/(default)/documents`;
const NOTION = process.env.NOTION_BASE || 'https://api.notion.com';

// Notion data sources inside the "Picos Baby App" page.
const DS = {
  feed: '420f1d38-5f63-8105-9508-000ba7459a77',
  diaper: '420f1d38-5f63-8145-a838-000b54a1d810',
  sleep: '420f1d38-5f63-814a-ab7b-000b67b7af62',
  contact: '420f1d38-5f63-81c8-acd7-000b249f81a9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = API_KEY ? `key=${API_KEY}` : '';
const base = `${FS}/families/${FAMILY}`;

// ---------- Firestore REST helpers ----------
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  return null;
}
const fromDoc = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)]));

async function fs(method, path, body) {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}${key}`;
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`Firestore ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function changedSince(collectionId, cursor) {
  const where = cursor ? { fieldFilter: { field: { fieldPath: 'syncedAt' }, op: 'GREATER_THAN', value: { timestampValue: cursor } } } : undefined;
  const res = await fs('POST', ':runQuery', { structuredQuery: {
    from: [{ collectionId }], ...(where && { where }), orderBy: [{ field: { fieldPath: 'syncedAt' }, direction: 'ASCENDING' }], limit: 500,
  } });
  return res.filter(x => x.document).map(x => ({ ...fromDoc(x.document), id: x.document.name.split('/').pop() }));
}

const setField = (path, field, value) =>
  fs('PATCH', `${path}?updateMask.fieldPaths=${field}`, { fields: { [field]: { stringValue: value } } });

// ---------- Notion helpers ----------
async function notion(method, path, body, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(NOTION + path, { method, body: JSON.stringify(body), headers: {
      authorization: `Bearer ${NOTION_TOKEN}`, 'notion-version': '2025-09-03', 'content-type': 'application/json' } });
    if (r.ok) { await sleep(350); return r.json(); } // Notion allows ~3 requests a second
    if ((r.status === 429 || r.status >= 500) && i < tries) { await sleep(1000 * 2 ** i); continue; }
    throw new Error(`Notion ${method} ${path}: ${r.status} ${await r.text()}`);
  }
}

const txt = s => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 2000) } }] : [] });
const title = s => ({ title: [{ text: { content: s } }] });
const sel = s => ({ select: s ? { name: s } : null });
const num = n => ({ number: n ?? null });
const date = ms => ({ date: ms ? { start: new Date(ms).toISOString() } : null });
const who = by => sel(by === 'Sergio' || by === 'Ana Rita' ? by : null);
const mins = e => Math.round((e.end - e.start) / 60000);
const fmtDur = m => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);

function entryToNotion(e) {
  if (e.type === 'feed') {
    const breast = e.kind === 'left' || e.kind === 'right';
    const type = { left: 'Breast L', right: 'Breast R', bottle: 'Bottle', pump: 'Pump' }[e.kind];
    const name = breast ? `${e.kind === 'left' ? 'Left' : 'Right'} breast · ${fmtDur(mins(e))}` : `${e.kind === 'bottle' ? 'Bottle' : 'Pumped'} · ${e.ml || 0} ml`;
    return { ds: DS.feed, props: { Entry: title(name), Time: date(e.start), Type: sel(type),
      'Duration (min)': num(breast ? mins(e) : null), 'Amount (ml)': num(breast ? null : e.ml), 'Logged by': who(e.by), Notes: txt(e.note) } };
  }
  if (e.type === 'diaper') {
    const kind = { wet: 'Wet', dirty: 'Dirty', both: 'Both' }[e.kind];
    return { ds: DS.diaper, props: { Entry: title(`${kind}${e.color ? ` · ${e.color}` : ''}`), Time: date(e.start), Kind: sel(kind),
      Color: sel(e.color), 'Logged by': who(e.by), Notes: txt(e.note) } };
  }
  return { ds: DS.sleep, props: { Entry: title(`Sleep · ${fmtDur(mins(e))}`), Start: date(e.start), End: date(e.end),
    'Logged by': who(e.by), Notes: txt(e.note) } };
}

function contactToNotion(c) {
  return { ds: DS.contact, props: { Name: title(c.name || 'Unnamed'), Role: sel(c.role), Phone: { phone_number: c.phone || null },
    Email: { email: c.email || null }, 'When to call': txt(c.when), Notes: txt(c.note) } };
}

// ---------- One collection ----------
async function syncCollection(collectionId, toNotion, isReady, state) {
  const cursorField = `${collectionId}Cursor`;
  const items = await changedSince(collectionId, state[cursorField]);
  let done = 0, skipped = 0;
  for (const it of items) {
    if (it.deleted) {
      if (it.notionId) await notion('PATCH', `/v1/pages/${it.notionId}`, { in_trash: true });
    } else if (!isReady(it)) {
      skipped++;
    } else {
      const { ds, props } = toNotion(it);
      if (it.notionId) {
        await notion('PATCH', `/v1/pages/${it.notionId}`, { properties: props, in_trash: false });
      } else {
        const page = await notion('POST', '/v1/pages', { parent: { type: 'data_source_id', data_source_id: ds }, properties: props });
        await setField(`/${collectionId}/${it.id}`, 'notionId', page.id);
      }
      done++;
    }
    // Move the cursor after each item, so a crash halfway never skips anything.
    state[cursorField] = it.syncedAt;
    await setField('/meta/notion', cursorField, it.syncedAt);
  }
  console.log(`${collectionId}: ${done} copied, ${skipped} still running, ${items.length - done - skipped} deletions`);
}

const state = await fs('GET', '/meta/notion').then(fromDoc).catch(() => ({}));
const hasTimer = e => e.type === 'sleep' || (e.type === 'feed' && (e.kind === 'left' || e.kind === 'right'));
const entryReady = e => typeof e.start === 'number' && (!hasTimer(e) || e.end != null);
await syncCollection('entries', entryToNotion, entryReady, state);
await syncCollection('contacts', contactToNotion, c => !!c.name, state);
console.log('Notion copy up to date.');
