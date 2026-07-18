/* sw.js — offline app shell for FreeCell "The Vault".
 * Cache-first. Bump CACHE_NAME on every deploy or updates won't show. */
const CACHE_NAME = 'vault-v3';
const ASSETS = [
  '.', 'index.html', 'style.css',
  'game.js', 'solver.js', 'deals.js', 'app.js',
  'manifest.json', 'vault-emblem.png',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
      // runtime-cache same-origin GETs so newly added assets persist offline
      const copy = resp.clone();
      if (resp.ok && e.request.url.startsWith(self.location.origin)) {
        caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match('index.html')))
  );
});
