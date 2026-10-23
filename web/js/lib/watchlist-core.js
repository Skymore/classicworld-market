// Watchlist logic shared by the watch page, the price table's star and the
// legacy test. `validWatch` and `notifications` are market_watchlist.js'
// WatchlistCore, unchanged; test_market_watchlist.mjs still loads that file
// by path, so keep the two in step. The rest reads and writes the redesign's
// storage: `watchlist` (array of item ids, also written by the price table)
// and `watchlist_settings` ({ [item_id]: { cap, notify } }).
export const LIST_KEY = 'watchlist';
export const SETTINGS_KEY = 'watchlist_settings';
export const MAX_WATCHES = 100;
// Offers newer than this many seconds may pop a notification.
export const LIVE_SECONDS = 120;

const validId = (id) => Number.isSafeInteger(id) && id >= 1000000 && id <= 5999999;
export const validWatch = (item) => item && validId(item.item_id);

// New offers under a watch's cap: not seen before, observed after the page
// started (or the watch was added) and at most two minutes old. `seen` maps
// offer id -> last time seen and is pruned to 48 h / 2000 entries.
export function notifications(listings, watches, seen, started, now) {
  const selected = new Map(watches.filter(validWatch).map((w) => [w.item_id, w]));
  const fresh = [];
  for (const row of listings) {
    const watch = selected.get(row?.item_id);
    if (!watch || typeof row.id !== 'string' || !Number.isFinite(row.unit_price) || row.unit_price < 0 || !Number.isFinite(row.stock) || row.stock <= 0) continue;
    if (watch.max_price != null && row.unit_price > watch.max_price) continue;
    if (!Number.isFinite(row.observed) || row.observed > now) continue;
    if (!seen.has(row.id) && row.observed >= Math.max(started, watch.added_at || 0) && now - row.observed <= LIVE_SECONDS) fresh.push(row);
    seen.set(row.id, now);
  }
  for (const [id, at] of seen) if (now - at > 48 * 3600) seen.delete(id);
  while (seen.size > 2000) seen.delete(seen.keys().next().value);
  return fresh;
}

// Shared offers and the caller's own visits have independent "seen" sets.
// The same update delivered through both feeds still produces one popup.
export function combinedNotifications(rows,watches,state,started,now,source='shared',collector=''){
 if(source==='personal'&&!collector)return [];
 let seen=state.shared;
 if(source==='personal'){
  if(!state.personal.has(collector))state.personal.set(collector,new Map());
  seen=state.personal.get(collector);
 }
 const fresh=notifications(rows,watches,seen,started,now);
 for(const [id,entry] of state.delivered)if(now-entry.at>86400)state.delivered.delete(id);
 const found=fresh.filter(row=>{const previous=state.delivered.get(row.id);return !previous||(previous.observed!==row.observed&&now-previous.at>5);});
 for(const row of found)state.delivered.set(row.id,{at:now,observed:row.observed});
 while(state.delivered.size>2000)state.delivered.delete(state.delivered.keys().next().value);
 return found;
}

function readJson(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// Valid, distinct ids in stored order, at most MAX_WATCHES.
export function readList(storage) {
  const raw = readJson(storage, LIST_KEY, []);
  const ids = Array.isArray(raw) ? raw.map(Number).filter(validId) : [];
  return [...new Set(ids)].slice(0, MAX_WATCHES);
}

export const saveList = (storage, ids) => writeJson(storage, LIST_KEY, ids);

const validCap = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

// Settings for `ids`; an item without settings has no cap and notifies.
export function readSettings(storage, ids) {
  const raw = readJson(storage, SETTINGS_KEY, {});
  const found = {};
  for (const id of ids) {
    const s = raw && typeof raw === 'object' ? raw[id] : null;
    found[id] = { cap: validCap(s?.cap), notify: s?.notify !== false };
  }
  return found;
}

export const saveSettings = (storage, settings) => writeJson(storage, SETTINGS_KEY, settings);

export function add(ids, id) {
  if (!validId(id) || ids.includes(id) || ids.length >= MAX_WATCHES) return ids;
  return [...ids, id];
}

export const remove = (ids, id) => ids.filter((x) => x !== id);

// Every item of a catalogue preset (`/api/v1/watchlist/catalog` presets[]),
// added in order until the list is full.
export function addPreset(ids, preset) {
  return (preset?.items ?? []).reduce((acc, item) => add(acc, item.item_id), ids);
}

// The `watches` shape `notifications` expects. `addedAt` holds the times of
// watches added on this page so their history does not pop.
export function watches(ids, settings, addedAt = {}) {
  return ids.map((id) => ({
    item_id: id,
    max_price: settings[id]?.cap ?? null,
    notify: settings[id]?.notify !== false,
    added_at: addedAt[id] || 0,
  }));
}

// A listing satisfies its watch: in stock and at or under the cap (inclusive).
export const underCap = (row, cap) => row.stock > 0 && Number.isFinite(row.unit_price) && (cap == null || row.unit_price <= cap);

// Listings of watched items that satisfy their caps, cheapest first.
export function matching(listings, ids, settings) {
  const watched = new Set(ids);
  return listings
    .filter((r) => watched.has(r.item_id) && underCap(r, settings[r.item_id]?.cap ?? null))
    .sort((a, b) => a.unit_price - b.unit_price || b.observed - a.observed);
}

// Per item: lowest live unit price and listings under the cap.
export function summary(listings, ids, settings) {
  const found = Object.fromEntries(ids.map((id) => [id, { lowest: null, under: 0, total: 0 }]));
  for (const r of listings) {
    const s = found[r.item_id];
    if (!s || !(r.stock > 0)) continue;
    s.total += 1;
    if (s.lowest == null || r.unit_price < s.lowest) s.lowest = r.unit_price;
    if (underCap(r, settings[r.item_id]?.cap ?? null)) s.under += 1;
  }
  return found;
}

const WatchlistCore = {
  validWatch, notifications, combinedNotifications, readList, saveList, readSettings, saveSettings,
  add, remove, addPreset, watches, underCap, matching, summary,
};
globalThis.WatchlistCore = WatchlistCore;
export default WatchlistCore;
