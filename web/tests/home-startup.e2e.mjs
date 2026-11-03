// Public home remains usable while identity and account synchronization are held.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const streams = new Set(), identities = new Set(), syncs = new Set(), markets = new Set();
const requests = [], now = Date.now() / 1000;
let holdIdentity = true, holdSync = true, holdMarket = true;
const profile = { signed_in: true, public_id: 'startup-account', csrf: 'fixture', nickname: '测试账号', stats: {} };
const records = [
  { kind: 'pref', key: 'theme', value: 'dark', version: 1 },
  { kind: 'pref', key: 'lang', value: 'zh', version: 1 },
  { kind: 'watch', key: '4010001', value: { position: 0, cap: null, notify: false }, version: 1 },
];
const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  requests.push(url.pathname + url.search);
  if (['/api/v1/events', '/api/v1/account/events'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/account') {
    if (holdIdentity) { identities.add(res); return; }
    return json(res, profile);
  }
  if (url.pathname === '/api/v1/account/data') {
    if (holdSync) { syncs.add(res); return; }
    return json(res, { records });
  }
  if (url.pathname === '/api/v1/market/period-default') return json(res, { default_hours: '72' });
  if (url.pathname === '/api/v1/market') {
    const reply = () => json(res, { as_of: now, products: [
      { item_id: 2000000, name_zh: '红色药水', name_en: 'Red Potion', category: '消耗品', sales_window: 2, sales_10d: 2, typical: 50, low: 45, last_seen: now, last_sale_at: now, trend: [] },
    ] });
    if (holdMarket) { markets.add(reply); return; }
    return reply();
  }
  if (url.pathname === '/api/v1/dex/counts') return json(res, { mobs: 1, maps: 1 });
  if (url.pathname === '/api/v1/catalog/page') return json(res, { kind: 'search', page: {
    query: '药水', kind: null, offset: 0, areas: [], filters: {}, region: '', area: '',
    items: { rows: Array.from({ length: 7 }, (_, i) => ({ id: 2000000 + i, names: { zh: `药水 ${i}`, en: `Potion ${i}` } })), more: false },
    mobs: { rows: [], more: false }, maps: { rows: [], more: false },
  } });
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'light'); localStorage.setItem('lang', 'en');
    localStorage.setItem('watchlist', '[2000002]');
    localStorage.setItem('cwm.preferences.account.v1', 'startup-account');
    localStorage.setItem('cwm.user-data.v1.startup-account', JSON.stringify({ values: { theme: 'dark', lang: 'zh', watchlist: '[4010001]' }, records: [], pending: {}, conflicts: {} }));
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.hero input[name=q]').waitFor({ timeout: 3000 });
  await page.locator('main .react-status').first().waitFor({ timeout: 3000 });
  assert.equal(await page.locator('main [data-item-row]').count(), 0, 'the hero paints while the market payload is still loading');
  holdMarket = false;
  for (const reply of markets) reply();
  markets.clear();
  await page.locator('main a[href^="/item/2000000"]').first().waitFor({ timeout: 3000 });
  assert.equal(holdIdentity, true, 'home and its price table render before the account response');
  assert(identities.size > 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN', 'cached account language wins over guest language');
  assert(await page.locator('[data-theme-toggle]:visible').isDisabled());
  assert(await page.locator('[data-period]').isDisabled());
  assert(!requests.some(url => url.startsWith('/api/v1/watchlist/listings')), 'do not start guest watch feeds before identity');

  const input = page.locator('.hero input[name=q]');
  await input.fill('药水');
  await page.locator('.hero .quick-row').last().waitFor();
  assert.equal(await page.locator('.hero .quick-row').count(), 6);
  assert(await page.locator('.hero .quick-more').isVisible());
  await input.evaluate(node => { window.startupInput = node; });
  holdIdentity = false;
  for (const response of identities) json(response, profile);
  identities.clear();
  await page.waitForFunction(() => globalThis.cwmUserData?.getSyncState().signed_in);
  assert(await page.locator('[data-theme-toggle]:visible').isDisabled(), 'account sync is still pending');
  assert(!requests.some(url => url.startsWith('/api/v1/watchlist/listings')));
  assert.equal(await input.inputValue(), '药水');
  const watchRequest = page.waitForRequest(req => req.url().includes('/api/v1/watchlist/listings'));
  holdSync = false;
  for (const response of syncs) json(response, { records });
  syncs.clear();
  await page.waitForFunction(() => !document.querySelector('[data-theme-toggle]').disabled);
  assert(await input.evaluate(node => node === window.startupInput && node === document.activeElement), 'account completion preserves the search DOM and focus');
  assert.equal(await input.inputValue(), '药水');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('theme')), 'light', 'guest theme stays separate');
  assert.equal(requests.filter(url => url === '/api/v1/account').length, 1, 'startup identity is reused by the account query');
  await watchRequest;
  assert(requests.some(url => url.includes('/api/v1/watchlist/listings') && url.includes('4010001')));
  assert(!requests.some(url => url.includes('/api/v1/watchlist/listings') && url.includes('2000002')));
  assert(await page.evaluate(() => {
    const paths = [...document.querySelectorAll('link[rel=stylesheet]')].map(link => link.href);
    return new Set(paths).size === paths.length;
  }), 'bootstrap reuses styles already loaded by HTML');
  await page.locator('.hero .quick-more').click();
  await page.locator('[data-react-catalogue=search]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('q'), '药水');
  assert.deepEqual(errors, []);
  console.log('PASS home startup: the hero paints before the market payload; held identity/sync do not block search or the price table; cached preferences, isolated watches, one account request, stable input and unique styles');
} finally {
  await browser.close();
  for (const response of [...streams, ...identities, ...syncs]) response.end();
  for (const reply of markets) reply();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
