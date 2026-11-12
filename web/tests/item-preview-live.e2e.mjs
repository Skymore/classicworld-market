// Real homepage modules + EventSource, with an isolated HTTP fixture server.
// PLAYWRIGHT_MODULE=/path/to/playwright PLAYWRIGHT_CHANNEL=chrome node web/tests/item-preview-live.e2e.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const screenshots = process.env.PREVIEW_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const streams = new Set();
let phase = 0, salesReads = 0, previewDelay = 0, previewReads = 0;
let accountRecords = [];
let account = { signed_in: false };
const json = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/account') return json(res, account);
  if (url.pathname === '/api/v1/account/data') {
    if (req.method === 'POST') {
      assert.equal(req.headers['x-csrf-token'], 'preview-fixture');
      let raw = ''; for await (const chunk of req) raw += chunk;
      for (const operation of JSON.parse(raw).operations) {
        accountRecords = accountRecords.filter(record => record.kind !== operation.kind || record.key !== operation.key);
        if (operation.value !== null) accountRecords.push({ ...operation, version: operation.version + 1 });
      }
    }
    return json(res, { records: accountRecords });
  }
  if (url.pathname === '/api/v1/events' || url.pathname === '/api/v1/account/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/dex/counts') return json(res, { items: 1, mobs: 1, maps: 1 });
  // The home price table; the second phase drops Eagle Crow from the list.
  if (url.pathname === '/api/v1/market') {
    salesReads++;
    const at = Date.now() / 1000;
    return json(res, { as_of: at, products: Array.from({ length: 8 }, (_, i) => {
      const eagle = !phase && !i;
      return { item_id: eagle ? 1462004 : 4010001 + i, name_en: eagle ? 'Eagle Crow' : 'Bronze Ore', name_zh: eagle ? '鹰弩' : '青铜母矿',
        category: eagle ? '装备' : '其他', sales_window: 20 - i, sales_10d: 20 - i, typical: 10000 + phase * 1000 + i, low: 9000 + i,
        last_seen: at - 60 * i, last_sale_at: at - 60 * i, trend: [], icon_url: '' };
    }) });
  }
  if (url.pathname === '/api/v1/catalog/page') {
    if (url.searchParams.get('preview') === 'true') previewReads++;
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
  browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const width of [390, 320, 1280]) {
    const mobile = width <= 640;
    phase = 0; previewDelay = 0; accountRecords = []; previewReads = 0; account = { signed_in: false };
    const page = await browser.newPage({ viewport: { width, height: mobile ? 640 : 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    await page.goto(`${origin}/?hours=all&lang=${mobile ? 'en' : 'zh'}`);
    await page.locator('.react-prices [data-item-row]:visible').first().waitFor();
    const row = page.locator('.react-prices a[href*="/item/1462004"]:visible');
    if (mobile) await row.tap(); else { await row.focus(); await page.keyboard.press('Alt+ArrowDown'); }
    const popup = page.locator('#item-quick-preview');
    await popup.locator('[data-preview-item="1462004"]').waitFor();
    assert(previewReads > 0, 'cards must request the lightweight snapshot');
    const watch = popup.locator('[data-preview-watch="1462004"]');
    const position = await watch.evaluate(button => {
      const header = button.closest('.peek-head');
      const box = button.getBoundingClientRect();
      const title = header?.querySelector('h2').getBoundingClientRect();
      const close = document.querySelector('.peek-close').getBoundingClientRect();
      return { inHeader: !!header, size: box.width >= 44 && box.height >= 44, aligned: title && box.left >= title.right && box.right <= close.left && box.top === close.top };
    });
    assert.deepEqual(position, { inHeader: true, size: true, aligned: true }, 'watch button sits to the right of the title, before close, without overlap');
    assert.equal(await popup.locator('.peek-footer button').count(), 0);
    await watch.click();
    assert.equal(await watch.getAttribute('aria-pressed'), 'true');
    assert.match(await watch.textContent(), mobile ? /Watching/ : /已关注/);
    assert.equal(await popup.isVisible(), true, 'watching must keep the preview open');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `preview-title-${width}.png`) });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('watchlist'))), [1462004]);
    await watch.click();
    assert.equal(await watch.getAttribute('aria-pressed'), 'false');
    const setWatches = ids => page.evaluate(ids => {
      localStorage.setItem('watchlist', JSON.stringify(ids));
      window.dispatchEvent(new StorageEvent('storage', { key: 'watchlist' }));
    }, ids);
    await setWatches([1462004]);
    await page.waitForFunction(() => document.querySelector('[data-preview-watch]').getAttribute('aria-pressed') === 'true');
    const fullList = Array.from({ length: 100 }, (_, i) => 2000000 + i);
    await setWatches(fullList);
    await page.waitForFunction(() => document.querySelector('[data-preview-watch]').disabled);
    assert.equal(await watch.isDisabled(), true, 'a full list cannot add a new item');
    await setWatches([1462004, ...fullList.slice(0, 99)]);
    await page.waitForFunction(() => !document.querySelector('[data-preview-watch]').disabled);
    await watch.click();
    assert.equal(await watch.getAttribute('aria-pressed'), 'false', 'a full list can still remove a watched item');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('watchlist')).length), 99);
    await setWatches([1462004]);
    await popup.locator('.peek-close').focus();
    await popup.evaluate(el => { window.savedPreview = el.firstElementChild.nextElementSibling; window.savedFocus = document.activeElement; el.scrollTop = 200; });
    const before = await popup.evaluate(el => ({ scroll: el.scrollTop, y: scrollY }));
    // The age-only render used to remove the anchor and close the preview too.
    await page.clock.fastForward(31000);
    assert.equal(await popup.isVisible(), true, 'age refresh must preserve the open preview');
    // SSE changes the actual recent-sales list, including removing this item.
    const reads = salesReads; phase = 1;
    for (const stream of streams) stream.write('event: market\ndata: {"version":2}\n\n');
    await page.waitForFunction(() => !document.querySelector('.react-prices a[href*="/item/1462004"]'));
    assert(salesReads > reads, 'the background list must still refresh from SSE');
    assert.equal(await popup.isVisible(), true, 'SSE must not close an item that leaves the price table');
    assert.equal(await watch.getAttribute('aria-pressed'), 'true', 'SSE preserves the watch state');
    assert.deepEqual(await popup.evaluate(el => ({ same: window.savedPreview === el.firstElementChild.nextElementSibling, scroll: el.scrollTop })), { same: true, scroll: before.scroll });
    assert.equal(await page.evaluate(() => window.savedFocus === document.activeElement), true, 'list refresh must not steal preview focus');
    assert.equal(await page.evaluate(() => scrollY), before.y, 'list refresh must not move the underlying page');
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 700 });
      assert.equal(await popup.isVisible(), true, 'mobile address-bar/viewport resize must not dismiss details');
      await page.keyboard.press('Tab');
      assert.equal(await popup.evaluate(el => el.contains(document.activeElement)), true, 'mobile focus stays inside the preview');
    }
    // Use the bundled account instance; importing the source file creates separate storage state.
    account = { signed_in: true, public_id: 'preview-account', csrf: 'preview-fixture' };
    await page.evaluate(async () => globalThis.cwmUserData.refreshIdentity());
    await page.waitForFunction(() => document.querySelector('[data-preview-watch]').getAttribute('aria-pressed') === 'false');
    assert.equal(await watch.getAttribute('aria-pressed'), 'false', 'account watches are isolated from guest watches');
    await watch.click();
    await page.evaluate(async () => globalThis.cwmUserData.flush());
    assert(accountRecords.some(record => record.kind === 'watch' && record.key === '1462004'), 'preview watches sync through the account API');
    account = { signed_in: false };
    await page.evaluate(async () => globalThis.cwmUserData.refreshIdentity());
    await page.waitForFunction(() => document.querySelector('[data-preview-watch]').getAttribute('aria-pressed') === 'true');
    assert.equal(await watch.getAttribute('aria-pressed'), 'true', 'signing out restores the guest watch state');
    await page.keyboard.press('Escape');
    assert.equal(await popup.isVisible(), false, 'Escape closes the preview');
    assert.equal(await page.locator('.peek-scrim').isVisible(), false);
    const next = page.locator('.react-prices a[href^="/item/4010"]:visible').first();
    if (mobile) await next.tap(); else { await next.focus(); await page.keyboard.press('Alt+ArrowDown'); }
    await popup.locator('[data-preview-item]').waitFor();
    assert.equal(await popup.locator('[data-preview-watch]').getAttribute('aria-pressed'), 'false', 'another item gets its own watch state');
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
    await page.reload(); await page.locator('.react-prices [data-item-row]:visible').first().waitFor();
    if (mobile) await row.tap(); else { await row.focus(); await page.keyboard.press('Alt+ArrowDown'); }
    phase = 1; for (const stream of streams) stream.write('event: market\ndata: {"version":3}\n\n');
    await page.waitForFunction(() => !document.querySelector('.react-prices a[href*="/item/1462004"]'));
    await popup.locator('[data-preview-item="1462004"]').waitFor();
    assert.equal(await popup.isVisible(), true, 'in-flight preview survives a replaced list');
    assert.equal(await popup.locator('[data-preview-watch]').getAttribute('aria-pressed'), 'true', 'watch state survives reload');
    await popup.locator('.peek-footer a').click();
    await page.waitForURL(url => url.pathname === '/item/1462004' && url.searchParams.get('hours') === 'all');
    await page.locator('.item-stall h1').waitFor();
    assert.match(await page.locator('.item-stall h1').textContent(), /Eagle Crow|鹰弩/);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px ${mobile ? 'mobile / English' : 'desktop / Chinese'}: title watch button, account sync, limits, persistence, time tick, SSE, scrolling, dismissal and full-page navigation`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await new Promise(resolve => server.close(resolve));
}
