import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../js/lib/search.js', import.meta.url), 'utf8');
const { compileSearch, searchText, searchPatterns } = await import('data:text/javascript,' + encodeURIComponent(code));
const cases = JSON.parse(await readFile(new URL('./fixtures/search-cases.json', import.meta.url), 'utf8'));

for (const item of cases) test(`keywords, aliases and literal punctuation: ${item.item_id}`, () => {
  const text = searchText(item);
  for (const query of item.queries) assert.equal(compileSearch(query)(text), true, query);
  for (const query of item.misses) assert.equal(compileSearch(query)(text), false, query);
});

test('duplicate keywords compile once and input metacharacters stay literal', () => {
  assert.deepEqual(searchPatterns('宠物 宠物 移速'), searchPatterns('宠物 移动速度'));
  const text = searchText({ name_zh: '[特殊] 卷轴50%_a\\b.*', item_id: 2000000 });
  for (const query of ['[特殊]', '50%', '_a\\b', '.*']) assert.equal(compileSearch(query)(text), true, query);
});
