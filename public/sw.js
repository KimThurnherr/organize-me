// Service Worker: Push anzeigen, App beim Antippen öffnen. Kein Offline-Cache der Daten.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Flechte', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: d.tag || 'flechte',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) return c.focus();
    return self.clients.openWindow(url);
  }));
});
