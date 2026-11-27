'use strict';
/* bored? offline support.
   The app's own files are kept on the device so it opens without a connection.
   Pages: network first, then the copy. Scripts, styles, fonts, icons: the copy first.
   Their addresses carry the version (/app.js?v=…), so a new release never gets an old file.
   API calls are never stored here: the app handles those itself. */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `bored-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.clone().text();
    await cache.put('/', res);
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
    await Promise.all(assets.map((a) => cache.add(a).catch(() => {})));
    // the font files named inside fonts.css
    const fonts = assets.find((a) => a.startsWith('/fonts/fonts.css'));
    if (fonts) {
      const css = await (await cache.match(fonts))?.text() || '';
      await Promise.all([...css.matchAll(/url\(["']?(\/[^"')]+)/g)].map((m) => cache.add(m[1]).catch(() => {})));
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
