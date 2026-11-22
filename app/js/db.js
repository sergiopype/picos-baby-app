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
