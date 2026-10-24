import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const boot = await readFile(new URL('../js/lib/boot.js', import.meta.url), 'utf8');
function start({ saved, query = '', system = 'light', blocked = false } = {}) {
  const values = new Map(saved === undefined ? [] : [['theme', saved]]);
  const html = { dataset: {} };
  const storage = {
    getItem(key) { if (blocked) throw Error('storage denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw Error('storage denied'); values.set(key, value); },
  };
  vm.runInNewContext(boot, {
    document: { documentElement: html }, location: { search: query },
    URLSearchParams, localStorage: storage, innerWidth: 375,
    matchMedia: () => ({ matches: system === 'dark' }),
  });
  return { theme: html.dataset.theme, saved: values.get('theme') };
}

test('saved theme wins over the system preference', () => {
  for (const theme of ['light', 'dark']) {
    assert.equal(start({ saved: theme, system: theme === 'light' ? 'dark' : 'light' }).theme, theme);
  }
});

test('valid shared-link themes are applied and remembered before modules load', () => {
  for (const theme of ['light', 'dark']) {
    assert.deepEqual(start({ saved: 'other', query: '?theme=' + theme }), { theme, saved: theme });
  }
});

test('invalid URL values preserve the saved theme', () => {
  assert.equal(start({ saved: 'dark', query: '?theme=invalid' }).theme, 'dark');
});

test('missing or corrupt saved preferences follow the system', () => {
  for (const system of ['light', 'dark']) {
    for (const saved of [undefined, '', 'invalid']) assert.equal(start({ saved, system }).theme, system);
  }
});

test('blocked storage still permits system and URL themes', () => {
  assert.equal(start({ blocked: true, system: 'dark' }).theme, 'dark');
  assert.equal(start({ blocked: true, system: 'dark', query: '?theme=light' }).theme, 'light');
});

test('every static shell initializes its theme before stylesheets', async () => {
  for (const name of ['index.html', 'collect/index.html', 'download.html']) {
    const html = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    const script = html.indexOf('<script src="/web/js/lib/boot.js"></script>');
    assert(script >= 0 && script < html.indexOf('<link rel="stylesheet"'), name);
  }
});
