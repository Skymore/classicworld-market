// Warm CSS caches, input focus and changing iPhone bottom safe areas.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const assetVersion = (await readFile(path.join(root, 'react/asset-version.txt'), 'utf8')).trim();
const now = Date.now() / 1000, streams = new Set();
let generation = 0, saleReads = 0;
const product = { item_id: 1452003, name_zh: '战斗弓', name_en: 'Battle Bow', category: '装备', sales_window: 20, typical: 8000, low: 7000, last_seen: now, trend: [] };
const names = { zh: '宠物装备移动速度卷轴', en: 'Pet Equip Speed Scroll' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/crafting/prices') data = { prices: [] };
    if (url.pathname === '/api/v1/market') data = { as_of: now + generation, products: [product] };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all' };
    if (url.pathname === '/api/v1/sales/recent') {
      saleReads++;
      data = { generated_at: now + generation, sales: Array.from({ length: 8 }, (_, i) => ({ ...product, id: i, sale_unit_price: 8000 + generation, time: now - i, location: { channel: 16, room: 9 } })) };
    }
    if (url.pathname === '/api/v1/dex/counts') data = { mobs: 1, maps: 1 };
    if (url.pathname === '/api/v1/catalog/page') {
      const target = new URL(url.searchParams.get('url'), 'http://localhost');
      if (target.pathname === '/search') data = { kind: 'search', page: { query: target.searchParams.get('q'), kind: null, offset: 0, region: '', area: '', areas: [], filters: {}, items: { rows: Array.from({ length: 7 }, (_, i) => ({ id: 2048000 + i, names })), more: false }, mobs: { rows: [], more: false }, maps: { rows: [], more: false } } };
      else {
        const id = Number(target.pathname.split('/').at(-1));
        data = { kind: 'item', page: { item: { id, name_en: id === 1452003 ? 'Battle Bow' : names.en, name_zh: id === 1452003 ? '战斗弓' : names.zh, category: '装备' }, stats: null, droppers: [], npc_offers: [], npc_sell: null, market: { as_of: now, base_stats: [], days: [], sale_points: [], listings: [], sales: [] } } };
      }
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
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const stale of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let oldStyles = 0;
    if (stale) {
      await page.route(/\/web\/(css\/.*\.css|react\/style\.css)(\?|$)/, route => {
        if (new URL(route.request().url()).searchParams.get('v') === assetVersion) return route.continue();
        oldStyles++;
        return route.fulfill({ contentType: 'text/css', body: '/* Cached stylesheet from before these components existed. */' });
      });
      await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = '/web/css/item.css?v=20261023-react-1'; document.head.append(link);
      }));
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 0 } });
    await page.goto(origin + '/?lang=zh&hours=all');
    await page.locator('[data-pane="recent"] [data-item-row]').first().waitFor();
    const input = page.locator('.hero input[name=q]');
    assert.equal(await input.evaluate(node => getComputedStyle(node).fontSize), '16px', 'search cannot trigger the iOS small-input focus zoom');
    const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
    assert.match(viewport, /user-scalable=no/);
    assert.match(viewport, /minimum-scale=1/);
    assert.match(viewport, /maximum-scale=1/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction), 'pan-x pan-y', 'single-finger panning remains enabled without page zoom');
    const cancellation = await page.evaluate(() => {
      function touch(type, count) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientX: 5, clientY: 300 })) });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      }
      const gesture = new Event('gesturechange', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(gesture);
      return [touch('touchstart', 1), touch('touchmove', 1), touch('touchstart', 2), touch('touchmove', 2), gesture.defaultPrevented];
    });
    assert.deepEqual(cancellation, [false, false, true, true, true], 'block Safari zoom gestures while preserving single-finger input');
    const doubleClick = await page.evaluate(() => {
      const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert(doubleClick, 'explicitly cancel touch-browser double-click zoom');
    await page.evaluate(() => {
      window.tapEnds = [];
      const surface = document.createElement('div');
      surface.id = 'double-tap-surface'; surface.textContent = 'Text surface';
      surface.style.cssText = 'position:fixed;top:280px;left:90px;width:210px;height:120px;z-index:9999;background:white';
      document.body.append(surface);
      for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(type, event => window.tapEnds.push({ type, canceled: event.defaultPrevented, cancelable: event.cancelable, time: event.timeStamp, target: event.target.tagName, touches: event.touches.length, changed: event.changedTouches.length, x: event.changedTouches[0]?.clientX, y: event.changedTouches[0]?.clientY }));
    });
    for (let tap = 0; tap < 2; tap++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 330, id: 9 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    const trace = await page.evaluate(() => window.tapEnds);
    const ends = trace.filter(event => event.type === 'touchend').map(event => event.canceled);
    assert.deepEqual(ends, [false, true], `the second native tap is canceled before legacy double-tap zoom: ${JSON.stringify(trace)}`);
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    await page.locator('#double-tap-surface').evaluate(node => node.remove());
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'tap-action-check'; button.textContent = 'Tap';
      button.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;width:70px;height:44px';
      window.actionTaps = 0;
      button.addEventListener('click', () => window.actionTaps++);
      document.body.append(button);
    });
    await page.locator('#tap-action-check').tap();
    await page.locator('#tap-action-check').tap();
    assert.equal(await page.evaluate(() => window.actionTaps), 2, 'rapid normal control taps both reach their action');
    await page.locator('#tap-action-check').evaluate(node => node.remove());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 360, id: 1 }, { x: 230, y: 360, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 110, y: 360, id: 1 }, { x: 280, y: 360, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'native pinch does not change the page scale');
    await frames(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 630, id: 3 }] });
    for (const y of [590, 550, 510, 470, 430, 390]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y, id: 3 }] });
      await frames(page);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => scrollY > 0, { timeout: 2000 });
    const scrolling = await page.evaluate(() => ({ y: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight, overflow: getComputedStyle(document.documentElement).overflow, popup: Boolean(document.querySelector('.item-peek:not([hidden])')) }));
    assert(scrolling.y > 0, `normal single-finger scrolling still works: ${JSON.stringify(scrolling)}`);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await frames(page);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    async function footerClear() {
      const bounds = await page.evaluate(() => ({ footer: document.querySelector('.home-foot').getBoundingClientRect().bottom, dock: document.querySelector('.dock').getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }));
      assert(bounds.footer <= bounds.dock - 12, `footer ${bounds.footer} remains above dock ${bounds.dock} after one scroll`);
      assert(!bounds.overflow);
    }
    await footerClear();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
    await frames(page);
    assert.equal(await page.locator('.dock').evaluate(node => node.getBoundingClientRect().height), 94, 'exercise a real 34px safe-area inset');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), height, 'browser bar collapse cannot extend the page after reaching its end');
    await footerClear();
    await page.setViewportSize({ width: 390, height: 844 });
    await frames(page);
    await footerClear();
    const reads = saleReads;
    const refreshed = page.waitForResponse(response => response.url().includes('/api/v1/sales/recent'));
    generation++;
    for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
    await (await refreshed).finished();
    await frames(page);
    assert(saleReads > reads);
    await footerClear();
    await input.fill('Speed pet');
    const rows = page.locator('.hero .quick-search .quick-row');
    await rows.first().waitFor();
    await rows.first().tap();
    const preview = page.locator('#item-quick-preview');
    await preview.locator('.peek-footer a').waitFor();
    const fits = await preview.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 10 && box.right <= innerWidth - 10 && box.bottom <= visualViewport.height + visualViewport.offsetTop; });
    assert(fits, 'the preview fits without a pinch gesture');
    await preview.locator('.peek-close').click();
    await page.goto(origin + '/item/1452003?lang=zh');
    await page.locator('[data-crafting="1452003"]').waitFor();
    const craft=page.locator('.src-well details[data-crafting]');
    assert.equal(await craft.getAttribute('open'),null,'crafting starts collapsed');
    assert.equal(await craft.locator('input,select,textarea').count(),0,'crafting is read-only');
    assert.equal(await craft.locator('.craft-summary').evaluate(node=>getComputedStyle(node).display),'grid','current component CSS survives warm old styles');
    await craft.locator('summary').click();
    assert.equal(await craft.locator('.craft-materials').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').filter(width=>parseFloat(width)>0).length),4,'four compact material cards fit on one row');
    const itemInput=page.locator('.mobile-item-search input[name=q]');
    assert(await page.locator('.mobile-item-search').evaluate(node=>Math.abs(node.getBoundingClientRect().width-node.querySelector('.finder').getBoundingClientRect().width)<1),'item search fills the row with fresh and cached CSS');
    await itemInput.fill('Speed pet');
    const itemRows=page.locator('.mobile-item-search .quick-row');await itemRows.first().waitFor();assert.equal(await itemRows.count(),6);
    await itemRows.first().tap();await preview.locator('.peek-footer a').waitFor();await preview.locator('.peek-close').click();
    await itemInput.fill('Speed pets');await page.locator('.mobile-item-search .quick-more').tap();await page.waitForURL(url=>url.pathname==='/search'&&url.searchParams.get('q')==='Speed pets');
    const icons=await page.locator('.dock .dock-icon svg').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {top:r.top,width:r.width,height:r.height};}));
    assert.equal(icons.length,6);assert(icons.every(r=>r.width===24&&r.height===24&&r.top===icons[0].top));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (stale) assert(oldStyles > 0, 'actually exercise cached legacy styles');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${stale ? 'warm old CSS cache' : 'fresh page'}: locked zoom, normal touch scrolling, 16px inputs, safe-area changes, SSE, fitted preview and crafting`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
