/* Service Worker — App-Shell + Daten offline verfügbar machen */
const CACHE = 'sks-trainer-v5';
const CORE = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './data/index.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Nur eigene GET-Requests; API-Aufrufe (cross-origin/POST) durchlassen
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const isData = url.pathname.includes('/data/') || url.pathname.includes('/img/');

  if (isData) {
    // Daten/Bilder: cache-first (ändern sich selten, offline wichtig)
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
        return res;
      }))
    );
  } else {
    // App-Shell (html/css/js): network-first -> immer aktuell, offline Fallback auf Cache
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
    );
  }
});
