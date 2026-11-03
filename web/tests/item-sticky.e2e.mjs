// Exercise the real item component, scroll boundaries, responsive headers and SSE.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = process.env.ITEM_STICKY_SCREENSHOTS;
if (output) await mkdir(output, { recursive: true });
const streams = new Set(), now = Date.now() / 1000;
let generation = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all' };
    if (url.pathname === '/api/v1/crafting/prices') data = { prices: [] };
    if (url.pathname === '/api/v1/catalog/page') {
      const target = new URL(url.searchParams.get('url'), 'http://localhost');
      const id = Number(target.pathname.split('/').at(-1));
      data = { kind: 'item', page: {
        item: { id, name_zh: '套服敏捷卷轴：高级', name_en: 'Overall Armor DEX Scroll: Greater with a long item name', category: '消耗品', icon_url: '/web/img/favicon.svg' },
        unit: id === 2 ? 'set' : 'each',
        stats: id === 2 ? null : { typical: 20000 + generation * 5000, typical_low: 15000, typical_high: 24000, sales_24h: 1340, listings_count: 1854, shops_count: 900 },
        droppers: [], npc_offers: [], npc_sell: 1,
        market: { as_of: now + generation, base_stats: [], days: [], sale_points: [], sales: [],
          listings: Array.from({ length: 18 }, (_, i) => ({ shop: 'Test shop ' + i, shop_key: String(i), channel: i + 1, room: 1, stock: 3, unit_price: 1500 + i * 100, seen_at: now, bundle: 1, slot: i })) },
      } };
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
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const [width, language, theme] of [[390, 'zh', 'light'], [320, 'en', 'dark'], [1280, 'zh', 'dark']]) {
    generation = 0;
    const page = await browser.newPage({ viewport: { width, height: 760 }, isMobile: width < 641, hasTouch: width < 641 });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    await page.goto(`${origin}/item/1?lang=${language}&hours=all`);
    const head = page.locator('[data-market=head]'), summary = page.locator('.item-summary');
    await head.waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.liveConnection === 'connected');
    assert.equal(await summary.count(), 0, 'no summary while the full details are visible');
    const boundary = await page.evaluate(() => ({ headBottom: document.querySelector('[data-market=head]').getBoundingClientRect().bottom + scrollY, top: document.querySelector('.dhead').getBoundingClientRect().height, bodyTop: document.querySelector('.ibox').getBoundingClientRect().top + scrollY, height: document.documentElement.scrollHeight }));
    await page.evaluate(y => scrollTo(0, y), boundary.headBottom - boundary.top - 2);
    await frames(page);
    assert.equal(await summary.count(), 0, 'the full header must leave the viewport first');
    await page.evaluate(y => scrollTo(0, y), boundary.headBottom - boundary.top + 2);
    await summary.waitFor();
    const geometry = await summary.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, height: rect.height, width: rect.width, nameHeight: node.querySelector('.item-summary-name').getBoundingClientRect().height, bodyTop: document.querySelector('.ibox').getBoundingClientRect().top + scrollY, documentHeight: document.documentElement.scrollHeight };
    });
    assert.equal(geometry.top, boundary.top, 'summary sticks below desktop navigation or at the phone viewport top');
    assert.equal(geometry.height, 46, 'one compact row');
    assert(geometry.nameHeight < 24, 'the name never wraps');
    assert.equal(geometry.bodyTop, boundary.bodyTop, 'showing the summary never moves the content');
    assert.equal(geometry.documentHeight, boundary.height, 'showing the summary never changes scroll height');
    assert.match(await summary.locator('.item-summary-price').textContent(), /^(2万|20K)$/);
    assert.equal(await summary.locator('.slot img').count(), 1);
    if (width === 320) assert(await summary.locator('.item-summary-name').evaluate(node => node.scrollWidth > node.clientWidth), 'long English name is truncated');
    await page.evaluate(() => scrollBy(0, 600));
    await frames(page);
    assert.equal((await summary.boundingBox()).y, boundary.top, 'the summary remains stuck while reading offers');
    const scroll = await page.evaluate(() => scrollY);
    const refreshed = page.waitForResponse(response => response.url().includes('/api/v1/catalog/page'));
    generation++;
    for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
    await (await refreshed).finished();
    await page.waitForFunction(() => document.querySelector('.item-summary-price')?.textContent.match(/^(2\.5万|25K)$/));
    assert.equal(await page.evaluate(() => scrollY), scroll, 'SSE refresh keeps the reading position');
    if (output) await page.screenshot({ path: path.join(output, `sticky-${width}.png`) });
    if (width === 390) {
      await page.setViewportSize({ width: 844, height: 390 });
      await frames(page);
      assert.equal((await summary.boundingBox()).y, 62, 'rotation keeps the summary below navigation');
      await page.setViewportSize({ width, height: 760 });
      await frames(page);
      assert.equal((await summary.boundingBox()).y, 0);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await summary.waitFor({ state: 'detached' });
    assert(await head.isVisible(), 'scrolling back restores the full header');
    await page.locator('[data-star]').click();
    assert.equal(await page.locator('[data-star]').getAttribute('aria-pressed'), 'true', 'watch still works after restoring the full header');
    await page.goto(`${origin}/item/2?lang=${language}&hours=all`);
    await head.waitFor();
    assert.equal(await summary.count(), 0, 'a different item starts with its own full details');
    await head.evaluate(node => scrollTo(0, node.getBoundingClientRect().bottom + scrollY + 100));
    await summary.waitFor();
    assert.match(await summary.locator('.item-summary-price').textContent(), /—.*\/(组|set)/, 'no-price and per-set states stay compact');
    await page.locator('[data-nav-key=watch]:visible').click();
    await page.locator('.watch-page').waitFor();
    assert.equal(await summary.count(), 0, 'leaving the item removes its summary');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px ${language} ${theme}: scroll boundary, single row, no layout jump, SSE, resize, restore and navigation`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
