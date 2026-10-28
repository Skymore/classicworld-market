// Presentation groups only. A sale is one shop slot; the slots of one item a shop
// sold between the same two visits, at one price and with one kind of evidence,
// read as one sale (six sold-out slots of 100 become one sale of 600).
const stable = value => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
export function saleGroupIdentity(row) {
  if (!Number.isFinite(row.time) || !Number.isInteger(row.item_id) || !row.kind ||
      !Number.isFinite(row.sale_unit_price ?? row.sale_price) || (!row.shop && !row.location)) return null;
  // Gear merges only when its attributes are known and identical.
  const gear = Math.floor(row.item_id / 1000000) === 1;
  const eq = row.equipment;
  if (gear && (!row.variant || !eq || (eq.status && eq.status !== 'candidate') || !Array.isArray(eq.stats) ||
      (Array.isArray(eq.unknown_fields) ? eq.unknown_fields.length : eq.unknown_fields))) return null;
  return stable([row.world ?? '', row.source ?? '', row.shop ?? '', row.owner_name ?? '', row.location ?? null,
    row.time, row.previous_time ?? null, row.kind, row.item_id, row.variant ?? null, gear ? eq : null,
    row.sale_price ?? null, row.sale_unit_price ?? null, row.bundle ?? 1, row.unit_basis ?? '']);
}
export function mergeShopSales(rows) {
  const output = [], groups = new Map();
  for (const row of rows) {
    const key = saleGroupIdentity(row);
    const group = key === null ? undefined : groups.get(key);
    if (!group) {
      const first = { ...row, merged_count: 1 };
      if (key !== null) groups.set(key, first);
      output.push(first);
      continue;
    }
    // Quantities add up only while every slot's quantity is known.
    const known = Number.isSafeInteger(group.quantity) && Number.isSafeInteger(row.quantity);
    group.quantity = known && Number.isSafeInteger(group.quantity + row.quantity) ? group.quantity + row.quantity : null;
    group.merged_count++;
  }
  return output;
}
