// Everything that talks to the Firebase database lives here.
//
// How "never lose an entry" works:
// - Every write goes to a database on the phone first (IndexedDB), then to the cloud when there's signal.
// - Writes are never awaited, so the app never hangs offline. Pending writes survive closing the app.
// - Each entry has its own random ID made on the phone, so a retry can't create a duplicate.
// - Edits only send the fields that changed, so two phones editing different fields both win.
// - Deleting only marks an entry as deleted, so the other phone and Notion hear about it.

import {
  initializeApp, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, doc, collection, setDoc, onSnapshot, query, where, getDocs, serverTimestamp,
  runTransaction, increment,
} from '../vendor/firebase.js';
import { firebaseConfig } from '../config.js';

let db = null;
let fid = null;

export function usingEmulator() {
  return new URLSearchParams(location.search).has('emu') || firebaseConfig.projectId.startsWith('REPLACE');
}

export function connect(familyId) {
  fid = familyId;
  if (db) return;
  const emu = usingEmulator();
  const app = initializeApp(emu ? { projectId: 'demo-picos', apiKey: 'demo' } : firebaseConfig);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  if (emu) connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const col = name => collection(db, 'families', fid, name);

export function newId() {
  return doc(col('entries')).id;
}

export function newFamilyId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function write(name, id, fields) {
  const data = { ...fields, updatedAt: Date.now(), syncedAt: serverTimestamp() };
  // Not awaited on purpose: the promise only settles once the cloud confirms.
  setDoc(doc(col(name), id), data, { merge: true }).catch(err => console.error('write failed', err));
}

export const saveEntry = (id, fields) => write('entries', id, fields);
export const saveContact = (id, fields) => write('contacts', id, fields);
export const saveBaby = fields => write('meta', 'baby', fields);
export const saveMilk = (id, fields) => write('milk', id, fields);
export const newMilkId = () => doc(col('milk')).id;

// Take ml out of (negative) or put ml back into (positive) a milk portion.
// "increment" adds on the server, so two phones using the same portion never overwrite each other.
export function adjustMilk(id, deltaMl) {
  write('milk', id, { left: increment(deltaMl) });
}

// Next number for a pump code (BPL-001, BPL-002, … per side).
// Online: a transaction on families/<id>/meta/milk, so two phones logging at once can't get the same number.
// Offline (or no answer within 4 s): the highest number this phone knows + 1, which can only clash if
// both phones log the same breast while one of them has no signal.
export async function nextPumpSeq(side, known = 0) {
  const ref = doc(col('meta'), 'milk');
  const field = side === 'left' ? 'L' : 'R';
  const local = () => Math.max(known, lastCounter[field] || 0) + 1;
  if (!navigator.onLine) return { seq: local(), offline: true };
  const tx = runTransaction(db, async t => {
    const snap = await t.get(ref);
    const seq = Math.max(known, (snap.exists() && snap.data()[field]) || 0) + 1;
    t.set(ref, { [field]: seq }, { merge: true });
    return seq;
  });
  const timeout = new Promise(r => setTimeout(() => r(null), 4000));
  const seq = await Promise.race([tx.catch(() => null), timeout]);
  return seq ? { seq, offline: false } : { seq: local(), offline: true };
}
let lastCounter = {};
export function watchMilkCounter() {
  return onSnapshot(doc(col('meta'), 'milk'), snap => { lastCounter = snap.exists() ? snap.data() : {}; });
}

// Every portion that still has milk in it (used-up ones drop out; discarded ones are filtered in the app).
export function watchMilk(cb) {
  return onSnapshot(query(col('milk'), where('left', '>', 0)), { includeMetadataChanges: true }, snap => cb(toList(snap)));
}

function toList(snap) {
  const pending = new Set();
  const list = snap.docs.map(d => {
    if (d.metadata.hasPendingWrites) pending.add(d.id);
    return { ...d.data(), id: d.id };
  });
  return { list, pending, fromCache: snap.metadata.fromCache };
}

export function watchEntries(sinceMs, cb) {
  return onSnapshot(query(col('entries'), where('start', '>=', sinceMs)),
    { includeMetadataChanges: true }, snap => cb(toList(snap)));
}

export async function loadEntries(fromMs, toMs) {
  const snap = await getDocs(query(col('entries'), where('start', '>=', fromMs), where('start', '<', toMs)));
  return toList(snap).list;
}

export function watchContacts(cb) {
  return onSnapshot(col('contacts'), { includeMetadataChanges: true }, snap => cb(toList(snap)));
}

export function watchBaby(cb) {
  return onSnapshot(doc(col('meta'), 'baby'), snap => cb(snap.exists() ? snap.data() : null));
}
