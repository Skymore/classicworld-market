// Real homepage modules + EventSource, with an isolated HTTP fixture server.
// PLAYWRIGHT_MODULE=/path/to/playwright PLAYWRIGHT_CHANNEL=chrome node web/tests/item-preview-live.e2e.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const streams = new Set();
let phase = 0, salesReads = 0, previewDelay = 0;
const json = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/market') return json(res, { as_of: Date.now() / 1000, products: [] });
  if (url.pathname === '/api/v1/dex/counts') return json(res, { items: 1, mobs: 1, maps: 1 });
  if (url.pathname === '/api/v1/sales/recent') {
    salesReads++;
    return json(res, { generated_at: Date.now() / 1000, sales: Array.from({ length: 8 }, (_, i) => ({
      item_id: !phase && !i ? 1462004 : 4010001, name_en: !phase && !i ? 'Eagle Crow' : 'Bronze Ore',
      name_zh: !phase && !i ? '鹰弩' : '青铜母矿', sale_unit_price: 10000 + phase * 1000 + i,
      time: Date.now() / 1000 - 60 * i, kind: 'sold', location: { channel: 12, room: 3 }, icon_url: '',
    })) });
  }
  if (url.pathname === '/api/v1/catalog/page') {
    const target=new URL(url.searchParams.get('url'),'http://localhost'),id=Number(target.pathname.split('/').pop());
    const body={kind:'item',page:{item:{id,name_zh:'鹰弩',name_en:'Eagle Crow',category:'装备',req_level:30},stats:{typical:10000,lowest_ask:9000,listings_count:5,shops_count:3,sales_24h:7,as_of:new Date().toISOString()},droppers:[],npc_offers:[],npc_sell:1000,market:{as_of:new Date().toISOString(),listings:[],sales:[],days:[],sale_points:[],base_stats:Array.from({length:24},(_,i)=>['stat'+i,49+i])}}};
    return setTimeout(()=>json(res,body),previewDelay);
  }
  if (url.pathname.startsWith('/api/')) return json(res, {});
  if (url.pathname.startsWith('/item/')) {
    res.setHeader('Content-Type', 'text/html');
    if (url.searchParams.get('part') !== 'preview') return res.end('<h1>Full item page</h1>');
    const id = url.pathname.split('/').at(-1);
    const content = `<div class="peek-content" data-preview-item="${id}"><header class="peek-head"><h2>Eagle Crow / 鹰弩</h2></header>${Array.from({ length: 16 }, (_, i) => `<section class="peek-section"><h3>Details ${i}</h3><p>Attack +49 · DEX +1</p></section>`).join('')}<footer class="peek-footer"><a href="/item/${id}?hours=all">Full details</a></footer></div>`;
    return setTimeout(() => res.end(content), previewDelay);
  }
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    phase = 0; previewDelay = 0;
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 640 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    await page.goto(`${origin}/?hours=all&lang=${mobile ? 'en' : 'zh'}`);
    await page.locator('.home-market [data-item-row]').first().waitFor();
    const row = page.locator('.home-market a[href*="/item/1462004"]');
    if (mobile) await row.tap(); else { await row.focus(); await page.keyboard.press('Alt+ArrowDown'); }
    const popup = page.locator('#item-quick-preview');
    await popup.locator('[data-preview-item="1462004"]').waitFor();
    await popup.evaluate(el => { window.savedPreview = el.firstElementChild.nextElementSibling; window.savedFocus = document.activeElement; el.scrollTop = 200; });
    const before = await popup.evaluate(el => ({ scroll: el.scrollTop, y: scrollY }));
    // The age-only render used to remove the anchor and close the preview too.
    await page.clock.fastForward(31000);
    assert.equal(await popup.isVisible(), true, 'age refresh must preserve the open preview');
    // SSE changes the actual recent-sales list, including removing this item.
    const reads = salesReads; phase = 1;
    for (const stream of streams) stream.write('event: market\ndata: {"version":2}\n\n');
    await page.waitForFunction(() => !document.querySelector('.home-market a[href*="/item/1462004"]'));
    assert(salesReads > reads, 'the background list must still refresh from SSE');
    assert.equal(await popup.isVisible(), true, 'SSE must not close an item that leaves recent sales');
    assert.deepEqual(await popup.evaluate(el => ({ same: window.savedPreview === el.firstElementChild.nextElementSibling, scroll: el.scrollTop })), { same: true, scroll: before.scroll });
    assert.equal(await page.evaluate(() => window.savedFocus === document.activeElement), true, 'list refresh must not steal preview focus');
    assert.equal(await page.evaluate(() => scrollY), before.y, 'list refresh must not move the underlying page');
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 700 });
      assert.equal(await popup.isVisible(), true, 'mobile address-bar/viewport resize must not dismiss details');
      await page.keyboard.press('Tab');
      assert.equal(await popup.evaluate(el => el.contains(document.activeElement)), true, 'mobile focus stays inside the preview');
    }
    await page.keyboard.press('Escape');
    assert.equal(await popup.isVisible(), false, 'Escape closes the preview');
    assert.equal(await page.locator('.peek-scrim').isVisible(), false);
    const next = page.locator('.home-market [data-item-row]').first();
    if (mobile) await next.tap(); else { await next.focus(); await page.keyboard.press('Alt+ArrowDown'); }
    await popup.locator('[data-preview-item]').waitFor();
    await popup.locator('.peek-close').click();
    assert.equal(await popup.isVisible(), false, 'close button stays functional');
    assert.equal(await next.evaluate(el => el === document.activeElement), true, 'close returns focus to a current row');
    if (mobile) {
      await next.tap(); await popup.locator('[data-preview-item]').waitFor();
      await page.locator('.peek-scrim').click({ position: { x: 2, y: 2 } });
      assert.equal(await popup.isVisible(), false, 'outside tap closes the mobile preview');
    } else {
      await next.hover(); await page.clock.fastForward(200);
      assert.equal(await popup.isVisible(), true, 'desktop hover still works');
      await page.mouse.move(1, 1); await page.clock.fastForward(200);
      assert.equal(await popup.isVisible(), false, 'leaving desktop hover still closes it');
    }
    // A refresh while the preview request is in flight must not abort it.
    phase = 0; previewDelay = 300;
    await page.reload(); await page.locator('.home-market [data-item-row]').first().waitFor();
    if (mobile) await row.tap(); else { await row.focus(); await page.keyboard.press('Alt+ArrowDown'); }
    phase = 1; for (const stream of streams) stream.write('event: market\ndata: {"version":3}\n\n');
    await page.waitForFunction(() => !document.querySelector('.home-market a[href*="/item/1462004"]'));
    await popup.locator('[data-preview-item="1462004"]').waitFor();
    assert.equal(await popup.isVisible(), true, 'in-flight preview survives a replaced list');
    await popup.locator('.peek-footer a').click();
    await page.waitForURL(url => url.pathname === '/item/1462004' && url.searchParams.get('hours') === 'all');
    await page.locator('.item-stall h1').waitFor();
    assert.match(await page.locator('.item-stall h1').textContent(), /Eagle Crow|鹰弩/);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'mobile / English' : 'desktop / Chinese'}: time tick, SSE, removal, scrolling, dismissal and full-page navigation`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await new Promise(resolve => server.close(resolve));
}
