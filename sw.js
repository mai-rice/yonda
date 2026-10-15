// アプリ本体をキャッシュしてオフラインでも開けるようにする
const CACHE = 'yonda-v6';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  // ブラウザのHTTPキャッシュ（GitHub Pagesは10分）を通さず、最新を取りに行く
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // ネット優先（更新があるか毎回サーバーに確かめる）、つながらなければキャッシュ
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
