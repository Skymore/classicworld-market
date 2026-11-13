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
    if (url.pathname === '/api/v1/shop') {
      const i = Number(url.searchParams.get('key').split('-').at(-1));
      data = { shop_key: 'fixture-'+i, title: 'Fixture shop '+i, channel: 24, room: 10,
        items: [{ item_id: 1452003, name_en: 'Battle Bow', slot: i, bundle: 1, price: i ? 6000 : 3000, stock: 2, time: now-i*60,
          variant: { id: 'variant-'+i, stats: [{key:'weapon_attack',value:50+i},{key:'dex',value:2}], remaining_upgrades:7, enhancements:1 } }] };
    }
    if (url.pathname === '/api/v1/catalog/page') {
      const target = new URL(url.searchParams.get('url'), 'http://localhost');
      const id = Number(target.pathname.split('/').at(-1));
      data = { kind: 'item', page: { item: { id, name_en: catalog.items[id]?.name_en || 'Red Potion', category: '装备' }, stats: null, droppers: [], npc_offers: [], npc_sell: null,
        equipment: id === 1452003 ? { req: { level: 25, str: 0, dex: 65, int: 0, luk: 0 }, jobs: 4, weapon: true, kind: '弓', kind_en: 'Bow', attack_speed: 6, upgrades: 7 } : undefined, market: { as_of: now, base_stats: [], days, sale_points: days.map((_,day)=>({day,price:8000+day*100})), listings: [3000,6000,3000].map((price,index)=>{const i=index===2?0:index;return {shop_key:'fixture-'+i,visit_id:'snapshot-'+i,slot:index,bundle:1,source:'packet',shop:'Fixture shop '+i,channel:24,room:10,unit_price:price,stock:1+i,seen_at:new Date((now-i*60)*1000).toISOString(),variant:{id:'variant-'+i,stats:[{key:'weapon_attack',value:50+i},{key:'dex',value:2}],remaining_upgrades:7,enhancements:1}}}), sales: [] } } };
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
  browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/item/1452003?lang=en');
    const source=page.locator('details.src-well'),where=page.locator('details.where-well');
    await source.waitFor();
    assert.equal(await page.locator('.where-well .market-record').count(),2,'identical slots merge while different equipment remains separate');
    assert.equal(await page.locator('.where-well .record-stock').first().textContent(),'Stock 2');
    for(const section of [source,where]){
      assert(await section.evaluate(node=>node.open),'item sections start expanded');
      await section.locator(':scope > summary').click();assert.equal(await section.getAttribute('open'),null);
      await section.locator(':scope > summary').click();assert(await section.evaluate(node=>node.open));
    }
    if(mobile)for(const width of [320,390,430]){
      await page.setViewportSize({width,height:844});
      assert(await page.locator('.mobile-item-search').evaluate(node=>{const outer=node.getBoundingClientRect(),inner=node.querySelector('.finder').getBoundingClientRect();return Math.abs(outer.left-inner.left)<1&&Math.abs(outer.right-inner.right)<1;}),'item search fills the entire available width');
    }
    await page.setViewportSize({width:mobile?390:1280,height:844});
    assert.equal(await where.locator('.where-tools').evaluate(node=>getComputedStyle(node).display),'grid','sorting and filters share a compact aligned toolbar');
    if(mobile)assert.equal(await page.locator('[data-offer-sort]').evaluate(node=>getComputedStyle(node).fontSize),'16px','native sort controls do not zoom the phone viewport');
    // Row anatomy of the flat list; the default stat-set view is covered in item-offer-filters.
    await where.locator('[data-offer-view=list]').click();
    await page.locator('[data-offer-sort]').selectOption('recent');
    const quotes=where.locator('.variant-record');assert.equal(await quotes.count(),2);
    const quote=quotes.first();assert.equal(await quote.locator('.slot,.ware-name,.name-secondary').count(),0,'same-item variant rows omit repeated identity');
    assert.equal(await quote.locator('.record-shop').textContent(),'Fixture shop 0');assert.equal(await quote.locator('.loc b').textContent(),'CH 24');assert.equal(await quote.locator('.ware-price').textContent(),'3K');assert.match(await quote.locator('.record-stock').textContent(),/2$/);
    assert.match(await quote.locator('.offer-equipment').textContent(),/物攻|Weapon ATK/);
    assert.equal(await quote.locator('.loc-room').textContent(),'FM10');
    assert(await quotes.locator('.loc-shop').evaluateAll(nodes=>nodes.every(node=>{const widths=[...node.children].map(child=>child.getBoundingClientRect().width);return widths.length===3&&widths[0]===50&&widths[1]===44&&Math.abs(widths.reduce((a,b)=>a+b,0)-node.clientWidth)<1;})),'compact variants align CH/FM columns across rows and let the shop column fill the remaining frame');
    assert.deepEqual(await quote.locator('.record-value').evaluate(node=>[...node.children].map(child=>child.className)),['ware-price','record-stock'],'variant price and stock occupy only two lines');
    const compactShop=quote.locator('.record-shop'),originalShop=await compactShop.textContent();
    await compactShop.locator('.record-shop-text').evaluate(node=>node.textContent='hi');
    assert(await compactShop.evaluate(node=>node.getBoundingClientRect().width<48&&node.parentElement.getBoundingClientRect().width<node.closest('.record-meta').getBoundingClientRect().width-10),'compact shop cells also fit short names with their icon');
    await compactShop.locator('.record-shop-text').evaluate((node,title)=>node.textContent=title,originalShop);
    for(const width of mobile?[320,390,430]:[1280]){
      await page.setViewportSize({width,height:844});
      assert(await quotes.evaluateAll(nodes=>nodes.every(node=>{
        const bounds=node.getBoundingClientRect(),location=node.querySelector('.record-meta').getBoundingClientRect(),time=node.querySelector('.record-detail .record-time').getBoundingClientRect(),detail=node.querySelector('.record-detail').getBoundingClientRect();
        return bounds.height<=55&&time.top>=location.bottom&&time.left>=location.left&&time.right<=location.right&&detail.height<20&&node.querySelectorAll('.record-value .record-time').length===0;
      })),'variant time sits below location without creating a third line or increasing the compact row height');
    }
    await page.setViewportSize({width:mobile?390:1280,height:844});
    // Desktop hover previews the captured piece; tapping a local offer opens its shop on both layouts.
    assert.equal(await where.locator('details.listing-offer').count(),0,'listing rows no longer expand inline');
    const pieceRow=where.locator('.listing-offer .piece-record').first(),pieceCard=page.locator('.item-peek.is-piece [data-equipment-card]');
    if(!mobile){
      await pieceRow.hover();await pieceCard.waitFor();
      assert(!(await page.locator('.item-peek').evaluate(node=>node.classList.contains('is-pinned'))),'hover shows an unpinned tooltip');
      const [row,card]=await Promise.all([pieceRow.boundingBox(),page.locator('.item-peek').boundingBox()]);
      assert(card.x>=row.x+row.width||card.x+card.width<=row.x,'the tooltip sits beside the row, not over the rows below');
    }
    // The explicit keyboard shortcut still opens a pinned piece preview, including the phone sheet.
    await pieceRow.focus();await pieceRow.press('Alt+ArrowDown');await pieceCard.waitFor();
    assert(await page.locator('.item-peek').evaluate((node,mobile)=>node.classList.contains(mobile?'is-mobile':'is-pinned'),mobile),'the keyboard shortcut pins the preview');
    assert.match(await pieceCard.locator('.eq-title').innerText(),/\(\+1\)$/,'the title carries the enhancement count');
    assert.match(await pieceCard.locator('.eq-lines dd').first().innerText(),/^(弓|Bow)$/,'the weapon type comes from the catalogue reference');
    assert.equal(await pieceCard.locator('[data-stat=upgrades] dd').innerText(),'7','the piece keeps its own remaining upgrades');
    assert.deepEqual(await pieceCard.locator('.eq-jobs span').evaluateAll(spans=>spans.map(span=>span.classList.contains('on'))),[false,false,false,true,false],'only the bowman job is lit');
    assert.deepEqual(await pieceCard.locator('.eq-req .zero').count(),3,'zero requirements are dimmed');
    const offer=pieceCard.locator('[data-piece-offer]');
    assert.match(await offer.locator('.eq-offer-loc').innerText(),/^(24频道\s*10洞|CH 24\s*FM10)$/,'the tooltip says where the piece is listed');
    assert.match(await offer.locator('.eq-offer-shop').innerText(),/^Fixture shop \d$/,'and in which shop');
    assert.match(await offer.locator('.eq-offer-meta').innerText(),/3,000 (金币|mesos)\s*(库存|Stock) \d/,'with its price and stock');
    assert.equal(await page.locator('.item-peek .peek-footer').count(),0,'no link back to the page the user is on');
    await page.keyboard.press('Escape');await page.locator('.item-peek').waitFor({state:'hidden'});
    // Tap the price side: the shop name is its own owner-name toggle button.
    await pieceRow.click({position:{x:(await pieceRow.boundingBox()).width-24,y:20}});
    const shop=page.locator('.sv-dialog'),shopCard=shop.locator('[data-equipment-card]');
    await shopCard.waitFor();
    assert.equal(await page.locator('.item-peek').isVisible(),false,'opening a shop dismisses the hover preview');
    assert.equal(await shop.locator('#sv-title').innerText(),'Fixture shop 0');
    assert.match(await shop.locator('.sv-loc').innerText(),/CH 24\s*FM10/);
    assert.match(await shopCard.locator('.eq-title').innerText(),/\(\+1\)$/);
    assert.equal(Number(await shopCard.locator('[data-stat=weapon_attack] dd').innerText()),50);
    assert.equal(await shopCard.locator('[data-stat=upgrades] dd').innerText(),'7');
    assert.match(await shopCard.locator('.eq-offer-meta').innerText(),/3,000 mesos\s*Stock 2/);
    await shop.getByRole('button',{name:'Next shop',exact:true}).click();
    await page.waitForFunction(()=>Number(document.querySelector('.sv-info [data-stat=weapon_attack] dd')?.textContent)===51);
    assert.equal(await shop.locator('#sv-title').innerText(),'Fixture shop 1');
    assert.match(await shopCard.locator('.eq-offer-meta').innerText(),/6,000 mesos\s*Stock 2/);
    await shop.getByRole('button',{name:'Previous shop',exact:true}).click();
    await page.waitForFunction(()=>Number(document.querySelector('.sv-info [data-stat=weapon_attack] dd')?.textContent)===50);
    await page.keyboard.press('Escape');await shop.waitFor({state:'hidden'});
    await page.locator('[data-offer-filter-open]').click();const dialog=page.locator('#offer-filter-dialog');await dialog.locator('[name=maxPrice]').fill('4000');
    await dialog.locator('[data-offer-apply]').click();assert.equal(await where.locator('.variant-record').count(),1);
    await page.locator('[data-offer-clear=all]').click();assert.equal(await where.locator('.variant-record').count(),2);
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
    const material=craft.locator('.craft-material').first(),materialPreview=page.locator('#item-quick-preview');
    if(mobile)await material.tap();else await material.hover();
    await materialPreview.locator(`[data-preview-item="${bow.ingredients[0].item_id}"]`).waitFor();
    assert.equal(new URL(page.url()).pathname,'/item/1452003','previewing a material keeps the recipe open');
    assert.equal(await materialPreview.locator('.peek-footer a').getAttribute('href'),`/item/${bow.ingredients[0].item_id}?hours=all`);
    await page.keyboard.press('Escape');await materialPreview.waitFor({state:'hidden'});
    assert(await craft.evaluate(node=>node.open),'closing a material preview preserves the expanded recipe');
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
    assert(!/Verify stats|属性是客户端|报价来自摊位快照/.test(await page.locator('main').textContent()));
    if(mobile){
      const nav=await page.locator('.dock .dock-icon svg').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {top:r.top,width:r.width,height:r.height};}));
      assert.equal(nav.length,6);assert(nav.every(r=>r.width===24&&r.height===24&&Math.abs(r.top-nav[0].top)<1),'all six dock icons, including grind, share one size and baseline');
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
    await source.locator(':scope > summary').click();await where.locator(':scope > summary').click();
    const foldedRefresh=page.waitForResponse(response=>response.url().endsWith('/api/v1/crafting/prices'));
    for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
    await (await foldedRefresh).finished();
    assert.equal(await source.getAttribute('open'),null,'SSE preserves collapsed Sources');assert.equal(await where.getAttribute('open'),null,'SSE preserves collapsed Where to buy');
    await source.locator(':scope > summary').click();await where.locator(':scope > summary').click();
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
    await page.goto(origin + '/item/1452003?lang=zh');
    await page.locator('.where-well .market-record').first().waitFor();
    await page.locator('[data-offer-sort]').selectOption('price');
    assert.equal(await page.locator('.where-well .loc b').first().textContent(),'24频道');
    assert.equal(await page.locator('.where-well .loc-room').first().textContent(),'10洞');
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
