// 主页的 Service Worker：页面网络优先，断网时用缓存的版本打开
// 机房数据（/komari/）和在线状态（/status）一律直连网络，不缓存

const CACHE = 'home-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/komari/') || url.pathname === '/status') return;

  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    } catch {
      return (await caches.match(key)) || Response.error();
    }
  })());
});
