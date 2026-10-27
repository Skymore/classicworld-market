export const OFFER_HOURS = ['all', '1', '6', '24', '48', '72', '168'];
export const OFFER_PERCENTILES = ['all', '10', '25', '50', '75'];
export const EQUIPMENT_STATS = [
  ['weapon_attack', '物理攻击', 'Weapon ATK'], ['magic_attack', '魔法攻击', 'Magic ATK'],
  ['str', '力量', 'STR'], ['dex', '敏捷', 'DEX'], ['int', '智力', 'INT'], ['luk', '运气', 'LUK'],
  ['hp', '最大 HP', 'Max HP'], ['mp', '最大 MP', 'Max MP'], ['accuracy', '命中', 'Accuracy'],
  ['avoid', '回避', 'Avoidability'], ['speed', '移动速度', 'Speed'], ['jump', '跳跃力', 'Jump'],
  ['weapon_defense', '物理防御', 'Weapon DEF'], ['magic_defense', '魔法防御', 'Magic DEF'],
];
const nonnegative = value => {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
};

export function normalizeOfferFilters(filters = {}) {
  const f = filters || {};
  let minPrice = nonnegative(f.minPrice), maxPrice = nonnegative(f.maxPrice);
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  const minStock = nonnegative(f.minStock);
  const upgrades = value => { const n = nonnegative(value); return Number.isInteger(n) && n <= 15 ? n : null; };
  let minUpgrades = upgrades(f.minUpgrades), maxUpgrades = upgrades(f.maxUpgrades);
  if (minUpgrades !== null && maxUpgrades !== null && minUpgrades > maxUpgrades) [minUpgrades, maxUpgrades] = [maxUpgrades, minUpgrades];
  const stats = [];
  const source = Array.isArray(f.stats) ? f.stats : [{ stat: f.stat, min: f.minStat }];
  for (const condition of source.slice(0, 28)) {
    if (!condition || !EQUIPMENT_STATS.some(([key]) => key === condition.stat)) continue;
    const value = nonnegative(condition.min);
    const minimum = value !== null && value <= 65535 ? Math.floor(value) : null;
    const previous = stats.find(row => row.stat === condition.stat);
    if (previous) previous.min = Math.max(previous.min ?? 1, minimum ?? 1);
    else stats.push({ stat: condition.stat, min: minimum });
  }
  return {
    hours: OFFER_HOURS.includes(String(f.hours)) ? String(f.hours) : 'all',
    percentile: OFFER_PERCENTILES.includes(String(f.percentile)) ? String(f.percentile) : 'all',
    minPrice, maxPrice, minUpgrades, maxUpgrades,
    stock: ['known', 'unknown'].includes(f.stock) ? f.stock : 'all',
    minStock: minStock !== null && minStock >= 1 ? Math.floor(minStock) : null,
    equipment: ['captured', 'missing', 'bonus'].includes(f.equipment) ? f.equipment : 'all',
    stats,
  };
}

export function matchesEquipmentStat(variant, stat, minimum) {
  if (stat === 'all') return true;
  return (Array.isArray(variant?.stats) ? variant.stats : []).some(value =>
    value.key === stat && Number.isInteger(value.value) && value.value >= (minimum ?? 1) && value.value <= 65535);
}

export function matchesEquipmentStats(variant, stats) {
  return stats.every(row => matchesEquipmentStat(variant, row.stat, row.min));
}

