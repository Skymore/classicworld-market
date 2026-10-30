import { normalizeOfferFilters, filterOffers, offerFilterTokens } from './item-offer-filters.js?v=20261029-critical-1';
import { mergeShopOffers, shopOfferIdentity } from './quote-groups.js?v=20261026-reminders-2';

export function normalizeReminder(value = {}) {
  const f = normalizeOfferFilters({ ...value, hours: 'all', maxPrice: null, percentile: 'all' });
  return { percentile: ['10', '25', '50'].includes(String(value?.percentile)) ? String(value.percentile) : 'all',
    minPrice: f.minPrice, stock: f.stock, minStock: f.minStock, equipment: f.equipment, stats: f.stats,
    minUpgrades: f.minUpgrades, maxUpgrades: f.maxUpgrades };
}
// Missing groups are legacy settings. An explicit empty list means no matches.
export function watchGroups(setting = {}) {
  const source = Array.isArray(setting.groups) ? setting.groups : [{ id: 'default', name: '', cap: setting.cap, notify: setting.notify, reminder: setting.reminder }];
  return source.slice(0, 12).map((g, i) => ({ id: typeof g?.id === 'string' ? g.id : 'group-' + i,
    name: typeof g?.name === 'string' ? g.name.slice(0, 40) : '',
    cap: Number.isFinite(g?.cap) && g.cap >= 0 ? g.cap : null,
    notify: g?.notify !== false, buy: g?.buy === true, reminder: normalizeReminder(g?.reminder) }));
}
export function watchSelection(rows, itemId, setting = {}, reference = {}, purpose = 'watch') {
  const groups = watchGroups(setting).filter(g => purpose === 'watch' || (purpose === 'notify' ? g.notify : g.buy));
  const found = new Map();
  for (const group of groups) for (const row of reminderSelection(rows, itemId, group, reference).rows) {
    const previous = found.get(row.id);
    found.set(row.id, { ...row, matched_groups: [...(previous?.matched_groups || []), group.name || group.id] });
  }
  return { rows: [...found.values()] };
}
export function reminderTokens(value, en = false) {
  return offerFilterTokens({ ...normalizeReminder(value), percentile: 'all' }, en);
}
export function activeOffers(rows) {
  return rows.filter(row => !row.invalidated_at && Number.isFinite(row.unit_price) && row.unit_price >= 0 &&
    (row.stock == null || (Number.isFinite(row.stock) && row.stock > 0)));
}
export function prepareReminderRows(rows, baseStats = {}) {
  return activeOffers(rows).map(row => {
    const variant = row.equipment && typeof row.equipment === 'object' ? row.equipment :
      row.variant && typeof row.variant === 'object' ? row.variant : null;
    const base = baseStats[row.item_id] || [];
    const hasStats = Boolean(variant && (!variant.status || variant.status === 'candidate') && Array.isArray(variant.stats));
    return { ...row, price: row.unit_price, variant, isEquipment: Math.floor(row.item_id / 1000000) === 1, hasStats,
      bonus: hasStats && base.length > 0 && variant.stats.some(stat =>
        !['weapon_defense', 'magic_defense', 'pdd', 'mdd'].includes(stat.key) &&
        Number.isFinite(stat.value) && stat.value > (base.find(([key]) => key === stat.key)?.[1] ?? 0)) };
  });
}
// The percentile baseline is all active grouped offers, before this item's cap
// and advanced conditions. Server cutoffs also cover offers beyond the public limit.
export function reminderSelection(rows, itemId, setting = {}, reference = {}) {
  const f = normalizeReminder(setting.reminder);
  const baseline = activeOffers(reference.rows ?? rows).filter(row => row.item_id === itemId);
  let cap = Number.isFinite(setting.cap) && setting.cap >= 0 ? setting.cap : null;
  if (f.percentile !== 'all') {
    const prices = baseline.map(row => row.unit_price).sort((a, b) => a - b);
    cap = reference.percentiles?.[itemId]?.[f.percentile] ?? prices[Math.ceil(prices.length * Number(f.percentile) / 100) - 1] ?? null;
    if (cap === null) return { cap, rows: [], ready: false };
  }
  const prepared = prepareReminderRows(rows.filter(row => row.item_id === itemId), reference.baseStats);
  const equipment = Math.floor(itemId / 1000000) === 1;
  const filtered = filterOffers(prepared.filter(row => (cap === null || row.unit_price <= cap) && (!equipment || !f.stats.length || row.hasStats)), 'price', {
    ...f, percentile: 'all', equipment: equipment ? f.equipment : 'all', stats: equipment ? f.stats : [],
  }).rows;
  return { cap, rows: filtered, ready: true };
}
export function matchingReminders(rows, ids, settings, reference = {}) {
  return ids.flatMap(id => watchSelection(rows, id, settings[id], reference).rows);
}
// Eligibility comes from full server groups. Use those same groups in the popup,
// even when the raw notification window only contains part of their inventory.
export function notificationEligibility(packet, ids, settings, reference) {
  const rawGroups = mergeShopOffers(packet.listings || []);
  const members = new Map(rawGroups.map(row => [row.id, row.merged_ids ?? [row.id]]));
  const selected = ids.flatMap(id => watchSelection(packet.grouped_listings ?? rawGroups, id, settings[id], reference, 'notify').rows);
  const groups = new Map();
  for (const row of selected) {
    const group = { ...row, reminder_delivery_key: shopOfferIdentity(row) ?? row.id };
    for (const id of row.merged_ids ?? members.get(row.id) ?? [row.id]) groups.set(id, group);
  }
  return groups;
}
