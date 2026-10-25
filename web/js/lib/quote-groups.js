// Presentation groups only: never combine snapshots, shops, prices or unknown gear.
const stable = value => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
function identity(row) {
  const at = row.seen_at ?? row.observed ?? row.time;
  if (!row.shop_key || !row.visit_id || !Number.isInteger(row.slot) ||
      !Number.isInteger(row.item_id) || !Number.isFinite(row.unit_price) ||
      row.unit_price < 0 || !at || !Number.isInteger(row.bundle) || row.bundle < 1) return null;
  const gear = Math.floor(row.item_id / 1000000) === 1;
  const eq = row.equipment ?? row.variant;
  if (gear && (!eq || (eq.status && eq.status !== 'candidate') ||
      !Array.isArray(eq.stats) || (Array.isArray(eq.unknown_fields) ? eq.unknown_fields.length : eq.unknown_fields))) return null;
  return stable([row.world ?? '', row.source ?? '', row.shop_key, row.visit_id, at,
    row.invalidated_at ?? null, row.item_id, row.unit_price, row.bundle, row.unit_basis ?? '', gear ? eq : null]);
}
export function mergeShopOffers(rows) {
  const output = [], groups = new Map();
  for (const row of rows) {
    const key = identity(row);
    if (key === null) { output.push(row); continue; }
    let group = groups.get(key);
    if (!group) {
      group = { row: {...row, merged_count: 0}, slots: new Set(), ids: [] };
      groups.set(key, group); output.push(group.row);
    }
    // A repeated observation of one slot is not additional inventory.
    if (group.slots.has(row.slot)) continue;
    group.slots.add(row.slot);
    const known = Number.isSafeInteger(row.stock) && row.stock >= 0;
    const sum = group.row.merged_count ? group.row.stock + row.stock : row.stock;
    group.row.stock = known && (group.row.merged_count === 0 || group.row.stock != null) && Number.isSafeInteger(sum) ? sum : null;
    group.row.merged_count++;
    group.ids.push(row.id ?? row.key);
    group.row.merged_ids = [...group.ids];
  }
  return output;
}
