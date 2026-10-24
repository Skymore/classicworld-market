// Isolated SSR-shaped fixture; tests the actual item page module and live swaps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(root, '../market_data/offer-filter-review');
await mkdir(output, { recursive: true });
const now = Math.floor(Date.now() / 1000);
const original = [
  { id: 'old-cheap', ch: '4', room: 18, price: 20000, age: 30 * 3600 },
  { id: 'old-high', ch: '4', room: 5, price: 50000, age: 30 * 3600 },
  { id: 'fresh', ch: '35', room: 1, price: 22200, age: 360, equipment: true, captured: true, stock: 5 },
  { id: 'newer', ch: '36', room: 2, price: 22200, age: 120 },
  { id: 'stale', ch: '4', room: 18, price: 15000, age: 60 * 3600, equipment: true },
  { id: 'expensive', ch: '35', room: 2, price: 80000, age: 60 },
  { id: 'unknown', ch: 'unknown', room: 3, price: 10000, age: 1200, stock: null },
];
let offers = original, revision = 0;
const streams = new Set();
const row = (r, en) => {
  const content = `<span class="lshop">${r.id}</span><span class="lroom">${en ? `room ${r.room}` : `${r.room}洞`}</span><span class="lp">${r.price}</span><span class="lq">${r.stock === null ? '—' : '×' + (r.stock ?? 1)}</span><span class="la" data-relative-time="${now - r.age}"></span>`;
  const attrs = `data-quote="${r.id}" data-unit-price="${r.price}" data-observed="${now - r.age}"`;
  return r.equipment ? `<details class="listing-offer" data-offer="${r.id}" data-bonus="${r.captured ? 1 : 0}" ${attrs}><summary class="lrow">${content}</summary><div class="offer-body">${r.captured ? '<div class="tip">Attack +17</div>' : 'Stats not captured'}</div></details>` : `<div class="lrow" ${attrs}>${content}</div>`;
};
function section(en) {
  const channels = [...new Set(offers.map(r => r.ch))];
  const groups = channels.map((ch, index) => `<div class="cgroup ${index === 0 ? 'open' : ''}" data-ch-key="${ch}">
    <button class="cg-head" data-ch aria-expanded="${index === 0}"><span class="chno">CH ${ch}</span><span class="cg-meta"></span><span class="cg-min">${en ? 'from' : '最低'} <b></b></span></button>
    <div class="cg-body">${ch === 'unknown' ? '' : `<div class="holes">${Array.from({ length: 22 }, (_, i) => `<span class="hole"><i>${i + 1}</i></span>`).join('')}</div>`}<div class="cg-list">${offers.filter(r => r.ch === ch).map(r => row(r, en)).join('')}</div></div></div>`).join('');
  return `<div data-market="where"><section class="well where-well"><div class="well-h"><h3>${en ? 'Where to buy' : '在哪买'}</h3><small></small><label class="sortb right"><select data-offer-sort aria-label="Offer order"><option value="price">${en ? 'Lowest price first' : '最低价优先'}</option><option value="recent">${en ? 'Latest offers first' : '最新报价优先'}</option></select></label></div><div class="legend"><span><i></i>${en ? 'In stock (lowest room price)' : '有货（数字为该洞最低价）'}</span></div>${groups}${channels.length > 6 ? '<button class="more on-phone" data-more="where">More <span>›</span></button>' : ''}${channels.length > 8 ? '<button class="more on-desktop" data-more="where">More <span>›</span></button>' : ''}</section></div>`;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ product: { revision }, listings: offers }));
  }
  if (url.pathname.startsWith('/web/')) {
    const file = path.resolve(root, '.' + url.pathname.slice(4));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(await readFile(file)); }
    catch { res.writeHead(404); return res.end(); }
  }
  const en = url.searchParams.get('lang') === 'en';
  const market = section(en);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.searchParams.has('part')) return res.end(`<div data-mark="${revision}" data-as-of="${now}">${market}</div>`);
  res.end(`<!doctype html><html lang="${en ? 'en' : 'zh-CN'}" data-lang="${en ? 'en' : 'zh'}" data-device="${url.searchParams.get('device') || 'phone'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/web/css/base.css"><link rel="stylesheet" href="/web/css/dex.css"><link rel="stylesheet" href="/web/css/item.css"><script type="module" src="/web/js/pages/item.js"></script></head><body><main class="pmain"><section class="stall item-stall ipage" data-item="2000000" data-as-of="${now}"><div class="stall-bar"><h2>${en ? 'Item details' : '物品详情'}</h2><button data-star aria-pressed="false">★</button></div><div class="ibox">${market}</div></section></main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const broadcast = () => { for (const stream of streams) stream.write('event: market\ndata: {}\n\n'); };
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    offers = original; revision++;
    const page = await browser.newPage({ viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.selectFocusCalls = 0;
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function(...args) { if (this.tagName === 'SELECT') window.selectFocusCalls++; return focus.apply(this, args); };
    });
    const url = origin + `/item/2000000?hours=all&lang=${mobile ? 'zh' : 'en'}&device=${mobile ? 'phone' : 'desktop'}`;
    const visibleRows = () => page.locator('.where-well [data-quote]:visible').evaluateAll(els => els.map(el => el.dataset.quote));
    const waitRevision = () => page.waitForFunction(rev => document.querySelector('.item-stall').dataset.mark === String(rev), revision);
    const open = async () => { await page.locator('[data-offer-filter-open]').click(); await page.locator('dialog[open]').waitFor(); };
    const submit = async () => { await page.locator('[data-offer-apply]').click(); await page.locator('dialog[open]').waitFor({state:'hidden'}); };
    await page.goto(url); await waitRevision();
    if (!mobile) await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    assert.equal(await page.locator('.offer-filter-summary').isVisible(), false);
    const placement = await page.locator('.offer-actions').evaluate(el => {
      const sort = el.querySelector('[data-offer-sort]').getBoundingClientRect(), button = el.querySelector('[data-offer-filter-open]').getBoundingClientRect();
      return button.left >= sort.right && Math.abs(button.top - sort.top) < 2;
    });
    assert(placement, 'filter button must sit next to the sort select');
    await open();
    assert.equal(await page.locator('dialog [name=channels],dialog [name=room],dialog [name=shop]').count(), 0);
    assert.equal(await page.locator('[data-offer-hours]').isVisible(), true);
    assert.equal(await page.locator('[data-offer-percentile]').isVisible(), true);
    await page.selectOption('[data-offer-hours]', '1');
    assert.match(await page.locator('[data-offer-apply]').textContent(), /4/);
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '7 条挂单 · 7 摊' : '7 listings · 7 shops', 'draft conditions do not change results before applying');
    await page.screenshot({path:path.join(output, `advanced-panel-${mobile?'mobile':'desktop'}.png`),fullPage:false});
    await submit();
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '4 条挂单 · 4 摊' : '4 listings · 4 shops');
    assert.equal(await page.locator('.cgroup[data-ch-key="4"]').isVisible(), false);
    assert.equal(await page.locator('.cgroup[data-ch-key="35"] .cg-min b').textContent(), '22.2K');
    assert.equal(await page.locator('.cgroup[data-ch-key="35"] .hole.lit').count(), 2);
    await open(); await page.selectOption('[data-offer-percentile]', '50'); await submit();
    await page.selectOption('[data-offer-sort]', 'recent');
    assert.deepEqual(await visibleRows(), ['newer', 'fresh', 'unknown']);
    assert.equal(await page.locator('[data-offer-filter-open] b').textContent(), '2');
    await page.locator('[data-offer-clear=hours]').click();
    assert.deepEqual(await visibleRows(), ['newer', 'fresh', 'unknown', 'old-cheap', 'stale']);
    await open();
    await page.locator('dialog [name=maxPrice]').fill('20000');
    await page.selectOption('dialog [name=stock]', 'unknown');
    assert.match(await page.locator('[data-offer-apply]').textContent(), /1/);
    await submit(); assert.deepEqual(await visibleRows(), ['unknown']);
    await open(); await page.locator('[data-offer-reset]').click();
    await page.keyboard.press('Escape');
    assert.deepEqual(await visibleRows(), ['unknown'], 'cancel discards reset draft');
    assert.equal(await page.locator('[data-offer-filter-open]').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-offer-clear=all]').click();
    await open();
    await page.selectOption('[data-offer-hours]', '1');
    await page.locator('dialog [name=minPrice]').fill('20000');
    await page.locator('dialog [name=maxPrice]').fill('30000');
    await page.locator('dialog [name=minStock]').fill('5');
    await page.selectOption('dialog [name=equipment]', 'captured');
    await submit(); assert.deepEqual(await visibleRows(), ['fresh']);
    await page.selectOption('[data-offer-sort]', 'price');
    assert.deepEqual(await visibleRows(), ['fresh'], 'all conditions survive sort changes');
    await page.reload(); await waitRevision();
    assert.deepEqual(await visibleRows(), ['fresh'], 'all conditions survive reload');
    offers = [...original, { id:'incoming',ch:'35',room:3,price:24000,age:0,stock:10,equipment:true,captured:true }]; revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '2 条挂单 · 2 摊' : '2 listings · 2 shops');
    await open(); await page.locator('dialog [name=maxPrice]').fill('23000');
    const focusBefore = await page.evaluate(() => window.selectFocusCalls);
    offers = [...offers, {id:'live-draft',ch:'35',room:4,price:22000,age:0,stock:9,equipment:true,captured:true}]; revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(await page.locator('dialog [name=maxPrice]').inputValue(), '23000');
    assert.match(await page.locator('[data-offer-apply]').textContent(), /2/);
    assert.equal(await page.evaluate(() => window.selectFocusCalls), focusBefore, 'live refresh never refocuses native selects');
    for (const width of mobile ? [320,375,430] : [1280]) {
      await page.setViewportSize({width,height:812});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    }
    if (mobile) {
      await page.setViewportSize({width:375,height:480});
      assert(await page.locator('.offer-filter-foot').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'apply button remains visible in a short viewport');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '3 条挂单 · 3 摊' : '3 listings · 3 shops');
    offers = original.map(row => ({...row,age:row.age+7200})); revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('[data-offer-empty]').isVisible(), true);
    await page.locator('[data-offer-clear=all]').click();
    assert.equal(await page.locator('[data-offer-empty]').isVisible(), false);
    offers = Array.from({length:10},(_,i)=>({id:`channel-${i}`,ch:String(i+1),room:1,price:i+1,age:i<3?60:7200})); revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('.cgroup:visible').count(), mobile ? 6 : 8);
    await open(); await page.selectOption('[data-offer-hours]','1'); await submit();
    assert.equal(await page.locator('.cgroup:visible').count(), 3);
    assert.equal(await page.locator('[data-more]:visible').count(), 0);
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${mobile?'mobile Chinese':'desktop English'}: adjacent button, draft/apply/reset, combined filters, sort independence, reload, realtime dialog, room map, pagination and layout`);
  }
} finally {
  await browser?.close(); for (const stream of streams) stream.end();
  await new Promise(resolve => server.close(resolve));
}
