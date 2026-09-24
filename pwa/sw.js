const CACHE = 'ocp-v22';
const ASSETS = ['/lib/jssip.min.js', '/manifest.json', '/ocp-identity.js', '/ocp-did.js', '/ocp-vault.js', '/ocp-billing.js'];

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

// IDT-DIALOUT: wake the page's persistent SIP UA ahead of an inbound PSTN
// call. Every open window/tab gets 'wake_sip' regardless of visibility (a
// backgrounded tab can still run JS and re-register); a notification is
// only shown when nothing is visible, since a visible tab already reacts
// to 'wake_sip' itself.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  // Stale push arriving after the call already resolved — do nothing.
  if (data.ts && (Date.now() - data.ts) > 30000) return;

  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(c => c.postMessage({ type: 'wake_sip' }));

    const visible = wins.some(c => c.visibilityState === 'visible');
    if (!visible) {
      await self.registration.showNotification('Incoming call', {
        body: 'Tap to answer', tag: 'ocp-call', renotify: true,
        requireInteraction: true, vibrate: [300, 200, 300, 200, 300],
        data: { url: '/?wake=1' }
      });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = wins[0];
    if (existing) {
      existing.postMessage({ type: 'wake_sip' });
      if ('focus' in existing) await existing.focus();
    } else {
      await clients.openWindow(event.notification.data?.url || '/');
    }
  })());
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
      url.includes('/account/') ||
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