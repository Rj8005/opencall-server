// OpenCall Service Worker v1.0
// Enables: installable PWA, offline support, push notifications

const CACHE   = 'opencall-v1';
const ASSETS  = ['/', '/index.html', '/manifest.json'];

// ── Install: cache core assets ────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fallback to network ──────────
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push: ring the phone even when app is closed ──────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}

  const title   = data.fromName ? `Call from ${data.fromName}` : 'Incoming Call';
  const options = {
    body:    data.from || 'OpenCall',
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    tag:     'opencall-incoming',
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data:    { callId: data.callId, from: data.from },
    actions: [
      { action: 'answer',  title: 'Answer'  },
      { action: 'decline', title: 'Decline' }
    ]
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click: open app or handle action ─────────
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'decline') {
    // notify app to reject
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({
        type: 'notification_action',
        action: 'decline',
        callId: e.notification.data?.callId
      }));
    });
    return;
  }

  // answer or default tap — open/focus the app
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({
          type:   'notification_action',
          action: 'answer',
          callId: e.notification.data?.callId
        });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});