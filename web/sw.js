// Web Push for watch alerts (WEB_PUSH.md): shows pushed messages and opens
// their page when clicked. No offline cache and no fetch handler, so every
// request still goes to the network.
const ICON = '/web/icons/icon-192.png';
const BADGE = '/web/icons/badge-96.png';
const DEFAULT_URL = '/watch';
const DEFAULT_TITLE = '枫叶市集';

self.addEventListener('install', () => self.skipWaiting());
// Controlling open pages lets a notification click navigate them.
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => event.waitUntil(showPush(event.data)));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openPage(data.url));
});

const text = value => (typeof value === 'string' ? value : '');

/** A same-origin path for `value`, else `fallback`: pushes never send users or icon requests elsewhere. */
function sitePath(value, fallback) {
  if (!text(value)) return fallback;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}

function readPayload(data) {
  if (!data) return {};
  try {
    const value = data.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return { body: data.text() };
  }
}

function showPush(data) {
  const message = readPayload(data);
  const tag = text(message.tag);
  return self.registration.showNotification(text(message.title) || DEFAULT_TITLE, {
    body: text(message.body),
    icon: sitePath(message.icon, ICON),
    badge: BADGE,
    data: { url: sitePath(message.url, DEFAULT_URL) },
    // A newer alert for the same item replaces the old one and alerts again.
    ...(tag ? { tag, renotify: true } : {}),
  });
}

async function openPage(path) {
  const url = new URL(sitePath(path, DEFAULT_URL), self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find(item => item.url === url) || windows.find(item => item.focused) || windows[0];
  if (!client) return self.clients.openWindow(url);
  try {
    const focused = await client.focus();
    if (focused.url !== url) await focused.navigate(url);
  } catch {
    // navigate() needs a page this worker controls; open the page instead.
    await self.clients.openWindow(url);
  }
}
