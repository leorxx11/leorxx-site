// 整站共用的 Service Worker：主页（/）和桌面（/desk）合起来是一个 App
// 页面和脚本网络优先，断网时用缓存打开；接口（含在线状态）和文件一律直连网络，不缓存

const CACHE = 'leorxx-shell-v6';
const PAGES = ['/', '/desk'];
const BYPASS = ['/api/', '/i/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PAGES)).then(() => self.skipWaiting()));
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
  if (BYPASS.some((p) => url.pathname.startsWith(p))) return;

  // 页面按路径缓存（忽略 #hash 和查询参数），其他静态文件按完整地址缓存
  const key = e.request.mode === 'navigate' ? url.pathname.replace(/\/$/, '') || '/' : e.request;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    } catch {
      return (await caches.match(key)) || Response.error();
    }
  })());
});
