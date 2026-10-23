// The watchlist as the pages share it: localStorage `watchlist` = JSON array
// of item ids. The watch page keeps caps and alert switches elsewhere
// (`watchlist_settings`); this module only adds and removes ids.
const KEY = 'watchlist';

export function watchIds() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

export function isWatched(id) {
  return watchIds().includes(id);
}

// Returns the new state. Fires `watchchange` on document so the dock badge
// and other rows of the same item update.
export function toggleWatch(id) {
  const ids = watchIds();
  const on = !ids.includes(id);
  const next = on ? [...ids, id] : ids.filter((x) => x !== id);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: state lives until reload */ }
  document.dispatchEvent(new CustomEvent('watchchange', { detail: { id, on, count: next.length } }));
  return on;
}
