// The server's push matcher (server/crates/market-web/src/push/matching.rs)
// reads the same fixture. Both must agree with the browser's notification rules.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const module = async name => 'data:text/javascript,' + encodeURIComponent(await readFile(new URL(`../js/lib/${name}.js`, import.meta.url), 'utf8'));
const filters = await module('item-offer-filters'), groups = await module('quote-groups');
const code = (await readFile(new URL('../js/lib/watch-reminders.js', import.meta.url), 'utf8'))
  .replace(/'\.\/item-offer-filters\.js\?v=[^']+'/, JSON.stringify(filters))
  .replace(/'\.\/quote-groups\.js\?v=[^']+'/, JSON.stringify(groups));
const { watchSelection, watchGroups } = await import('data:text/javascript,' + encodeURIComponent(code));
const fixture = JSON.parse(await readFile(new URL('./fixtures/watch-match.json', import.meta.url), 'utf8'));

test('fixture covers every reminder rule the server ports', () => {
  const settings = JSON.stringify(fixture.cases.map(c => c.setting));
  for (const key of ['"cap":150', 'percentile', 'minPrice', '"stock":"known"', '"stock":"unknown"', 'minStock',
    '"equipment":"captured"', '"equipment":"bonus"', '"equipment":"missing"', '"stats"', 'minUpgrades', '"notify":false', '"groups":[]'])
    assert.ok(settings.includes(key), key);
  assert.ok(fixture.cases.some(c => !('groups' in c.setting)), 'legacy settings without groups');
  assert.ok(fixture.grouped_listings.some(row => row.invalidated_at), 'invalidated offers');
});

for (const c of fixture.cases) {
  test(c.name, () => {
    const reference = { rows: fixture.grouped_listings, percentiles: c.percentile_caps ?? fixture.percentile_caps, baseStats: fixture.base_stats };
    const found = watchSelection(fixture.grouped_listings, c.item_id, c.setting, reference, 'notify').rows.map(row => row.id);
    assert.deepEqual(found, c.expected);
    assert.equal(watchGroups(c.setting).some(g => g.notify), c.notifies);
  });
}
