// sw.js — app shell 缓存（网络优先，离线兜底）+ Web Push 接收
const SHELL = 'pp-shell-v11';
const ASSETS = [
  './', './index.html', './style.css',
  './js/app.js', './js/api.js', './js/md.js', './js/chat.js', './js/store.js', './js/diary.js', './js/mock.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.host !== location.host) return; // API 请求直连
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});

// ---- Web Push（iOS 16.4+ PWA / 桌面）----
self.addEventListener('push', e => {
  let data = { title: '🌙 规划', body: '' };
  try { data = e.data ? e.data.json() : data; } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'planning',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.includes('planning')) return c.focus();
    return clients.openWindow('./');
  }));
});
