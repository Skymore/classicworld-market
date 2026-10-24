// Exercise the actual price and watch page controls at phone/desktop widths.
// Postgres search semantics are covered separately by market-web/tests/search.rs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = JSON.parse(await readFile(new URL('./fixtures/search-cases.json', import.meta.url), 'utf8'));
const now = Date.now() / 1000;
const products = fixtures.map(item => ({ ...item, category: '消耗品', typical: 24000, low: 18888, sales_window: 12, sales_10d: 12, listings: 2, shops: 2, trend: [], last_sale_at: now, last_seen: now }));
const speedQueries = ['宠物 移动', '宠物 移速', '宠物 速度', '移速宠物', '宠物移速', '速度宠物', '宠物速度'];
const streams = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let body = {};
    if(url.pathname === '/api/v1/catalog/page') { const target=new URL(url.searchParams.get('url'),'http://localhost'); const rows=speedQueries.includes(target.searchParams.get('q'))?products.slice(0,2):[]; body={kind:'search',page:{query:target.searchParams.get('q')||'',kind:null,offset:0,region:'',area:'',areas:[],filters:{},items:{rows:rows.map(row=>({id:row.item_id,names:{zh:row.name_zh,en:row.name_en}})),more:false},mobs:{rows:[],more:false},maps:{rows:[],more:false}}}; }
    if (url.pathname === '/api/v1/market') body = { products, as_of: now };
    if (url.pathname === '/api/v1/sales/recent') body = { sales: [], as_of: now };
    if (url.pathname === '/api/v1/dex/dropped-items') body = { item_ids: [] };
    if (url.pathname === '/api/v1/watchlist/catalog') {
      const query = url.searchParams.get('q');
      // Fixed API answers: this test verifies rendering and adding a result.
      body = { items: speedQueries.includes(query) ? products.slice(0, 2) : [], presets: [] };
    }
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(body));
  }
  if (url.pathname === '/search') {
    const rows = speedQueries.includes(url.searchParams.get('q')) ? products.slice(0, 2) : [];
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<div data-search-results>${rows.map(item => `<a class="drow" href="/item/${item.item_id}"><span class="t"><b>${item.name_zh}</b><small class="name-secondary">${item.name_en}</small></span></a>`).join('')}</div>`);
  }
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 375 : 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + `/prices?hours=all&lang=${mobile ? 'zh' : 'en'}`);
    const waitRows = count => page.waitForFunction(expected => [...document.querySelectorAll('[data-pane=all] [data-item-row]')].filter(el => el.getClientRects().length).length === expected, count);
    await waitRows(products.length);
    const input = page.locator('[data-q]:visible');
    for (const [query, count] of [...speedQueries.map(query => [query, 2]), ['速度 宠物', 2], ['宠物 SPEED', 2], ['寵物 移動', 2], ['宠物跳跃', 1], ['鞋子移速60%', 1], ['移速宠物高级', 1], ['鞋子移速10%', 0]]) {
      await input.fill(query);
      await page.waitForFunction(q => new URL(location.href).searchParams.get('q') === q, query);
      await waitRows(count);
      assert.equal(await input.inputValue(), query);
    }
    await input.fill('宠物 移速'); await waitRows(2);
    await page.reload(); await waitRows(2);
    assert.equal(await input.inputValue(), '宠物 移速', 'search survives a reload');
    await page.locator('[data-cat=equip]:visible').click(); await waitRows(0);
    await page.locator('[data-cat=all]:visible').click(); await waitRows(2);
    await page.goto(origin + '/watch?hours=all');
    const watch = page.locator('[data-search]'); await watch.waitFor();
    for (const query of speedQueries) {
      const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1/watchlist/catalog' && new URL(res.url()).searchParams.get('q') === query);
      await watch.fill(query); await response;
      await page.waitForFunction(() => document.querySelectorAll('[data-add]').length === 2);
      assert.match(await page.locator('[data-add]').first().textContent(), /宠物装备移动速度卷轴/);
    }
    await page.locator('[data-add="2048000"]').click();
    await page.locator('[data-card="2048000"]').waitFor();
    await page.goto(origin + '/?hours=all');
    const finder = page.locator('form.finder input[name=q]:visible').last();
    await finder.waitFor();
    for (const query of speedQueries) {
      const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1/catalog/page' && new URL(new URL(res.url()).searchParams.get('url'),origin).searchParams.get('q') === query);
      await finder.fill(query); await response;
      await page.waitForFunction(() => document.querySelector('.quick-search:not([hidden]):not([aria-busy=true]) .quick-row'));
      assert.equal(await page.locator('.quick-search:visible .quick-row').count(), 2);
      assert.match(await page.locator('.quick-search:visible').textContent(), /宠物装备移动速度卷轴/);
      assert.equal(new URL(await page.locator('.quick-search:visible .quick-more').getAttribute('href'),origin).searchParams.get('q'), query);
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${mobile ? 'Phone' : 'Desktop'}: compact keywords, price filters, watch add and home quick search passed`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.destroy();
  await new Promise(resolve => server.close(resolve));
}
