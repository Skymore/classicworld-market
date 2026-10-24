import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../js/lib/item-offer-filters.js', import.meta.url), 'utf8');
const { normalizeOfferFilters, filterOffers, offerFilterTokens, clearOfferFilter } = await import('data:text/javascript,' + encodeURIComponent(code));
const now = 1800000000;
const rows = [
  { key: 'old-min', price: 10, observed: now - 86401, stock: 2 },
  { key: 'boundary', price: 20, observed: now - 86400, stock: NaN },
  { key: 'fresh-tie', price: 20, observed: now - 60, stock: 5, isEquipment: true, hasStats: true, bonus: true },
  { key: 'new-expensive', price: 50, observed: now, stock: 1, isEquipment: true, hasStats: false },
  { key: 'unknown-time', price: 100, observed: null, stock: NaN },
];
const ids = result => result.rows.map(row => row.key);

test('time uses wall clock and includes cutoff; filters combine independently of sorting', () => {
  assert.deepEqual(ids(filterOffers(rows, 'price', { hours: '24' }, now)), ['boundary', 'fresh-tie', 'new-expensive']);
  for (const mode of ['price', 'recent']) {
    assert.deepEqual(ids(filterOffers(rows, mode, { hours: '1', percentile: '25' }, now)), ['fresh-tie']);
  }
  assert.equal(filterOffers(rows, 'recent', { hours: '1' }, now + 3601).rows.length, 0);
});

test('percentile includes all cutoff ties and stays based on all item listings', () => {
  const selected = filterOffers(rows, 'recent', { percentile: '25' }, now);
  assert.equal(selected.cap, 20);
  assert.deepEqual(ids(selected), ['old-min', 'boundary', 'fresh-tie']);
  assert.equal(filterOffers(rows, 'recent', { percentile: '25', minPrice: 15, hours: '1' }, now).cap, 20);
  assert.equal(filterOffers(rows.slice(0, 1), 'recent', { percentile: '10' }, now).rows.length, 1);
  assert.deepEqual(filterOffers([], 'recent', { percentile: '10' }, now), { rows: [], cap: null });
});

test('price bounds include endpoints, preserve zero and fractions, and normalize reversed bounds', () => {
  assert.deepEqual(ids(filterOffers(rows, 'price', { minPrice: 20, maxPrice: 50 }, now)), ['boundary', 'fresh-tie', 'new-expensive']);
  const values = [NaN, Infinity, -1, 0, 0.25, 0.5].map(price => ({ price }));
  assert.deepEqual(filterOffers(values, 'recent', { minPrice: 0, maxPrice: 0.25 }).rows.map(row => row.price), [0, 0.25]);
  const normalized = normalizeOfferFilters({ minPrice: '50', maxPrice: '20' });
  assert.equal(normalized.minPrice, 20); assert.equal(normalized.maxPrice, 50);
});

test('stock and captured equipment conditions combine without guessing missing data', () => {
  assert.deepEqual(ids(filterOffers(rows, 'price', { stock: 'unknown' }, now)), ['boundary', 'unknown-time']);
  assert.deepEqual(ids(filterOffers(rows, 'price', { stock: 'known', minStock: 2 }, now)), ['old-min', 'fresh-tie']);
  assert.equal(filterOffers(rows, 'price', { stock: 'unknown', minStock: 1 }, now).rows.length, 0);
  for (const equipment of ['captured', 'bonus']) assert.deepEqual(ids(filterOffers(rows, 'recent', { equipment, minStock: 5 }, now)), ['fresh-tie']);
  assert.deepEqual(ids(filterOffers(rows, 'recent', { equipment: 'missing' }, now)), ['new-expensive']);
});

test('invalid and legacy preferences normalize safely and excluded filters have no effect', () => {
  const empty = normalizeOfferFilters();
  for (const value of [null, {}, [], 'bad', { hours: '-1', percentile: 0, minPrice: -5, maxPrice: Infinity, minStock: NaN }]) assert.deepEqual(normalizeOfferFilters(value), empty);
  const legacy = normalizeOfferFilters({ hours: 24, percentile: 50, channels: ['1'], room: '2', shop: 'old' });
  assert.equal(legacy.hours, '24'); assert.equal(legacy.percentile, '50');
  assert.equal('channels' in legacy, false); assert.equal('room' in legacy, false); assert.equal('shop' in legacy, false);
});

test('active condition chips count groups and remove only the chosen condition', () => {
  const filters = { hours: '24', percentile: '50', minPrice: 10, maxPrice: 50, stock: 'known', minStock: 2, equipment: 'bonus' };
  assert.deepEqual(offerFilterTokens(filters).map(token => token.key), ['hours', 'percentile', 'price', 'stock', 'equipment']);
  const cleared = clearOfferFilter(filters, 'price');
  assert.equal(cleared.minPrice, null); assert.equal(cleared.maxPrice, null); assert.equal(cleared.hours, '24'); assert.equal(cleared.minStock, 2);
  assert.equal(clearOfferFilter(filters, 'stock').minStock, null);
  assert.equal(clearOfferFilter(filters, 'stock').stock, 'all');
  assert.deepEqual(clearOfferFilter(filters, 'all'), normalizeOfferFilters());
  assert.equal(offerFilterTokens(filters, true)[1].label, 'Lowest 50%');
  assert.equal(filters.minPrice, 10);
});
