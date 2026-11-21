/* YourVibe service worker: network-first for HTML, cache-first for versioned statics */
const CACHE = 'yv-static-v2';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => clients.claim())
));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/stream') || u.pathname.startsWith('/thumb')) return;
  /* HTML: always from the network (fresh code after every deploy) */
  if (req.mode === 'navigate' || u.pathname === '/' || u.pathname === '/index.html') {
    e.respondWith(
      fetch(req).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(req, cp));
        return r;
      }).catch(() => caches.match(req).then(x => x || Response.error()))
    );
    return;
  }
  /* versioned statics (?v=NN): cache-first */
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const fresh = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit || Response.error());
    return hit || fresh;
  }));
});
