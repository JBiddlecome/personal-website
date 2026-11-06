// Network first, so updates show right away. The last good copy keeps the page working with no signal, as in a store.
const CACHE = 'floorplan';
const FILES = ['./', 'viewer.js', 'model.js', 'apartment.js', 'layout.json', 'vendor/three/three.module.min.js', 'vendor/three/OrbitControls.js'];
// One bar of signal can stall a request for a long time, so after this long the saved copy is used if there is one.
const SLOW_MS = 4000;

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const network = fetch(e.request);
  // Only good responses, so an expired login's sign-in page never replaces the saved copy.
  // The copy is taken before the page gets the response, which would use up its body.
  e.waitUntil(network.then((res) => {
    if (!res.ok) return;
    const copy = res.clone();
    return caches.open(CACHE).then((c) => c.put(e.request, copy));
  }).catch(() => {}));
  const saved = () => caches.match(e.request);
  // no-store requests check what the server really holds, so they never get the saved copy early.
  const slow = e.request.cache === 'no-store' ? network
    : new Promise((resolve) => setTimeout(resolve, SLOW_MS)).then(saved).then((hit) => hit || network);
  e.respondWith(Promise.race([network, slow]).catch(() => saved().then((hit) => hit || Response.error())));
});
