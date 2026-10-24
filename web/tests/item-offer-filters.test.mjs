import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../js/lib/item-offer-filters.js', import.meta.url), 'utf8');
const { normalizeOfferFilters, filterOffers } = await import('data:text/javascript,' + encodeURIComponent(code));
const now = 1800000000;
const rows = [
  { key: 'old-min', price: 10, observed: now - 86401 },
  { key: 'boundary', price: 20, observed: now - 86400 },
  { key: 'fresh-tie', price: 20, observed: now - 60 },
  { key: 'new-expensive', price: 50, observed: now },
  { key: 'unknown-time', price: 100, observed: null },
];

test('time cutoff uses wall time, includes the boundary and excludes unknown times', () => {
  assert.deepEqual(filterOffers(rows, 'price', { hours: '24' }, now).rows.map(row => row.key), ['boundary', 'fresh-tie', 'new-expensive']);
  assert.deepEqual(filterOffers(rows, 'price', { hours: '1' }, now).rows.map(row => row.key), ['fresh-tie', 'new-expensive']);
  assert.equal(filterOffers(rows, 'price', { hours: 'all' }, now).rows.length, 5);
  assert.equal(filterOffers(rows, 'price', { hours: '1' }, now + 3601).rows.length, 0);
});

test('percentile is computed across listing prices and retains all cutoff ties', () => {
  const selected = filterOffers(rows, 'recent', { percentile: '25' }, now);
  assert.equal(selected.cap, 20);
  assert.deepEqual(selected.rows.map(row => row.key), ['old-min', 'boundary', 'fresh-tie']);
  assert.equal(filterOffers(rows, 'recent', { percentile: '10' }, now).cap, 10);
  assert.equal(filterOffers(rows.slice(0, 1), 'recent', { percentile: '10' }, now).rows.length, 1);
  assert.deepEqual(filterOffers([], 'recent', { percentile: '10' }, now), { rows: [], cap: null });
});

test('only the visible sort mode filter applies, and clearing restores all offers', () => {
  const filters = { hours: '1', percentile: '25' };
  assert.equal(filterOffers(rows, 'price', filters, now).rows.length, 2);
  assert.equal(filterOffers(rows, 'recent', filters, now).rows.length, 3);
  assert.equal(filterOffers(rows, 'recent', { ...filters, percentile: 'all' }, now).rows.length, 5);
  assert.equal(filterOffers(rows, 'price', { ...filters, hours: 'all' }, now).rows.length, 5);
  assert.equal(rows[0].key, 'old-min');
});

test('invalid preferences reset safely; percentiles ignore invalid prices and retain fractional prices', () => {
  for (const value of [null, {}, [], 'bad', { hours: '-1', percentile: 0 }]) {
    assert.deepEqual(normalizeOfferFilters(value), { hours: 'all', percentile: 'all' });
  }
  assert.deepEqual(normalizeOfferFilters({ hours: 24, percentile: 50 }), { hours: '24', percentile: '50' });
  const values = [NaN, Infinity, -1, 0, 0.25, 0.5].map(price => ({ price }));
  assert.deepEqual(filterOffers(values, 'recent', { percentile: '50' }).rows.map(row => row.price), [0, 0.25]);
});
