// Navigation tabs remember each section's page (filters in the URL), scroll
// position and loaded rows; the site search keeps its text and recent searches.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Date.now() / 1000;
const names = { zh: '宠物装备移动速度卷轴', en: 'Pet Equip Speed Scroll' };
const products = Array.from({ length: 120 }, (_, i) => ({
  item_id: 2000100 + i, name_zh: `药水 ${i + 1}`, name_en: `Potion ${i + 1}`, category: '消耗品',
  sales_window: 200 - i, sales_10d: 200 - i, listings: 2, typical: 8000 + i, low: 7000,
  change_window: 3, last_seen: now - i, last_sale_at: now - i, trend: [],
}));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/crafting/prices') data = { prices: [] };
    if (url.pathname === '/api/v1/market') data = { as_of: now, products };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all' };
    if (url.pathname === '/api/v1/dex/dropped-items') data = { item_ids: [] };
    if (url.pathname === '/api/v1/sales/recent') data = { generated_at: now, sales: [] };
    if (url.pathname === '/api/v1/dex/counts') data = { mobs: 1, maps: 1 };
    if (url.pathname === '/api/v1/catalog/page') {
      const target = new URL(url.searchParams.get('url'), 'http://localhost');
      data = { kind: 'search', page: { query: target.searchParams.get('q') || '', kind: target.searchParams.get('kind'), offset: 0, region: '', area: '', areas: [], filters: {}, items: { rows: Array.from({ length: 7 }, (_, i) => ({ id: 2048000 + i, names })), more: false, total: 7 }, mobs: { rows: [], more: false }, maps: { rows: [], more: false } } };
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
const nav = (page, phone, key) => page.locator(`${phone ? '.dock' : '.dnav'} [data-nav-key=${key}]`).click();
const rows = (page, phone) => page.locator(phone ? '.react-price-mobile [data-item-row]' : '.react-price-desktop tr[data-item-row]');
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const phone of [true, false]) {
    const page = await browser.newPage(phone
      ? { viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('theme', 'light'); });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = phone ? 'phone' : 'desktop';

    // Filters live in the URL: a tab switch and back keeps them.
    await page.goto(origin + '/?q=%E8%8D%AF%E6%B0%B4&sort=price');
    await rows(page, phone).first().waitFor();
    await nav(page, phone, 'watch');
    await page.waitForURL(/\/watch$/);
    await nav(page, phone, 'home');
    await page.waitForURL(/\?q=/);
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('q'), '药水', `${label}: price search kept`);
    assert.equal(params.get('sort'), 'price', `${label}: sort kept`);

    // Scroll position and loaded rows come back with the page.
    await page.goto(origin + '/');
    await rows(page, phone).first().waitFor();
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1000); await page.waitForTimeout(200); }
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => scrollY);
    const loaded = await rows(page, phone).count();
    assert.ok(before > 1500, `${label}: scrolled down (${before})`);
    await nav(page, phone, 'dex');
    await page.waitForURL(/\/search\?kind=item/);
    assert.ok(await page.evaluate(() => scrollY) < 50, `${label}: a new section starts at the top`);
    await nav(page, phone, 'home');
    await page.waitForFunction(y => Math.abs(scrollY - y) < 30, before, { timeout: 4000 });
    assert.ok(await rows(page, phone).count() >= loaded, `${label}: loaded rows kept`);
    // Back/forward also restore.
    await nav(page, phone, 'dex');
    await page.waitForURL(/\/search/);
    await page.goBack();
    await page.waitForFunction(y => Math.abs(scrollY - y) < 30, before, { timeout: 4000 });
    // The active tab scrolls back to the top instead of resetting the page.
    await page.waitForTimeout(2600);
    await nav(page, phone, 'home');
    await page.waitForFunction(() => scrollY < 5, null, { timeout: 4000 });

    // The site search keeps its text and remembers recent searches.
    const hero = page.locator('.hero input[name=q]');
    await hero.fill('卷轴');
    await hero.press('Enter');
    await page.waitForURL(/\/search\?q=/);
    await nav(page, phone, 'home');
    await page.waitForURL(u => new URL(u).pathname === '/');
    assert.equal(await hero.inputValue(), '卷轴', `${label}: search text kept`);
    await page.locator('.hero .finder-clear').click();
    assert.equal(await hero.inputValue(), '', `${label}: clear button`);
    const recent = page.locator('.hero .quick-recent-row');
    await recent.first().waitFor();
    assert.equal((await recent.first().innerText()).trim(), '卷轴', `${label}: recent search listed`);
    await recent.first().click();
    assert.equal(await hero.inputValue(), '卷轴', `${label}: recent search fills the box`);
    await page.locator('.hero .quick-row').first().waitFor();
    await page.locator('.hero .finder-clear').click();
    await page.locator('.hero .quick-recent-remove').first().click();
    assert.equal(await page.locator('.hero .quick-recent-row').count(), 0, `${label}: recent search removed`);

    assert.deepEqual(errors, [], `${label}: no page errors`);
    console.log(`PASS ${label}: tabs keep filters, scroll and rows; back restores; search text and recent searches`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
