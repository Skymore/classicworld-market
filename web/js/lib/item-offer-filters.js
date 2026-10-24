export const OFFER_HOURS = ['all', '1', '6', '24', '48', '72', '168'];
export const OFFER_PERCENTILES = ['all', '10', '25', '50', '75'];

export function normalizeOfferFilters(filters = {}) {
  return {
    hours: OFFER_HOURS.includes(String(filters?.hours)) ? String(filters.hours) : 'all',
    percentile: OFFER_PERCENTILES.includes(String(filters?.percentile)) ? String(filters.percentile) : 'all',
  };
}

// Each listing has equal weight. Keep every tie at the nearest-rank cutoff,
// including the minimum when a small sample has fewer than ten listings.
export function filterOffers(rows, mode, filters, now = Date.now() / 1000) {
  const { hours, percentile } = normalizeOfferFilters(filters);
  if (mode === 'recent' && percentile !== 'all') {
    const prices = rows.map(row => row.price).filter(price => Number.isFinite(price) && price >= 0).sort((a, b) => a - b);
    const cap = prices[Math.ceil(prices.length * Number(percentile) / 100) - 1] ?? null;
    return { rows: rows.filter(row => cap !== null && Number.isFinite(row.price) && row.price >= 0 && row.price <= cap), cap };
  }
  if (mode !== 'recent' && hours !== 'all') {
    const cutoff = now - Number(hours) * 3600;
    return { rows: rows.filter(row => Number.isFinite(row.observed) && row.observed > 0 && row.observed >= cutoff), cap: null };
  }
  return { rows: [...rows], cap: null };
}