// Percentiles use all listing unit prices for this item, independent of the
// other conditions and sort order. Keep every offer tied at the cutoff.
export function filterOffers(rows, mode, filters, now = Date.now() / 1000) {
  const f = normalizeOfferFilters(filters);
  let cap = null;
  if (f.percentile !== 'all') {
    const prices = rows.filter(row => !row.invalidated_at).map(row => row.price).filter(price => Number.isFinite(price) && price >= 0).sort((a, b) => a - b);
    cap = prices[Math.ceil(prices.length * Number(f.percentile) / 100) - 1] ?? null;
  }
  const cutoff = f.hours === 'all' ? null : now - Number(f.hours) * 3600;
  return { cap, rows: rows.filter(row => {
    if (cutoff !== null && !(Number.isFinite(row.observed) && row.observed > 0 && row.observed >= cutoff)) return false;
    if (f.percentile !== 'all' && !(cap !== null && Number.isFinite(row.price) && row.price >= 0 && row.price <= cap)) return false;
    if (f.minPrice !== null && !(Number.isFinite(row.price) && row.price >= f.minPrice)) return false;
    if (f.maxPrice !== null && !(Number.isFinite(row.price) && row.price <= f.maxPrice)) return false;
    const known = !row.invalidated_at && Number.isFinite(row.stock) && row.stock >= 0;
    if ((f.stock === 'known' && !known) || (f.stock === 'unknown' && known)) return false;
    if (f.minStock !== null && !(known && row.stock >= f.minStock)) return false;
    if (f.equipment === 'captured' && !row.hasStats) return false;
    if (f.equipment === 'missing' && (!row.isEquipment || row.hasStats)) return false;
    if (f.equipment === 'bonus' && !row.bonus) return false;
    if (f.stats.length && (!row.isEquipment || !matchesEquipmentStats(row.variant, f.stats))) return false;
    if (f.minUpgrades !== null || f.maxUpgrades !== null) {
      const n = row.variant?.remaining_upgrades;
      if (!row.isEquipment || (row.variant?.status && row.variant.status !== 'candidate') || !Number.isInteger(n) || n < 0 || n > 15) return false;
      if (f.minUpgrades !== null && n < f.minUpgrades || f.maxUpgrades !== null && n > f.maxUpgrades) return false;
    }
    return true;
  }) };
}

export function offerFilterTokens(filters, en = false) {
  const f = normalizeOfferFilters(filters), tokens = [];
  const add = (key, label) => tokens.push({ key, label });
  if (f.hours !== 'all') add('hours', en ? `Last ${f.hours === '168' ? '7 days' : f.hours + 'h'}` : f.hours === '168' ? '最近 7 天' : `最近 ${f.hours} 小时`);
  if (f.percentile !== 'all') add('percentile', en ? `Lowest ${f.percentile}%` : `价格最低 ${f.percentile}%`);
  if (f.minPrice !== null || f.maxPrice !== null) add('price', en ? `Price ${f.minPrice ?? 0}–${f.maxPrice ?? '∞'}` : `单价 ${f.minPrice ?? 0}–${f.maxPrice ?? '不限'}`);
  if (f.stock !== 'all' || f.minStock !== null) {
    const parts = [];
    if (f.stock !== 'all') parts.push(en ? (f.stock === 'known' ? 'Known stock' : 'Unknown stock') : (f.stock === 'known' ? '库存已知' : '库存未知'));
    if (f.minStock !== null) parts.push(en ? `Stock ≥ ${f.minStock}` : `库存 ≥ ${f.minStock}`);
    add('stock', parts.join(' · '));
  }
  if (f.equipment !== 'all') add('equipment', (en ? { captured: 'Captured stats', missing: 'Stats unknown', bonus: 'Bonus stats' } : { captured: '已采集属性', missing: '属性未知', bonus: '有加成属性' })[f.equipment]);
  for (const row of f.stats) add('stat:' + row.stat, `${EQUIPMENT_STATS.find(([key]) => key === row.stat)[en ? 2 : 1]} ≥ ${row.min ?? 1}`);
  if (f.minUpgrades !== null || f.maxUpgrades !== null) add('upgrades', `${en ? 'Upgrades left' : '可升级次数'} ${f.minUpgrades === f.maxUpgrades ? '= ' + f.minUpgrades : f.maxUpgrades === null ? '≥ ' + f.minUpgrades : f.minUpgrades === null ? '≤ ' + f.maxUpgrades : f.minUpgrades + '–' + f.maxUpgrades}`);
  return tokens;
}

export function clearOfferFilter(filters, key) {
  const f = normalizeOfferFilters(filters), empty = normalizeOfferFilters();
  if (key === 'all') return empty;
  if (key.startsWith('stat:')) return { ...f, stats: f.stats.filter(row => row.stat !== key.slice(5)) };
  for (const field of key === 'price' ? ['minPrice', 'maxPrice'] : key === 'stock' ? ['stock', 'minStock'] : key === 'upgrades' ? ['minUpgrades', 'maxUpgrades'] : key === 'stat' ? ['stats'] : [key]) {
    if (field in empty) f[field] = empty[field];
  }
  return f;
}
