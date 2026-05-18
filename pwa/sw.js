const CACHE = 'opencall-v2';
const ASSETS = ['/', '/index.html', '/manifest.json'];

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

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}

  const title = data.fromName
    ? 'Call from ' + data.fromName
    : 'Incoming OCP Call';

  const options = {
    body:             data.from || 'OpenCall',
    icon:             '/icon-192.png',
    badge:            '/icon-192.png',
    tag:              'opencall-incoming',
    renotify:         true,
    requireInteraction: true,
    vibrate:          [200, 100, 200, 100, 200],
    data:             { callId: data.callId, from: data.from },
    actions: [
      { action: 'answer',  title: '✓ Answer'  },
      { action: 'decline', title: '✗ Decline' }
    ]
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const callData = e.notification.data;

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const msg = { type: 'notification_action', action, callData };
        if (clients.length > 0) {
          clients[0].focus();
          clients[0].postMessage(msg);
        } else {
          self.clients.openWindow('/').then(w => w && w.postMessage(msg));
        }
      })
  );
});
