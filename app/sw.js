// Offline support: the app's own files are kept on the phone so it opens with no signal.
// Strategy: show the saved copy instantly, fetch a fresh copy in the background for next time.
// That's how updates arrive by themselves. Bump VERSION when files are added or removed.
const VERSION = 'picos-v5';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'js/app.js', 'js/db.js', 'js/logic.js',
  'vendor/firebase.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // database traffic goes straight through
  e.respondWith(caches.open(VERSION).then(async cache => {
    const key = url.pathname.endsWith('/') ? './' : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(key, r.clone()); return r; }).catch(() => cached);
    return cached || fresh;
  }));
});
