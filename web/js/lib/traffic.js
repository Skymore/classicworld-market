// A fresh anonymous browser identifier each UTC day; never tied to an account.
const storageKey = 'cwm.traffic.daily.v1';
let memory;
let lastPath;
let first = true;

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
}
function visitor() {
  const day = new Date().toISOString().slice(0, 10);
  try { memory = JSON.parse(localStorage.getItem(storageKey) || 'null') || memory; } catch { /* storage disabled */ }
  if (memory?.day !== day || !/^[0-9a-f]{32}$/.test(memory?.id || '')) memory = { day, id: randomId() };
  try { localStorage.setItem(storageKey, JSON.stringify(memory)); } catch { /* page-lifetime fallback */ }
  return memory.id;
}
export function trackPage(path) {
  // Filters, language, hashes and SSE rerenders are not additional page views.
  if (lastPath === path || document.visibilityState === 'prerender' ||
      navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  lastPath = path;
  try {
    const referrer = first ? document.referrer : '';
    first = false;
    void fetch('/api/v1/traffic/event', {
      method: 'POST', credentials: 'omit', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: randomId(), visitor: visitor(), path,
        referrer, device: innerWidth <= 640 ? 'phone' : innerWidth <= 1100 ? 'tablet' : 'desktop' }),
    }).catch(() => {});
  } catch { /* Statistics must never interrupt navigation. */ }
}
