// 暗房的 Service Worker：页面和脚本走网络优先，断网时用缓存的版本打开
// 接口和图片一律直连网络，不缓存（登录态、底片都以服务器为准）

const CACHE = 'darkroom-shell-v1';
const SHELL = [
  '/',
  '/assets/app.css',
  '/assets/main.js',
  '/assets/lib.js',
  '/assets/webauthn.js',
  '/assets/develop.js',
  '/assets/library.js',
  '/assets/settings.js',
  '/assets/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const isShell = e.request.mode === 'navigate' || url.pathname.startsWith('/assets/');
  if (!isShell) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
      }
      return res;
    } catch {
      return (await caches.match(e.request.mode === 'navigate' ? '/' : e.request)) || Response.error();
    }
  })());
});
