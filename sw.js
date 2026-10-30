// 앱 파일을 바꾸면 VERSION과 index.html의 ?v= 숫자를 함께 올립니다.
const VERSION = 'ledger-v10';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT = 3000;

// 브라우저 HTTP 캐시를 거치지 않고 서버에서 직접 받아 옴
const fresh = url => fetch(new Request(url, { cache: 'no-cache', credentials: 'same-origin' }));

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.all(ASSETS.map(u => fresh(u).then(res => { if (!res.ok) throw new Error(u); return c.put(u, res); }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 온라인이면 항상 최신 파일을, 오프라인이거나 응답이 늦으면 저장된 파일을 보여 줌
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const network = fresh(req.url).then(res => {
      if (res.ok) cache.put(req.url, res.clone());
      return res;
    });
    const fallback = async () => (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? cache.match('index.html') : undefined);
    const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
      return (await fallback()) || await network;
    } catch {
      return (await fallback()) || Response.error();
    }
  })());
});
