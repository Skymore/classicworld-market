import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const screenshots = process.env.REACT_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const streams = new Set();
const now = Date.now() / 1000;
const product = { item_id: 2048001, name_zh: '宠物装备移动速度卷轴：高级', name_en: 'Pet Equip Speed Scroll: Greater', category: '消耗品', low: 10, listings: 999, typical: 1000, last_seen: now };
const quotes = [
  { ...product, id: 'recent-expensive', observed: now, unit_price: 900, stock: 4, bundle: 1, shop: 'First shop', location: { channel: 23, room: 9 } },
  { ...product, id: 'unknown-stock', observed: now - 60, unit_price: 19.9, stock: null, bundle: 1, shop: 'Other shop', location: null },
];
const sales = [{ ...quotes[0], id: 'sale', time: now, sale_unit_price: 850, kind: 'drop', quantity: 2, stock: 3 }];
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: false });
  if (url.pathname === '/api/v1/market') return json(res, { products: [product], as_of: now });
  if (url.pathname === '/api/v1/market/period-default') return json(res, { default_hours: 'all' });
  if (url.pathname === '/api/v1/sales/recent') return json(res, { sales, generated_at: now });
  if (url.pathname === '/api/v1/quotes/recent') return json(res, { listings: quotes, generated_at: now });
  if (url.pathname === '/api/v1/watchlist/catalog') return json(res, { items: [product], presets: [{ id: 'fixture', name_zh: '测试关注', name_en: 'Preset', items: [product] }] });
  if (url.pathname === '/api/v1/watchlist/listings') return json(res, { listings: quotes.map(row => ({ ...row, stock: row.stock ?? 2 })), generated_at: now });
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const width of [320, 375, 1280]) {
    for (const lang of ['zh', 'en']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 640, hasTouch: width < 640 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ lang, width }) => { localStorage.setItem('lang', lang); localStorage.setItem('theme', width === 375 ? 'dark' : 'light'); }, { lang, width });
      await page.goto(`${origin}/?lang=${lang}&hours=all`);
      const sold = page.locator('[data-pane=recent] .market-record');
      await sold.waitFor();
      assert.match(await sold.locator('.record-details').textContent(), /×2/);
      assert.equal(await sold.locator('.ware-price').textContent(), '850');
      assert.match(await sold.locator('.record-stock').textContent(), /3$/);
      await page.locator('[data-tab=quotes]').click();
      const offers = page.locator('[data-pane=quotes] .market-record');
      await offers.first().waitFor();
      assert.equal(await offers.count(), 2);
      assert.equal(await offers.first().locator('.ware-price').textContent(), '900', 'the newest quote can be more expensive than the per-item minimum');
      assert.equal(await offers.first().locator('.loc b').textContent(), 'CH 23');
      assert.match(await offers.first().locator('.loc > span').textContent(), /9/);
      assert.equal(await offers.first().locator('[data-relative-time]').getAttribute('data-relative-time'), String(now));
      assert.match(await offers.nth(1).locator('.record-stock').textContent(), /—$/);
      assert.match(await offers.nth(1).locator('.loc').textContent(), /位置未知|Unknown location/);
      async function checkLayout(row) {
        const result = await row.evaluate(node => {
          const meta = node.querySelector('.record-meta');
          const fields = [...meta.children].map(child => child.className);
          const box = meta.getBoundingClientRect();
          const value = node.querySelector('.record-value').getBoundingClientRect();
          const bounds = node.getBoundingClientRect();
          const main = node.querySelector('.w-main').getBoundingClientRect();
          return { fields, centered: value.left >= main.right - 1 && Math.abs((value.top + value.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 1, inside: [...meta.children].every(child => { const b = child.getBoundingClientRect(); return b.left >= box.left - 1 && b.right <= box.right + 1; }), columns: getComputedStyle(node).gridTemplateColumns.split(' ').length, secondaryWrap: getComputedStyle(node.querySelector('.name-secondary')).whiteSpace };
        });
        assert.deepEqual(result.fields, ['loc', 'record-time']);
        assert(result.inside, 'every metadata field stays within the name column');
        assert.equal(result.columns, 3, 'icon, names/metadata and a separate value column');
        assert(result.centered, 'price and stock are vertically centered on the right');
        assert.equal(result.secondaryWrap, 'normal', 'long translations remain readable');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      }
      await checkLayout(offers.first());
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `quotes-${width}-${lang}.png`) });
      await page.locator('[data-nav-key=watch]:visible').click();
      await page.locator('[data-preset]').click();
      const matches = page.locator('[data-matches] .market-record');
      await matches.first().waitFor();
      await page.locator('[data-watch-sort]').selectOption('recent');
      assert.equal(await matches.first().getAttribute('data-id'), 'recent-expensive');
      await checkLayout(matches.first());
      assert.equal(await matches.first().locator('.ware-price').textContent(), '900');
      await page.locator('[data-watch-sort]').selectOption('price');
      await page.waitForFunction(() => document.querySelector('[data-matches] [data-item-row]')?.dataset.id === 'unknown-stock');
      assert.equal(await matches.first().getAttribute('data-id'), 'unknown-stock');
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `watch-${width}-${lang}.png`) });
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${width}px ${lang}: one row layout for sales, actual latest quotes and watched offers; location/time/price/stock agree`);
    }
  }
} finally {
  await browser.close(); for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve));
}
