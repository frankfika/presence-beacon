/* 在岗哨 · Service Worker
 * 只缓存应用外壳（HTML/CSS/JS/图标），API 一律走网络。
 * 网络优先 + 缓存兜底，保证改了配置能立刻生效。
 */
const CACHE = 'presence-beacon-v2';
const SHELL = [
  '/', '/index.html', '/admin.html', '/terminal.html',
  '/app.css', '/lib.js', '/employee.js', '/terminal.js', '/admin.js',
  '/vendor/jsQR.js', '/manifest.webmanifest',
  '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;           // API 不缓存
  if (url.pathname.startsWith('/icons/')) return;          // 图标走缓存

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => {
        if (r) return r;
        // 离线兜底：导航请求回到对应页面的外壳，
        // 至少让页面能打开（数据由页面自己的缓存兜底）
        if (e.request.mode === 'navigate') {
          const path = new URL(e.request.url).pathname;
          const fallback = path.startsWith('/admin') ? '/admin.html'
            : path.startsWith('/terminal') ? '/terminal.html'
            : '/index.html';
          return caches.match(fallback).then((f) => f || caches.match('/index.html'));
        }
        return caches.match('/index.html');
      }))
  );
});
