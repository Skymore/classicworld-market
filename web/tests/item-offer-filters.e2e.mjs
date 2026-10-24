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
  { id: 'fresh', ch: '35', room: 1, price: 22200, age: 360, equipment: true },
  { id: 'newer', ch: '36', room: 2, price: 22200, age: 120 },
  { id: 'stale', ch: '4', room: 18, price: 15000, age: 60 * 3600 },
  { id: 'expensive', ch: '35', room: 2, price: 80000, age: 60 },
  { id: 'unknown', ch: 'unknown', room: 3, price: 10000, age: 1200 },
];
let offers = original, revision = 0;
const streams = new Set();
const row = (r, en) => {
  const content = `<span class="lshop">${r.id}</span><span class="lroom">${en ? `room ${r.room}` : `${r.room}洞`}</span><span class="lp">${r.price}</span><span class="lq">×1</span><span class="la" data-relative-time="${now - r.age}"></span>`;
  const attrs = `data-quote="${r.id}" data-unit-price="${r.price}" data-observed="${now - r.age}"`;
  return r.equipment ? `<details class="listing-offer" data-offer="${r.id}" ${attrs}><summary class="lrow">${content}</summary><div class="offer-body">Attack +17</div></details>` : `<div class="lrow" ${attrs}>${content}</div>`;
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
    const url = origin + `/item/2000000?hours=all&lang=${mobile ? 'zh' : 'en'}&device=${mobile ? 'phone' : 'desktop'}`;
    const visibleRows = () => page.locator('.where-well [data-quote]:visible').evaluateAll(els => els.map(el => el.dataset.quote));
    await page.goto(url);
    await page.waitForFunction(rev => document.querySelector('.item-stall').dataset.mark === String(rev), revision);
    assert.equal(await page.locator('[data-offer-time-filter]').isVisible(), true);
    assert.equal(await page.locator('[data-offer-price-filter]').isVisible(), false);
    await page.selectOption('[data-offer-hours]', '1');
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '4 条挂单 · 4 摊' : '4 listings · 4 shops');
    assert.equal(await page.locator('.cgroup[data-ch-key="4"]').isVisible(), false);
    assert.equal(await page.locator('.cgroup[data-ch-key="35"] .cg-min b').textContent(), '22.2K');
    assert.equal(await page.locator('.cgroup[data-ch-key="35"] .hole.lit').count(), 2);
    assert.equal(await page.locator('.cgroup[data-ch-key="35"] .hole.best i').textContent(), '1');
    await page.locator('[data-offer="fresh"] summary').click();
    await page.screenshot({ path: path.join(output, `time-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    await page.selectOption('[data-offer-sort]', 'recent');
    assert.deepEqual(await visibleRows(), ['expensive', 'newer', 'fresh', 'unknown', 'old-cheap', 'old-high', 'stale']);
    assert.equal(await page.locator('[data-offer="fresh"]').getAttribute('open'), '');
    await page.selectOption('[data-offer-percentile]', '50');
    assert.deepEqual(await visibleRows(), ['newer', 'fresh', 'unknown', 'old-cheap', 'stale']);
    assert.match(await page.locator('[data-offer-filter-note]').textContent(), /22,200/);
    if (mobile) {
      for (const width of [320, 375, 430]) {
        await page.setViewportSize({ width, height: 812 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `recent list overflows at ${width}`);
      }
      await page.setViewportSize({ width: 375, height: 812 });
    }
    await page.screenshot({ path: path.join(output, `percentile-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    await page.reload();
    await page.waitForFunction(rev => document.querySelector('.item-stall').dataset.mark === String(rev), revision);
    assert.equal(await page.locator('[data-offer-sort]').inputValue(), 'recent');
    assert.equal(await page.locator('[data-offer-percentile]').inputValue(), '50');
    assert.equal((await visibleRows()).length, 5);
    offers = [...original, { id: 'incoming', ch: '35', room: 3, price: 12000, age: 0 }]; revision++; broadcast();
    await page.waitForFunction(rev => document.querySelector('.item-stall').dataset.mark === String(rev), revision);
    assert.deepEqual(await visibleRows(), ['incoming', 'unknown', 'old-cheap', 'stale']);
    assert.equal(await page.locator('[data-offer-percentile]').inputValue(), '50');
    await page.selectOption('[data-offer-sort]', 'price');
    assert.equal(await page.locator('[data-offer-hours]').inputValue(), '1');
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '5 条挂单 · 5 摊' : '5 listings · 5 shops');
    assert.equal(await page.locator('.cgroup[data-ch-key="35"] .cg-min b').textContent(), '12K');
    offers = original.map(row => ({ ...row, age: row.age + 7200 })); revision++; broadcast();
    await page.waitForFunction(rev => document.querySelector('.item-stall').dataset.mark === String(rev), revision);
    assert.equal(await page.locator('[data-offer-empty]').isVisible(), true);
    assert.deepEqual(await visibleRows(), []);
    await page.selectOption('[data-offer-hours]', 'all');
    assert.equal(await page.locator('[data-offer-empty]').isVisible(), false);
    assert.equal(await page.locator('.well-h small').textContent(), mobile ? '7 条挂单 · 7 摊' : '7 listings · 7 shops');
    offers = Array.from({ length: 10 }, (_, i) => ({ id: `channel-${i}`, ch: String(i + 1), room: 1, price: i + 1, age: i < 3 ? 60 : 7200 })); revision++; broadcast();
    await page.waitForFunction(rev => document.querySelector('.item-stall').dataset.mark === String(rev), revision);
    assert.equal(await page.locator('.cgroup:visible').count(), mobile ? 6 : 8);
    assert.match(await page.locator('[data-more]:visible').textContent(), mobile ? /4/ : /2/);
    await page.selectOption('[data-offer-hours]', '1');
    assert.equal(await page.locator('.cgroup:visible').count(), 3);
    assert.equal(await page.locator('[data-more]:visible').count(), 0);
    for (const width of mobile ? [320, 375, 430] : [1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `layout overflow at ${width}`);
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'mobile Chinese' : 'desktop English'}: time, percentiles, ties, minima, room map, reload, live updates, empty state, pagination, layout`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await new Promise(resolve => server.close(resolve));
}
