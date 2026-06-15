// Service worker — receives push messages and shows notifications.
self.addEventListener('push', (event) => {
  let data = { title: 'Grocery Tracker', body: '' };
  try { data = event.data.json(); } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Grocery Tracker', {
      body: data.body || '',
      tag: data.tag || 'grocery'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((wins) => {
      for (const w of wins) { if ('focus' in w) return w.focus(); }
      return clients.openWindow('/');
    })
  );
});
