const CACHE = 'ocp-v8';
const ASSETS = ['/lib/jssip.min.js', '/manifest.json', '/ocp-identity.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;

  if (req.method !== 'GET') return;

  // Never intercept API calls — straight to network
  if (url.includes('onrender.com') ||
      url.includes('textbelt.com') ||
      url.includes('opencall-server') ||
      url.includes('/reach/') ||
      url.includes('/invite/') ||
      url.includes('/did/') ||
      url.includes('/health')) {
    return;
  }

  // NETWORK-FIRST for the app shell — never serve stale HTML.
  const isDoc = req.mode === 'navigate' ||
                (req.headers.get('accept') || '').includes('text/html');

  if (isDoc) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // CACHE-FIRST for static assets only.
  event.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
    )
  );
});