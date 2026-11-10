// Offline support for the hosted copy. Network first, so updates show up as
// soon as there's a connection; the cache is only used when offline.
const CACHE = 'sudoku-20261110101652';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'engine.js', 'sound.js', 'worker.js', 'manifest.webmanifest',
    'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
    // Always check with the server (a cheap 304 when nothing changed), so an
    // update shows up on the next load instead of waiting out GitHub Pages'
    // 10-minute browser cache.
    const fresh = e.request.mode === 'navigate'
        ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
        : new Request(e.request, { cache: 'no-cache' });
    e.respondWith(fetch(fresh)
        .then(res => {
            if (res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, copy));
            }
            return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
