// Exercise native React crafting, market refreshes and shareable list filters.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.CRAFTING_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const catalog = JSON.parse(await readFile(path.join(root, 'data/crafting.json')));
const bow = catalog.recipes.find(row => row.item_id === 1452003);
const prices = bow.ingredients.map((row, i) => ({ item_id: row.item_id, market_price: [300, 2300, 600, 250][i], name_en: catalog.items[row.item_id].name_en }));
prices.push({ item_id: bow.item_id, market_price: 8000, name_en: 'Battle Bow' });
const now = Date.now() / 1000;
let priceReads = 0;
const streams = new Set();
const products = [1452003, 2000000].map(item_id => ({ item_id, name_en: item_id === 1452003 ? 'Battle Bow' : 'Red Potion', category: item_id === 1452003 ? '装备' : '消耗品', sales_window: 15, typical: 8000, low: 7000, last_seen: now, trend: [] }));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/crafting/prices') { priceReads++; data = { as_of: now, prices }; }
    if (url.pathname === '/api/v1/market') data = { as_of: now, products };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all' };
    if (url.pathname === '/api/v1/sales/recent') data = { generated_at: now, sales: [] };
    if (url.pathname === '/api/v1/catalog/page') {
      const target = new URL(url.searchParams.get('url'), 'http://localhost');
      const id = Number(target.pathname.split('/').at(-1));
      data = { kind: 'item', page: { item: { id, name_en: catalog.items[id]?.name_en || 'Red Potion', category: '装备' }, stats: null, droppers: [], npc_offers: [], npc_sell: null, market: { as_of: now, base_stats: [], days: [], sale_points: [], listings: [], sales: [] } } };
    }
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data));
  }
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/item/1452003?lang=en');
    const total = page.locator('[data-craft-total]');
    await page.waitForFunction(() => document.querySelector('[data-craft-total]')?.getAttribute('title') === '17150');
    await page.locator('[data-craft-batches]').fill('2');
    await page.waitForFunction(() => document.querySelector('[data-craft-total]')?.getAttribute('title') === '34300');
    const owned = page.locator(`[data-craft-price="${bow.ingredients[0].item_id}"]`);
    await owned.fill('0');
    await page.waitForFunction(() => document.querySelector('[data-craft-total]')?.getAttribute('title') === '30100');
    await owned.focus();
    const before = priceReads;
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/v1/crafting/prices'));
    for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
    await (await refreshed).finished();
    await page.waitForFunction(() => document.querySelector('[data-craft-batches]')?.value === '2');
    assert(priceReads > before);
    assert.equal(await owned.inputValue(), '0', 'SSE preserves manual prices');
    assert(await owned.evaluate(node => node === document.activeElement), 'SSE preserves the active input');
    assert.equal(await total.getAttribute('title'), '30100');
    await page.locator('[data-craft-catalyst]').check();
    await page.waitForFunction(() => document.querySelector('[data-craft-total]')?.getAttribute('title') === '');
    assert.equal(await page.locator('.craft-comparison').count(), 0, 'missing catalyst price suppresses savings');
    await page.locator('[data-craft-catalyst]').uncheck();
    await page.locator('[data-craft-mode]').selectOption('raw');
    await page.locator('.craft-order').waitFor();
    await page.locator('.craft-order summary').click();
    assert(await page.locator('.craft-order li').count() > 1, 'raw mode shows intermediate craft order');
    await page.locator('[data-craft-batches]').fill('0');
    await page.locator('[data-craft-result]').waitFor({ state: 'hidden' });
    await page.locator('[data-craft-batches]').fill('1');
    await page.locator('[data-craft-result]').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'craft controls fit phone width');
    await page.goto(origin + '/prices?craft=1&few=0&lang=en');
    await page.locator('.react-prices').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-craft-only]')?.getAttribute('aria-pressed') === 'true');
    const list = page.locator(mobile ? '.react-price-mobile[data-list="all"]' : '.react-price-desktop tbody[data-list="all"]');
    await list.locator('a[href*="/item/1452003"]').first().waitFor();
    assert.equal(await list.locator('a[href*="/item/2000000"]').count(), 0);
    await page.reload();
    await page.locator('.craft-label:visible').first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get('craft'), '1');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'}: exact cost, owned inputs, missing quotes, raw route, SSE state and persistent craftable filter`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
