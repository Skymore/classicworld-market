// The home page holds the price table: 20 rows first, 20 more near the end, old /prices links.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const screenshots = process.env.HOME_PRICES_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const now = Date.now() / 1000, streams = new Set();
const products = Array.from({ length: 65 }, (_, i) => ({
  item_id: 2000000 + i, name_zh: i % 2 ? `药水 ${i}` : `矿石 ${i}`, name_en: i % 2 ? `Potion ${i}` : `Ore ${i}`,
  category: i % 2 ? '消耗品' : '其他', sales_window: 100 - i, sales_10d: 100 - i, listings: 2,
  typical: 1000 + i * 37, low: 900 + i * 37, change_window: 3, last_seen: now - i, last_sale_at: now - i, trend: [],
}));
const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: false });
  if (url.pathname === '/api/v1/market/period-default') return json(res, { default_hours: 'all' });
  if (url.pathname === '/api/v1/market') return json(res, { as_of: now, products });
  if (url.pathname === '/api/v1/dex/dropped-items') return json(res, { item_ids: [] });
  if (url.pathname === '/api/v1/crafting/prices') return json(res, { prices: [] });
  if (url.pathname === '/api/v1/sales/recent') return json(res, { generated_at: now, sales: [] });
  if (url.pathname.startsWith('/api/')) return json(res, {});
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
const open = async ({ mobile, noObserver = false }) => {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme: 'light' });
  page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
  await page.addInitScript(noObserver => {
    localStorage.setItem('uiLang', 'zh'); localStorage.setItem('uiTheme', 'light');
    if (noObserver) delete window.IntersectionObserver;
  }, noObserver);
  return page;
};
const rowSelector = mobile => mobile ? '.react-price-mobile [data-item-row]' : '.react-price-desktop tr[data-item-row]';
try {
  browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await open({ mobile });
    await page.goto(origin + '/?hours=all&lang=zh');
    const rows = page.locator(rowSelector(mobile));
    await rows.first().waitFor();
    assert.equal(await rows.count(), 20, 'the table starts with 20 rows');
    assert(await page.locator('.hero input[name=q]').isVisible(), 'the hero search stays at the top');
    assert.deepEqual(await page.locator('.hero .portal .p-top').allTextContents(), ['关注', '图鉴', '云逛市场']);
    assert.equal(await page.locator('.home-market').count(), 0, 'the market overview is gone');
    assert.equal(await page.locator('.react-prices .stall-bar [role=tablist]').getAttribute('aria-label'), '价格表');
    assert.equal(await page.locator('.react-prices [data-period]').count(), 1, 'the price table keeps 统计范围');
    assert.deepEqual(await page.locator('[data-nav-key]:visible').evaluateAll(links => links.map(link => link.dataset.navKey)), ['home', 'agent', 'dex', 'watch', 'grind', 'tools']);
    assert.equal(await page.locator('[data-nav-key=home]:visible').getAttribute('aria-current'), 'page');
    assert.equal(await page.title(), '首页 · 枫叶市集');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `fixture-top-${mobile ? 'phone' : 'desktop'}.png`) });
    await page.locator('.react-price-more').scrollIntoViewIfNeeded();
    await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 40, rowSelector(mobile));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await rows.count(), 40, 'nearing the end adds 20 rows');
    if (mobile) {
      const toolbar = await page.locator('.react-price-sticky').evaluate(node => ({ position: getComputedStyle(node).position, top: node.getBoundingClientRect().top }));
      assert.equal(toolbar.position, 'sticky');
      assert(Math.abs(toolbar.top) <= 1, `the phone toolbar sticks to the top while scrolling: ${toolbar.top}`);
      for (const width of [320, 375, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
      }
    }
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(selector => document.querySelectorAll(selector).length >= 60, rowSelector(mobile));
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 65, rowSelector(mobile));
    assert.equal(await page.locator('.react-price-more').count(), 0, 'the button goes away once every row is shown');
    assert.deepEqual(page.errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'} home price table: hero, 20 rows, +20 on scroll, nav and sticky toolbar`);
  }
  {
    const page = await open({ mobile: false, noObserver: true });
    await page.goto(origin + '/?hours=all&lang=zh');
    const rows = page.locator(rowSelector(false));
    await rows.first().waitFor();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    assert.equal(await rows.count(), 20, 'without IntersectionObserver nothing loads by itself');
    await page.locator('.react-price-more').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 40, rowSelector(false));
    assert.equal(await page.locator('.react-price-more').textContent(), '加载更多');
    await page.goto(origin + '/prices?sort=name&cat=use&q=药水&hours=all&lang=zh');
    await rows.first().waitFor();
    const url = new URL(page.url());
    assert.equal(url.pathname, '/', 'old /prices links land on the home page');
    assert.deepEqual([...url.searchParams], [['sort', 'name'], ['cat', 'use'], ['q', '药水'], ['hours', 'all'], ['lang', 'zh']]);
    assert.equal(await page.locator('[data-cat=use]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-q]').inputValue(), '药水');
    assert.equal(await page.locator('[data-sort-label]').textContent(), '名称');
    assert.match(await rows.first().textContent(), /药水/);
    assert.deepEqual(page.errors, []);
    await page.close();
    console.log('PASS 加载更多 without IntersectionObserver, and /prices?… keeps its query on /');
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
