// The home price table renders one layout (phone list or desktop table), keeps long lists small by turning
// far-away blocks of rows into spacers of the same height, and opens items from a row click inside the app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Math.floor(Date.now() / 1000), streams = new Set();
const TOTAL = 400;
// Sorted by sales (the default), row i is the i-th row of the table.
const products = Array.from({ length: TOTAL }, (_, i) => ({
  item_id: 2000000 + i, name_zh: `药水 ${i}`, name_en: `Potion ${i}`, category: '消耗品', sales_window: 10000 - i,
  sales_10d: 10000 - i, listings: 2, typical: 500, low: 400, change_window: 3, last_seen: now - i, last_sale_at: now - i, trend: [],
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
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// Rows rendered, rows standing behind spacers, and whether each rendered row keeps its striping parity.
const listState = (page, selector) => page.evaluate(selector => {
  const list = document.querySelector(selector);
  const rows = [...list.querySelectorAll('[data-item-row]')];
  const index = row => Number(row.dataset.open || new URL(row.href).pathname.split('/').pop()) - 2000000;
  return {
    mounted: rows.length,
    spaced: [...list.querySelectorAll('[data-rows]')].reduce((sum, node) => sum + Number(node.dataset.rows), 0),
    parity: rows.every(row => Array.prototype.indexOf.call(list.children, row) % 2 === index(row) % 2),
    nodes: document.querySelectorAll('*').length,
  };
}, selector);
const rowTop = (page, selector) => page.evaluate(selector => {
  const row = [...document.querySelectorAll(`${selector} [data-item-row]`)].find(node => node.textContent.includes('药水 150'));
  return row ? row.getBoundingClientRect().top + scrollY : null;
}, selector);
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('lang', 'zh'); localStorage.setItem('theme', 'light');
      // Without scroll anchoring (as in Safari) a spacer of the wrong height would move the page.
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.overflowAnchor = 'none'; });
    });
    await page.goto(origin + '/?hours=all&lang=zh');
    const selector = mobile ? '.react-price-mobile' : '.react-price-desktop tbody';
    await page.locator(`${selector} [data-item-row]`).first().waitFor();
    assert.equal(await page.locator('.react-price-mobile').count(), mobile ? 1 : 0, 'only the layout for this screen is rendered');
    assert.equal(await page.locator('.react-price-desktop').count(), mobile ? 0 : 1);
    // Focus stays on a row's link while the list scrolls far away from it.
    const focusLink = mobile ? `${selector} [data-item-row]` : `${selector} [data-item-row] a.it`;
    await page.locator(focusLink).nth(2).focus();
    let reference = null;
    for (let step = 0; step < 200; step++) {
      await page.evaluate(() => scrollBy(0, 1200));
      await frames(page);
      const { mounted, spaced } = await listState(page, selector);
      // Remember where row 150 sits while it is rendered, to compare once the blocks above become spacers.
      if (reference == null) reference = await rowTop(page, selector);
      if (mounted + spaced >= TOTAL && !(await page.locator('.react-price-more').count())) break;
    }
    await page.waitForTimeout(200);
    const deep = await listState(page, selector);
    assert.equal(deep.mounted + deep.spaced, TOTAL, 'every row is either rendered or behind a spacer');
    assert(deep.mounted <= 200, `far-away rows become spacers: ${JSON.stringify(deep)}`);
    assert(deep.parity, 'spacers keep the row striping');
    assert(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement.closest('[data-item-row]') !== null), 'the focused row is kept');
    assert(reference != null);
    await page.evaluate(top => scrollTo(0, top - 300), reference);
    await frames(page);
    await frames(page);
    const again = await rowTop(page, selector);
    assert(Math.abs(again - reference) <= 1, `spacers have the height of the rows they replace: ${reference} -> ${again}`);
    const back = await listState(page, selector);
    assert(back.spaced > 0 && back.parity, `scrolled back: ${JSON.stringify(back)}`);
    await page.evaluate(() => scrollTo(0, 0));
    await frames(page);
    await frames(page);
    assert(await page.locator(`${selector} [data-item-row]`).filter({ hasText: '药水 0' }).first().isVisible(), 'rows render again when scrolled back into view');
    // Changing the order starts over from the top with plain rows.
    await page.locator('[data-sort-btn]').click();
    await page.locator('[data-sort=name]').click();
    await page.waitForFunction(selector => document.querySelectorAll(`${selector} [data-item-row]`).length === 20 && !document.querySelector(`${selector} [data-rows]`), selector);
    if (mobile) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('.react-price-desktop tbody [data-item-row]').first().waitFor();
      assert.equal(await page.locator('.react-price-mobile').count(), 0, 'a wider window switches to the table');
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'}: one layout, ${deep.mounted} of ${TOTAL} rows rendered after scrolling to the end, exact spacers, striping and focus kept`);
  }
  for (const embed of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('theme', 'light'); });
    await page.goto(origin + `/?hours=all&lang=zh${embed ? '&embed=1' : ''}`);
    const row = id => page.locator(`tr[data-open="${id}"] td:nth-child(6)`);
    await row(2000004).waitFor();
    await page.evaluate(() => { window.sameDocument = true; });
    // Ctrl and middle clicks open the item in a new tab and leave this page alone.
    for (const options of [{ modifiers: ['ControlOrMeta'] }, { button: 'middle' }]) {
      const opened = context.waitForEvent('page');
      await row(2000004).click(options);
      const tab = await opened;
      await tab.waitForLoadState('domcontentloaded');
      assert.equal(new URL(tab.url()).pathname, '/item/2000004');
      await tab.close();
      assert.equal(new URL(page.url()).pathname, '/');
    }
    // A plain click navigates inside the app, keeping the embedded layout.
    await row(2000004).click();
    await page.waitForURL(url => url.pathname === '/item/2000004' && url.searchParams.get('embed') === (embed ? '1' : null));
    const url = new URL(page.url());
    assert.equal(url.searchParams.get('hours'), 'all');
    assert.equal(url.searchParams.get('embed'), embed ? '1' : null);
    assert.equal(await page.evaluate(() => window.sameDocument), true, 'a row click does not reload the page');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${embed ? 'embedded' : 'site'} row click: in-app navigation, new tab with Ctrl or the middle button`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
