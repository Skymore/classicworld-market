import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const screenshots = process.env.REACT_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const now = Date.now() / 1000;
let price = 24000;
const products = [
  { item_id: 2000000, name_zh: '红色药水', name_en: 'Red Potion', category: '消耗品', last_seen: now, last_sale_at: now },
  { item_id: 1002000, name_zh: '蓝色头巾', name_en: 'Blue Bandana', category: '装备', jobs: ['通用'], level: 10, last_seen: now - 10, last_sale_at: now - 10 },
  { item_id: 4000000, name_zh: '蜗牛壳', name_en: 'Snail Shell', category: '其他', last_seen: null, last_sale_at: null },
].map(row => ({ ...row, sales_window: 12, sales_10d: 12, listings: 2, typical_window: price, typical_window_low: 20000, typical_window_high: 26000, typical: price, last_sale_price: row.item_id === 2000000 ? 13500 : row.item_id === 1002000 ? 25000 : null, low: 18888, change_window: 10, trend: [] }));
products[1].low = 12000;
products[2].low = null;
const streams = new Set(); const counts = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
  if (url.pathname === '/api/v1/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if(url.pathname==='/api/v1/catalog/page') data={kind:'search',page:{query:'',kind:'Item',offset:0,region:'',area:'',areas:[],filters:{},items:{rows:[{id:2000000,names:{zh:'红色药水',en:'Red Potion'}}],more:false},mobs:{rows:[],more:false},maps:{rows:[],more:false}}};
    if (url.pathname === '/api/v1/market') data = { as_of: now, products: products.map(row => ({ ...row, typical_window: price })) };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all', recent_priced_items: 3, threshold: 100 };
    if (url.pathname === '/api/v1/dex/dropped-items') data = { item_ids: [2000000] };
    if (url.pathname === '/api/v1/dex/counts') data = { mobs: 10, maps: 20 };
    if (url.pathname === '/api/v1/account') data = { signed_in: false, google_enabled: true };
    if (url.pathname === '/api/v1/watchlist/catalog') data = { items: [], presets: [] };
    if (url.pathname === '/api/v1/sales/recent') data = { sales: [], generated_at: now };
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data));
  }
  if (url.pathname === '/search') {
    const en = url.searchParams.get('lang') === 'en';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="${en ? 'en' : 'zh-CN'}" data-lang="${en ? 'en' : 'zh'}" data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/web/js/lib/boot.js"></script><link rel="stylesheet" href="/web/css/base.css"><link rel="stylesheet" href="/web/react/style.css"><script type="module" src="/web/react/shell.js"></script></head><body><div id="app" class="app"><header class="ptop">Old header</header><header class="dhead">Old header</header><main class="pmain dwrap"><section class="stall"><h1 data-server-content>Catalogue content from Rust</h1><div data-search-results></div></section></main><nav class="dock"></nav></div></body></html>`);
  }
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 375 : 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme: 'light' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (!sessionStorage.getItem('fixture-seeded')) { localStorage.setItem('theme', 'dark'); sessionStorage.setItem('fixture-seeded', '1'); } window.documentIdentity = Math.random(); });
    await page.goto(origin + '/prices?hours=all&lang=zh');
    await page.locator('[data-item-row]:visible').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.reactApp), '1');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sheet').trim()), '#232b38');
    assert.equal(await page.locator('[data-nav-key=alerts]:visible').textContent(), '采集');
    if (mobile) assert(await page.locator('.dock a').evaluateAll(links => { const boxes=links.map(link=>link.getBoundingClientRect()); return boxes.length===6&&boxes.every(box=>Math.abs(box.top-boxes[0].top)<1&&box.right<=innerWidth&&box.bottom<=innerHeight); }), 'six navigation entries remain on one row');
    const identity = await page.evaluate(() => { window.savedHeader = document.querySelector('.ptop'); return window.documentIdentity; });
    const nav = key => page.locator(`[data-nav-key=${key}]:visible`);
    const filter = page.locator('[data-filter-btn]'); await filter.click();
    await page.locator('[role=dialog] [data-job=warrior]').click();
    assert.equal(new URL(page.url()).searchParams.get('job'), 'warrior');
    await page.keyboard.press('Escape');
    await page.locator('.ui-dialog-content').waitFor({ state: 'detached' });
    assert.equal(await filter.evaluate(node => node === document.activeElement), true, 'Radix restores focus to the filter button');
    await page.locator('[data-clear-price-filters=all]').click();
    const rows = page.locator('[data-item-row]:visible');
    await page.locator('[data-sort-btn]').click(); await page.locator('[data-sort=low]').click();
    assert.match(await rows.first().textContent(), /蓝色头巾/);
    assert.match(await rows.last().textContent(), /蜗牛壳/, 'items without an ask stay last');
    assert.equal(await page.locator('[data-sort-label]').textContent(), '报价最低');
    await page.locator('[data-sort-btn]').click();
    assert.equal(await page.locator('[role=menuitemradio]').count(), 8, 'one list contains useful field/direction combinations');
    assert.equal(await page.locator('[data-sort-dir]').count(), 0, 'there is no separate direction control');
    assert.equal(await page.getByRole('menuitemradio', { name: /从旧到新|从少到多/ }).count(), 0);
    if (screenshots && mobile) await page.screenshot({ path: path.join(screenshots, 'sort-menu-phone.png') });
    await page.keyboard.press('Escape');
    if (mobile) {
      assert.equal(await page.locator('[data-mobile-price-heading]').textContent(), '最低报价');
      assert.deepEqual(await rows.locator('.pr').allTextContents(), ['12K', '18.9K', '—'], 'the visible prices are the asks used to sort, not the typical sale prices');
      assert.equal(await rows.locator('.sample-badge').count(), 0, 'sales sample badges do not describe asking prices');
      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 900 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sort labels fit narrow phones');
        if (screenshots) {
          await page.screenshot({ path: path.join(screenshots, `ask-sort-${width}-dark.png`) });
          await page.locator('[data-theme-toggle]:visible').click();
          await page.screenshot({ path: path.join(screenshots, `ask-sort-${width}-light.png`) });
          await page.locator('[data-theme-toggle]:visible').click();
        }
      }
      await page.locator('[data-lang-toggle]:visible').click();
      assert.equal(await page.locator('[data-sort-label]').textContent(), 'Lowest ask');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('[data-lang-toggle]:visible').click();
    }
    await page.locator('[data-sort-btn]').click(); await page.locator('[data-sort=low-desc]').click();
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'desc');
    assert.equal(await page.locator('[data-sort-label]').textContent(), '报价最高');
    assert.match(await rows.first().textContent(), /红色药水/);
    assert.match(await rows.last().textContent(), /蜗牛壳/);
    await page.locator('[data-sort-btn]').click(); await page.locator('[data-sort=price]').click();
    if (mobile) assert.equal(await page.locator('[data-mobile-price-heading]').textContent(), '成交价');
    await page.locator('[data-sort-btn]').click(); await page.locator('[data-sort=lastsale]').click();
    assert.equal(await page.locator('[data-sort-label]').textContent(), '最新成交');
    assert.match(await rows.first().textContent(), /红色药水/);
    assert.match(await rows.last().textContent(), /蜗牛壳/);
    if (mobile) {
      assert.equal(await page.locator('[data-mobile-price-heading]').textContent(), '最新成交价');
      assert.deepEqual(await rows.locator('.pr').allTextContents(), ['13.5K', '25K', '—']);
      assert.equal(await rows.first().locator('[data-relative-time]').getAttribute('data-relative-time'), String(now));
    }
    await page.locator('[data-sort-btn]').click(); await page.locator('[data-sort=recent]').click();
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'recent');
    assert.match(await rows.first().textContent(), /红色药水/); assert.match(await rows.last().textContent(), /蜗牛壳/);
    const oldUrl = new URL(page.url()); oldUrl.searchParams.set('dir', 'asc');
    await page.goto(oldUrl.href); await rows.first().waitFor();
    assert.equal(await page.locator('[data-sort-label]').textContent(), '最新报价');
    assert.match(await rows.first().textContent(), /红色药水/, 'old ascending links still show the newest quotes first');
    await page.reload(); await rows.first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'recent');
    const afterReload = await page.evaluate(() => { window.savedHeader = document.querySelector('.ptop'); return window.documentIdentity; });
    await nav('home').click(); await page.locator('.hero h1').waitFor();
    assert.equal(await page.evaluate(() => window.documentIdentity), afterReload);
    assert(await page.evaluate(() => window.savedHeader === document.querySelector('.ptop')), 'route changes keep the header DOM');
    assert.equal(await page.locator('main').count(), 1);
    await page.locator('.home-market [data-tab=quotes]').click();
    const offers = page.locator('[data-pane=quotes] [data-item-row]');
    await offers.first().waitFor();
    assert.equal(await offers.count(), 2, 'latest offers exclude items without an observed quote time');
    assert.match(await offers.first().textContent(), /红色药水/);
    assert.equal(await offers.first().locator('.ware-price').textContent(), '18.9K', 'offers show the lowest ask rather than the typical sale price');
    assert.equal(await offers.first().locator('[data-relative-time]').getAttribute('data-relative-time'), String(now));
    assert.equal(await offers.first().getAttribute('href'), '/item/2000000?hours=all');
    await page.locator('[data-lang-toggle]:visible').click();
    assert.equal(await page.locator('[data-tab=quotes]').textContent(), 'Latest offers');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'four home tabs fit within the page in English');
    await page.locator('[data-lang-toggle]:visible').click();
    await page.locator('[data-pane=quotes] .more').click(); await rows.first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'recent');
    assert.equal(new URL(page.url()).searchParams.get('hours'), 'all');
    await nav('alerts').click(); await page.locator('.alerts-page h1').waitFor();
    assert.equal(await page.locator('.alerts-page h1').textContent(), '采集');
    assert.match(await page.title(), /^采集/);
    await nav('prices').click(); await rows.first().waitFor();
    price = mobile ? 35000 : 36000; for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
    await page.waitForFunction(expected => [...document.querySelectorAll('.pr')].some(node => node.textContent.includes(expected)), mobile ? '35K' : '36K');
    await nav('watch').click(); await page.locator('[data-search]').waitFor();
    await nav('prices').click(); await rows.first().waitFor();
    await page.locator('[data-theme-toggle]:visible').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await nav('dex').click(); await page.locator('#site-react-shell').waitFor({ state: 'attached' });
    await page.locator('[data-react-catalogue=search] #search-item').waitFor();
    assert.equal(await page.evaluate(() => window.documentIdentity), afterReload, 'catalogue links stay inside the React document');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await page.locator('[data-nav-key=alerts]:visible').textContent(), '采集');
    await page.locator('[data-theme-toggle]:visible').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'server header toggles once');
    await nav('prices').click(); await rows.first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    assert.deepEqual(errors, []);
    assert(identity !== afterReload, 'the reload check was a real document reload');
    await page.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'}: React shell identity, preserved tokens, filters/focus, sort/reload, collection label, SSE refresh, legacy lifecycle and server-rendered chrome`);
  }
} finally { await browser?.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
