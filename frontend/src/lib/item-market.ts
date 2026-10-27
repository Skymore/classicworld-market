export const timestamp = (date: string | number | null | undefined) =>
  typeof date === "number" ? date : date ? new Date(date).getTime() / 1000 : 0;
export function hasBonus(variant: any, base: [string, number][]) {
  return Boolean(
    variant &&
    variant.stats?.some(
      (stat: any) =>
        !["weapon_defense", "magic_defense", "pdd", "mdd"].includes(stat.key) &&
        Number.isFinite(stat.value) &&
        stat.value > (base.find(([key]) => key === stat.key)?.[1] ?? 0),
    ),
  );
}

// Defence rolls and successful enhancement counts do not split identical stats.
// Keep the original offers intact; ranges belong only to the grouped cards.
export function groupEquipmentVariants(rows: any[]) {
  const defence = (key: string) =>
    ["weapon_defense", "magic_defense", "pdd", "mdd"].includes(key);
  const groups = new Map<
    string,
    { key: string; variant: any; offers: any[] }
  >();
  for (const row of rows) {
    const variant = row.variant;
    if (!variant) continue;
    const stats = (variant.stats || [])
      .filter((stat: any) => !defence(stat.key))
      .map((stat: any) => [stat.key, stat.value])
      .sort(([a]: any, [b]: any) => a.localeCompare(b));
    const key = JSON.stringify([
      stats,
      variant.remaining_upgrades ?? null,
      variant.unknown_fields ?? 0,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        variant: {
          ...variant,
          stats: (variant.stats || []).map((stat: any) => ({ ...stat })),
        },
        offers: [],
      };
      groups.set(key, group);
    }
    group.offers.push(row);
  }
  for (const group of groups.values()) {
    const enhancements = group.offers.map(
      (row) => row.variant.enhancements ?? 0,
    );
    group.variant.enhancements = Math.min(...enhancements);
    group.variant.maxEnhancements = Math.max(...enhancements);
    for (const key of ["weapon_defense", "magic_defense", "pdd", "mdd"]) {
      const values = group.offers.flatMap((row) =>
        (row.variant.stats || [])
          .filter(
            (stat: any) => stat.key === key && Number.isFinite(stat.value),
          )
          .map((stat: any) => stat.value),
      );
      if (!values.length) continue;
      const stat = group.variant.stats.find((stat: any) => stat.key === key);
      const source = group.offers
        .flatMap((row) => row.variant.stats || [])
        .find((stat: any) => stat.key === key);
      const range = {
        ...source,
        value: Math.min(...values),
        maxValue: Math.max(...values),
      };
      if (stat) Object.assign(stat, range);
      else group.variant.stats.push(range);
    }
  }
  return [...groups.values()];
}
export function tierBounds(
  prices: number[],
): { lo: number; hi: number | null }[] {
  const sorted = prices
    .filter((price) => Number.isFinite(price) && price >= 0)
    .map(Math.floor)
    .sort((a, b) => a - b);
  if (!sorted.length) return [];
  const lo = sorted[Math.round((sorted.length - 1) * 0.05)],
    hi = sorted[Math.round((sorted.length - 1) * 0.95)];
  // Skewed prices (cheap white gear next to 200K rolls): equal-width tiers would
  // put most listings in the first tier, so step by 1-2-5 multiples instead.
  if (lo > 0 && hi >= lo * 10) {
    const marks: number[] = [];
    for (let base = 10 ** Math.floor(Math.log10(lo)); base <= hi * 10; base *= 10)
      for (const mark of [base, base * 2, base * 5])
        if (mark > lo && mark <= hi) marks.push(mark);
    if (marks.length >= 2) {
      const bounds: { lo: number; hi: number | null }[] = [
        { lo: 0, hi: marks[0] - 1 },
      ];
      for (let i = 1; i < marks.length; i++)
        bounds.push({ lo: marks[i - 1], hi: marks[i] - 1 });
      bounds.push({ lo: marks[marks.length - 1], hi: null });
      return bounds;
    }
  }
  let step = 1,
    start = 0,
    inner = 0;
  outer: for (let exp = 0; exp < 12; exp++) {
    const base = 10 ** exp;
    for (const next of [
      base,
      base * 2,
      ...(exp > 0 ? [base * 2.5] : []),
      base * 5,
    ]) {
      step = next;
      start = Math.floor(lo / step) * step;
      inner = Math.floor((hi - start) / step) + 1;
      if (inner <= 8) break outer;
    }
  }
  const bounds: { lo: number; hi: number | null }[] = [];
  if (start > 0) bounds.push({ lo: 0, hi: start - 1 });
  for (let i = 0; i < inner; i++)
    bounds.push({ lo: start + i * step, hi: start + (i + 1) * step - 1 });
  bounds.push({ lo: start + inner * step, hi: null });
  return bounds;
}
export function makeLadder(market: any) {
  const listings = market.listings || [],
    points = market.sale_points || [];
  const tiers = tierBounds([
    ...listings.map((row: any) => row.unit_price),
    ...points.map((row: any) => row.price),
  ]).map((tier) => ({ ...tier, listings: 0 }));
  const grid = tiers.map(() =>
    Array(Math.max(1, market.days?.length || 0)).fill(0),
  );
  const index = (price: number) =>
    tiers.findIndex(
      (tier) =>
        Math.floor(price) >= tier.lo &&
        (tier.hi === null || Math.floor(price) <= tier.hi),
    );
  for (const row of listings) {
    const i = index(row.unit_price);
    if (i >= 0) tiers[i].listings++;
  }
  for (const point of points) {
    const i = index(point.price);
    if (i >= 0 && grid[i][point.day] != null) grid[i][point.day]++;
  }
  return { tiers, grid, index };
}
export function offerGroups(
  rows: any[],
  recent = false,
  now = Date.now() / 1000,
) {
  const minimum = (items: any[]) => {
    items = items.filter((row) => !row.invalidated_at);
    if (!items.length) return null;
    const fresh = items.filter(
      (row) => now - timestamp(row.seen_at) <= 48 * 3600,
    );
    return Math.min(
      ...(fresh.length ? fresh : items).map((row) => row.unit_price),
    );
  };
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = row.channel == null ? "unknown" : String(row.channel);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups]
    .map(([key, list]) => ({
      key,
      channel: list[0].channel,
      rows: list.sort((a, b) =>
        recent
          ? timestamp(b.seen_at) - timestamp(a.seen_at) ||
            a.unit_price - b.unit_price
          : a.unit_price - b.unit_price ||
            timestamp(b.seen_at) - timestamp(a.seen_at),
      ),
      price: minimum(list),
      observed: Math.max(...list.map((row) => timestamp(row.seen_at))),
      shops: new Set(
        list.map((row) => JSON.stringify([row.shop, row.channel, row.room])),
      ).size,
    }))
    .sort((a, b) =>
      recent
        ? b.observed - a.observed ||
          (a.price ?? Infinity) - (b.price ?? Infinity)
        : Number(a.key === "unknown") - Number(b.key === "unknown") ||
          (a.price ?? Infinity) - (b.price ?? Infinity) ||
          b.observed - a.observed,
    );
}
