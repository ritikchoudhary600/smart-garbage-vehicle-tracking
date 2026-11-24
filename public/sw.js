/**
 * sw.js — minimal service worker
 * Only used to show system notifications (Android Chrome requires one) and to
 * bring the app back to the front when a notification is tapped. It does not
 * cache anything, so the app always loads fresh.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (open) return open.focus();
    return self.clients.openWindow('/');
  })());
});
