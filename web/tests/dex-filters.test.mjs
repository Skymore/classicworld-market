import test from 'node:test';
import assert from 'node:assert/strict';
import { dexHref, categoryPatch, dexTokens, clearAllPatch, pageNumbers } from '../js/lib/dex-filters.js';

const query = (href) => Object.fromEntries(new URL(href, 'http://x').searchParams);

test('links rewrite old names, drop the page and keep 装备 under equipment filters', () => {
  assert.deepEqual(query(dexHref('?kind=item&cat=use&job=1&min_level=30&page=3', { max_level: null, lmax: 40 })),
    { kind: 'item', cat: 'equip', job: 'warrior', lmin: '30', lmax: '40' });
  assert.deepEqual(query(dexHref('?kind=item&cat=use&job=warrior', categoryPatch('use'))), { kind: 'item', cat: 'use' });
  assert.deepEqual(query(dexHref('?kind=item&job=warrior&type=weapon', categoryPatch('equip'))), { kind: 'item', job: 'warrior', type: 'weapon', cat: 'equip' });
  assert.deepEqual(query(dexHref('?kind=item&cat=use&use=potion', { shared: '0' })), { kind: 'item', cat: 'equip', shared: '0' });
  assert.deepEqual(query(dexHref('?kind=mob&lmin=10', { boss: true })), { kind: 'mob', lmin: '10', boss: '1' }, 'monster levels are not equipment');
});

test('tokens come from the normalized page, not the URL', () => {
  const page = {
    kind: 'Item',
    filters: { cat: 'equip', job: 'warrior', shared: false, type: 'weapon', weapon: 140, use: '', lmin: 30, lmax: 40, sort: '' },
    facets: { types: [{ key: 'weapon', names: { zh: '武器', en: 'Weapon' }, count: 3 }], weapons: [{ key: '140', names: { zh: '双手剑', en: 'Two-handed sword' }, count: 2 }] },
  };
  const tokens = dexTokens(page);
  assert.deepEqual(tokens.map((t) => [t.label, t.value]), [['职业', '战士'], ['', '不含通用装备'], ['类型', '武器'], ['武器', '双手剑'], ['等级', '30–40']]);
  assert.deepEqual(dexTokens(page, true)[0], { key: 'job', label: 'Job', value: 'Warrior', patch: { job: null } });
  assert.deepEqual(clearAllPatch(tokens), { job: null, shared: null, type: null, weapon: null, lmin: null, lmax: null });
  assert.equal(dexTokens({ ...page, filters: { ...page.filters, job: '', shared: true, type: '', weapon: null, lmin: 70, lmax: null } })[0].value, '70+');
  const mob = dexTokens({ kind: 'Mob', mob_filters: { lmin: 1, lmax: 10, boss: true }, region: 'victoria', area: '射手村', areas: [{ region: 'victoria', key: '射手村', names: { zh: '射手村', en: 'Henesys' } }] });
  assert.deepEqual(mob.map((t) => t.key), ['level', 'region', 'area', 'boss']);
  assert.deepEqual(mob[1].patch, { region: null, area: null });
  // The map list shows its region and towns as chips; an old area link is a token.
  const areas = [{ region: 'victoria', key: 'Perion', names: { zh: '勇士部落', en: 'Perion' } }];
  assert.deepEqual(dexTokens({ kind: 'Map', town: true, region: 'victoria', area: 'Perion', areas }).map((t) => t.value), ['勇士部落']);
  assert.deepEqual(dexTokens({ kind: 'Mob', region: 'rest', areas: [] }).map((t) => t.value), ['其他']);
  assert.deepEqual(dexTokens({ kind: null, query: '蜗牛' }), [], 'the three-catalogue view has no filters');
});

test('page numbers skip the middle of long lists', () => {
  assert.deepEqual(pageNumbers(1, 2), [1, 2]);
  assert.deepEqual(pageNumbers(1, 50), [1, 2, 3, null, 50]);
  assert.deepEqual(pageNumbers(25, 50), [1, null, 23, 24, 25, 26, 27, null, 50]);
});

test('removing a filter keeps the category the server showed', () => {
  assert.deepEqual(query(dexHref('?kind=item&cat=use&job=1&type=hat', { job: null })), { kind: 'item', cat: 'equip', type: 'hat' });
  assert.deepEqual(query(dexHref('?kind=item&job=16', {})), { kind: 'item' }, 'no pirates');
});
