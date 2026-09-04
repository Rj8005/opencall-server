const CACHE = 'ocp-v7';
const ASSETS = ['/', '/index.html', '/manifest.json', '/lib/jssip.min.js'];

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
  const url = event.request.url;

  // Never intercept API calls — let them go directly to network
  if (url.includes('onrender.com') ||
      url.includes('textbelt.com') ||
      url.includes('opencall-server') ||
      url.includes('/reach/') ||
      url.includes('/invite/') ||
      url.includes('/health')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  console.log('[SW] push received', data.type, 'callId:', data.callId);

  // ── Chat message nudge ────────────────────────────────────
  if (data.type === 'chat_message') {
    const from        = data.from     || '';
    const displayName = data.fromName || from.slice(0, 20) || 'Someone';
    e.waitUntil(self.registration.showNotification(
      '💬 New message from ' + displayName,
      {
        body:    'New message',   // no plaintext — server can't read ciphertext
        icon:    '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     'chat-' + from,  // one notification per sender
        renotify: true,
        data:    { openChat: from }
      }
    ));
    return;
  }

  // ── Incoming call notification ────────────────────────────
  // Title is fixed per spec; body surfaces the caller's handle/name/number.
  const title = '📞 Incoming OCP call';
  const body  = data.handle || data.fromName || data.from || 'Unknown caller';

  const options = {
    body,
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    // Use callId as tag so each call shows its own notification; same callId
    // collapses duplicate pushes (e.g. retries) into one.
    tag:              data.callId || 'opencall-incoming',
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

  const callId   = e.notification.data?.callId;
  const openChat = e.notification.data?.openChat;
  const action   = e.action;
  console.log('[SW] notification clicked -> openChat:', openChat, 'callId:', callId, 'action:', action);

  // Chat notification: open the app focused on that contact's thread
  if (openChat) {
    const targetUrl = '/index.html?chat=' + encodeURIComponent(openChat);
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const existing = clients.find(c => c.url.includes('/index.html') || c.url.endsWith('/'));
        if (existing) {
          return existing.navigate(targetUrl).then(w => w && w.focus()).catch(() => existing.focus());
        }
        return self.clients.openWindow(targetUrl);
      })
    );
    return;
  }

  // Target URL: open/focus the app pre-loaded with the call to answer.
  const targetUrl = callId ? '/index.html?answer=' + callId : '/';

  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Prefer an existing OCP window — navigate it to the answer URL.
        const existing = clients.find(
          c => c.url.includes('/index.html') || c.url.endsWith('/')
        );
        if (existing) {
          return existing.navigate(targetUrl)
            .then(win => {
              if (win) {
                win.focus();
                // Let the page know which button the user tapped (answer/decline).
                if (action) win.postMessage({ type: 'notification_action', action, callId });
              }
            })
            .catch(() => existing.focus());   // navigate() may reject in some browsers
        }
        // No window open — open a new one.
        return self.clients.openWindow(targetUrl)
          .then(win => {
            if (win && action) win.postMessage({ type: 'notification_action', action, callId });
          });
      })
  );
});
