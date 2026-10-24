// Exercise native React crafting, market refreshes and shareable list filters.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.CRAFTING_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const catalog = JSON.parse(await readFile(path.join(root, 'data/crafting.json')));
const bow = catalog.recipes.find(row => row.item_id === 1452003);
const prices = bow.ingredients.map((row, i) => ({ item_id: row.item_id, market_price: [300, 2300, 600, 250][i], name_en: catalog.items[row.item_id].name_en, name_zh: ['加工木材','铁锭','黄晶','螺丝'][i], icon_url: '/web/img/favicon.svg' }));
prices.push({ item_id: bow.item_id, market_price: 8000, name_en: 'Battle Bow' });
const now = Date.now() / 1000;
let priceReads = 0, missing = false;
const days = Array.from({length:7},(_,i)=>({date:`2026-10-${18+i}`,median:8000,low:7000,high:9000,count:1}));
const output=process.env.CRAFTING_SCREENSHOTS;
if(output)await mkdir(output,{recursive:true});
const streams = new Set();
const products = [1452003, 2000000].map(item_id => ({ item_id, name_en: item_id === 1452003 ? 'Battle Bow' : 'Red Potion', category: item_id === 1452003 ? '装备' : '消耗品', sales_window: 15, typical: 8000, low: 7000, last_seen: now, trend: [] }));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/crafting/prices') { priceReads++; data = { as_of: now, prices: missing ? prices.filter(row=>row.item_id!==bow.ingredients[0].item_id) : prices }; }
    if (url.pathname === '/api/v1/market') data = { as_of: now, products };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all' };
    if (url.pathname === '/api/v1/sales/recent') data = { generated_at: now, sales: [] };
    if (url.pathname === '/api/v1/catalog/page') {
      const target = new URL(url.searchParams.get('url'), 'http://localhost');
      const id = Number(target.pathname.split('/').at(-1));
      data = { kind: 'item', page: { item: { id, name_en: catalog.items[id]?.name_en || 'Red Potion', category: '装备' }, stats: null, droppers: [], npc_offers: [], npc_sell: null, market: { as_of: now, base_stats: [], days, sale_points: days.map((_,day)=>({day,price:8000+day*100})), listings: [], sales: [] } } };
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
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/item/1452003?lang=en');
    const craft=page.locator('.src-well details[data-crafting="1452003"]');
    const total=craft.locator('[data-craft-total]');
    await page.waitForFunction(()=>document.querySelector('[data-craft-total]')?.title==='17150');
    assert.equal(await craft.getAttribute('open'),null,'crafting is collapsed by default inside Sources');
    assert.equal(await craft.locator('input,select,textarea').count(),0,'crafting has no editable controls');
    assert.equal(await craft.locator('.craft-body').isVisible(),false);
    await craft.locator('summary').click();
    assert.equal(await craft.locator('.craft-material').count(),4);
    assert.equal(await craft.locator('.craft-material img').count(),4);
    assert.equal(await craft.locator('.craft-recipe-meta').count(),0,'no repeated discipline and output row');
    for(const width of mobile?[320,390,430]:[1280]){
      await page.setViewportSize({width,height:844});
      const cards=await craft.locator('.craft-material').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {top:box.top,right:box.right,overflow:node.scrollWidth>node.clientWidth};}));
      assert(cards.every(card=>card.top===cards[0].top&&!card.overflow&&card.right<=width),'four compact bilingual materials stay on one row');
    }
    await page.setViewportSize({width:mobile?390:1280,height:844});
    const materialNames=await craft.locator('.craft-material').first().textContent();
    assert(materialNames.includes('加工木材')&&materialNames.includes('Processed Wood'),'both material names are present');
    assert(await craft.locator('.craft-material').first().evaluate(node=>node.querySelector('.name-stack').getBoundingClientRect().top>=node.querySelector('img').getBoundingClientRect().bottom));
    assert(!/Craft EXP|制作经验|enter unit|单价留空|数据收录/.test(await craft.textContent()));
    const before=priceReads;
    const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/v1/crafting/prices'));
    for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
    await (await refreshed).finished();
    assert(priceReads>before);
    assert(await craft.evaluate(node=>node.open),'SSE keeps the disclosure open');
    assert.equal(await total.getAttribute('title'),'17150');
    const dates=page.locator('[data-ladder-date]');
    assert.equal(await dates.count(),7);
    const bounds=await dates.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:node.scrollWidth>node.clientWidth};}));
    assert(bounds.every((r,i)=>!r.overflow&&(i===0||r.left>=bounds[i-1].right-1)),'date columns do not overlap');
    assert(!/Verify stats|属性是采集器|报价来自摊位快照/.test(await page.locator('main').textContent()));
    if(mobile){
      const nav=await page.locator('.dock .dock-icon svg').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {top:r.top,width:r.width,height:r.height};}));
      assert.equal(nav.length,6);assert(nav.every(r=>r.width===24&&r.height===24&&Math.abs(r.top-nav[0].top)<1),'six dock icons share one size and baseline');
    }
    if(output){await craft.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`crafting-${mobile?'phone':'desktop'}.png`)});}
    missing=true;
    const incomplete=page.waitForResponse(response=>response.url().endsWith('/api/v1/crafting/prices'));
    for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
    await (await incomplete).finished();
    await page.waitForFunction(()=>document.querySelector('[data-craft-total]')?.title==='');
    assert.equal(await craft.locator('.craft-comparison').count(),0,'unknown material prices suppress savings');
    await craft.locator('summary').click();
    missing=false;
    const restored=page.waitForResponse(response=>response.url().endsWith('/api/v1/crafting/prices'));
    for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
    await (await restored).finished();
    assert.equal(await craft.getAttribute('open'),null,'SSE keeps the disclosure closed');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'crafting and dates fit the viewport');
    await page.goto(origin+'/item/1072112?lang=en');
    const five=page.locator('.src-well details[data-crafting="1072112"]');
    await five.locator('summary').click();
    assert.equal(await five.locator('.craft-material').count(),5);
    const tops=await five.locator('.craft-material').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));
    assert(tops.every(top=>top===tops[0]),'five ingredients fit on one row when space permits');
    await page.goto(origin + '/prices?craft=1&few=0&lang=en');
    await page.locator('.react-prices').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-craft-only]')?.getAttribute('aria-pressed') === 'true');
    const list = page.locator(mobile ? '.react-price-mobile[data-list="all"]' : '.react-price-desktop tbody[data-list="all"]');
    await list.locator('a[href*="/item/1452003"]').first().waitFor();
    assert.equal(await list.locator('a[href*="/item/2000000"]').count(), 0);
    await page.reload();
    await page.locator('.craft-label:visible').first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get('craft'), '1');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'}: folded readonly crafting in Sources, bilingual material pictures, exact prices, SSE disclosure state, date columns, aligned navigation and persistent filters`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
