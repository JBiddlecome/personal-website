// Network first, so updates show right away. The last good copy keeps the page working with no signal, as in a store.
const CACHE = 'floorplan';
const FILES = ['./', 'viewer.js', 'model.js', 'apartment.js', 'layout.json', 'vendor/three/three.module.min.js', 'vendor/three/OrbitControls.js'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((res) => {
    // Only good responses, so an expired login's sign-in page never replaces the saved copy.
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
    }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || Response.error())));
});
