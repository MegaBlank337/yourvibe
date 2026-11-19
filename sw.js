/* YourVibe service worker: cache static assets, never cache API/video streams */
const CACHE = 'yv-static-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/stream') || u.pathname.startsWith('/thumb')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const fresh = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit || Response.error());
    return hit || fresh;
  }));
});
