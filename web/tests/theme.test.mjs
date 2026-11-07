import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// boot.js: theme and language follow the system / browser. An explicit choice
// (`uiTheme`, `uiLang`) wins; `?theme=` / `?lang=` hold for the tab
// (sessionStorage); older saved `theme` / `lang` values are ignored.
const boot = await readFile(new URL('../js/lib/boot.js', import.meta.url), 'utf8');
function start({ saved, legacy, query = '', system = 'light', blocked = false, accountTheme, session, languages = ['zh-CN'], savedLang, hour = 12, ssrLang } = {}) {
  const values = new Map(saved === undefined ? [] : [['uiTheme', saved]]);
  if (legacy !== undefined) values.set('theme', legacy);
  if (savedLang !== undefined) values.set('uiLang', savedLang);
  if (accountTheme !== undefined) {
    values.set('cwm.preferences.account.v1', 'public-test-id');
    values.set('cwm.user-data.v1.public-test-id', JSON.stringify({ values: { uiTheme: accountTheme } }));
  }
  const tab = new Map(Object.entries(session || {}));
  const html = { dataset: ssrLang ? { lang: ssrLang } : {} };
  const storage = map => ({
    getItem(key) { if (blocked) throw Error('storage denied'); return map.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw Error('storage denied'); map.set(key, value); },
  });
  class FixedDate extends Date { getHours() { return hour; } }
  vm.runInNewContext(boot, {
    document: { documentElement: html, querySelector: () => ({ setAttribute() {} }), addEventListener() {} }, location: { search: query },
    URLSearchParams, localStorage: storage(values), sessionStorage: storage(tab), innerWidth: 375, Date: FixedDate,
    navigator: { languages },
    matchMedia: query => ({ matches: system === 'none' ? false : query.includes(system) }),
  });
  return { theme: html.dataset.theme, lang: html.dataset.lang, htmlLang: html.lang, saved: values.get('uiTheme'), tab: Object.fromEntries(tab) };
}

test('an explicit theme choice wins over the system preference', () => {
  for (const theme of ['light', 'dark']) {
    assert.equal(start({ saved: theme, system: theme === 'light' ? 'dark' : 'light' }).theme, theme);
  }
});

test('older saved themes no longer override the system', () => {
  assert.equal(start({ legacy: 'dark', system: 'light' }).theme, 'light');
  assert.equal(start({ legacy: 'light', system: 'dark' }).theme, 'dark');
});

test('shared-link themes hold for the tab without becoming a saved choice', () => {
  for (const theme of ['light', 'dark']) {
    const page = start({ saved: 'other', query: '?theme=' + theme });
    assert.equal(page.theme, theme);
    assert.equal(page.saved, 'other');
    assert.equal(page.tab['cwm.view.theme'], theme);
  }
  // A later page in the same tab without ?theme= keeps it.
  assert.equal(start({ system: 'light', session: { 'cwm.view.theme': 'dark' } }).theme, 'dark');
});

test('invalid URL values preserve the saved theme', () => {
  assert.equal(start({ saved: 'dark', query: '?theme=invalid' }).theme, 'dark');
});

test('account themes paint from the account cache', () => {
  assert.equal(start({ saved: 'light', accountTheme: 'dark' }).theme, 'dark');
  assert.equal(start({ saved: 'dark', accountTheme: 'light' }).theme, 'light');
  assert.equal(start({ saved: 'dark', accountTheme: 'invalid', system: 'light' }).theme, 'light');
  assert.equal(start({ accountTheme: 'dark', query: '?theme=light' }).theme, 'light');
});

test('missing or corrupt saved preferences follow the system', () => {
  for (const system of ['light', 'dark']) {
    for (const saved of [undefined, '', 'invalid']) assert.equal(start({ saved, system }).theme, system);
  }
});

test('a system without a colour preference follows the local time', () => {
  assert.equal(start({ system: 'none', hour: 12 }).theme, 'light');
  assert.equal(start({ system: 'none', hour: 22 }).theme, 'dark');
  assert.equal(start({ system: 'none', hour: 5 }).theme, 'dark');
});

test('blocked storage still permits system and URL themes', () => {
  assert.equal(start({ blocked: true, system: 'dark' }).theme, 'dark');
  assert.equal(start({ blocked: true, system: 'dark', query: '?theme=light' }).theme, 'light');
});

test('the language follows the browser', () => {
  assert.deepEqual([start({ languages: ['ko-KR', 'en'] }).lang, start({ languages: ['ko-KR'] }).htmlLang], ['ko', 'ko']);
  assert.equal(start({ languages: ['en-US'] }).lang, 'en');
  assert.equal(start({ languages: ['zh-TW'] }).htmlLang, 'zh-CN');
  assert.equal(start({ languages: ['fr-FR', 'ko'] }).lang, 'ko');
  assert.equal(start({ languages: ['ja-JP'] }).lang, 'en');
  // A server-rendered page no longer pins its own language.
  assert.equal(start({ languages: ['ko-KR'], ssrLang: 'zh' }).lang, 'ko');
});

test('URL and explicit language choices win over the browser', () => {
  assert.equal(start({ languages: ['ko-KR'], savedLang: 'zh' }).lang, 'zh');
  const shared = start({ languages: ['zh-CN'], query: '?lang=ko' });
  assert.equal(shared.lang, 'ko');
  assert.equal(shared.tab['cwm.view.lang'], 'ko');
  assert.equal(start({ languages: ['zh-CN'], query: '?lang=xx' }).lang, 'zh');
});

test('no browser language keeps the page language until the IP guess', () => {
  assert.equal(start({ languages: [], ssrLang: 'en' }).lang, 'en');
  assert.equal(start({ languages: [] }).lang, 'zh');
});

test('every static shell initializes its theme before stylesheets', async () => {
  for (const name of ['index.html', 'collect/index.html', 'download.html']) {
    const html = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    const script = html.search(/<script src="\/web\/js\/lib\/boot\.js(?:\?[^"]*)?"><\/script>/);
    assert(script >= 0 && script < html.indexOf('<link rel="stylesheet"'), name);
  }
});
