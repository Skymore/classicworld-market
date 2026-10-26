import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const screenshots = process.env.REACT_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const streams = new Set();
const now = Date.now() / 1000;
const product = { item_id: 2048001, name_zh: '宠物装备移动速度卷轴：高级', name_en: 'Pet Equip Speed Scroll: Greater', category: '消耗品', low: 10, listings: 999, typical: 1000, last_seen: now };
const quotes = [
  { ...product, id: 'recent-expensive', observed: now, unit_price: 900, stock: 4, bundle: 1, shop: 'First shop', location: { channel: 23, room: 9 } },
  { ...product, id: 'unknown-stock', observed: now - 60, unit_price: 19.9, stock: null, bundle: 1, shop: 'Other shop', location: null },
  { item_id: 1072128, id: 'real-gear', name_zh: '蓝宝石鞋', name_en: 'Blue Jewelry Boots', observed: now-120, unit_price: 3000, stock: 1, shop: 'Boots shop', location: {channel:24,room:10}, equipment:{status:'candidate',stats:[{key:'luk',value:2},{key:'weapon_defense',value:7},{key:'magic_defense',value:7},{key:'avoid',value:3}],remaining_upgrades:5} },
];
const sales = [{ ...quotes[0], item_id: 1002001, name_zh: '贝雷帽', name_en: 'Beret', equipment: { status: 'unsupported' }, id: 'sale', time: now, sale_unit_price: 850, kind: 'drop', quantity: 2, stock: 3 }];
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: false });
  if (url.pathname === '/api/v1/market') return json(res, { products: [product, {...product,item_id:1002001,name_zh:'贝雷帽',name_en:'Beret'}], as_of: now });
  if (url.pathname === '/api/v1/market/period-default') return json(res, { default_hours: 'all' });
  if (url.pathname === '/api/v1/sales/recent') return json(res, { sales, generated_at: now });
  if (url.pathname === '/api/v1/quotes/recent') return json(res, { listings: quotes, grouped_listings: quotes.map((row,i)=>i===0?{...row,stock:7,merged_count:2}:row), generated_at: now });
  if (url.pathname === '/api/v1/market/records') return json(res, {records:url.searchParams.get('kind')==='sales'?sales:[quotes[0]]});
  if (url.pathname === '/api/v1/watchlist/catalog') return json(res, { items: [product], presets: [{ id: 'fixture', name_zh: '测试关注', name_en: 'Preset', items: [product] }] });
  if (url.pathname === '/api/v1/watchlist/listings') return json(res, { listings: quotes.slice(0,2).map(row => ({ ...row, stock: row.stock ?? 2 })), generated_at: now });
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const width of [320, 375, 1280]) {
    for (const lang of ['zh', 'en']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 640, hasTouch: width < 640 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ lang, width }) => { localStorage.setItem('lang', lang); localStorage.setItem('theme', width === 375 ? 'dark' : 'light'); }, { lang, width });
      await page.goto(`${origin}/?lang=${lang}&hours=all`);
      const descriptions=page.locator('.hero .portal small');
      await descriptions.first().waitFor();
      for(const description of await descriptions.all()) {
        const layout=await description.evaluate(node=>{const s=getComputedStyle(node);return {nowrap:s.whiteSpace,height:node.getBoundingClientRect().height,lineHeight:parseFloat(s.lineHeight),fits:node.scrollWidth<=node.clientWidth};});
        assert.equal(layout.nowrap,'nowrap','shortcut descriptions never wrap');
        assert(layout.height<=layout.lineHeight+1,'shortcut description occupies one line');
        if(lang==='zh') assert(layout.fits,'complete Chinese shortcut descriptions fit even on narrow phones');
      }
      assert.equal(await page.locator('.hero [data-count=mobs]').textContent(),lang==='zh'?'物品·怪物·地图':'Items · Mobs · Maps');
      const sold = page.locator('[data-pane=recent] .market-record');
      await sold.waitFor();
      const dot=page.locator(width<640?'.ptop .fresh i':'.dhead .fresh i');
      await dot.waitFor();
      assert(await dot.evaluate(node=>{
        const dot=node.getBoundingClientRect(),label=node.parentElement.getBoundingClientRect(),style=getComputedStyle(node);
        return dot.width===dot.height&&dot.width>=8&&parseFloat(style.borderRadius)>=50&&style.boxShadow==='none'&&dot.left>=label.left&&dot.right<=label.right&&dot.top>=label.top&&dot.bottom<=label.bottom;
      }),'the complete blue status dot fits inside the clipped freshness label');
      assert.match(await sold.locator('.name-primary .evi').textContent(), /×2/);
      assert.equal(await sold.locator('.ware-price').textContent(), '850');
      assert.match(await sold.locator('.record-stock').textContent(), /3$/);
      assert.equal(await sold.locator('.offer-equipment').count(), 0, 'decorations do not display an unknown-attribute line');
      assert(!/未采集|not captured/.test(await sold.textContent()));
      assert.equal(await sold.locator('.name-primary .evi').count(), 1, 'Sold sits beside the primary name');
      assert(await sold.locator('.name-primary').evaluate(node=>{const title=node.getBoundingClientRect(),badge=node.querySelector('.evi').getBoundingClientRect();return Math.abs((title.top+title.bottom-badge.top-badge.bottom)/2)<1;}),'status aligns vertically with the item title');

      assert.deepEqual(await sold.locator('.record-value').evaluate(node => [...node.children].map(child=>child.className)), ['record-time','ware-price','record-stock']);

      await page.locator('[data-tab=quotes]').click();
      const offers = page.locator('[data-pane=quotes] .market-record');
      await offers.first().waitFor();
      assert.equal(await offers.count(), 3);
      assert.equal(await offers.first().locator('.ware-price').textContent(), '900', 'the newest quote can be more expensive than the per-item minimum');
      assert.equal(await offers.first().locator('.loc b').textContent(), lang === 'zh' ? '23频道' : 'CH 23');
      assert.match(await offers.first().locator('.loc-room').textContent(), /9/);
      assert.equal(await offers.first().locator('[data-relative-time]').getAttribute('data-relative-time'), String(now));
      assert.match(await offers.first().locator('.record-stock').textContent(), /7$/,'home uses the complete API group stock');
      assert.match(await offers.nth(1).locator('.record-stock').textContent(), /—$/);
      assert.equal(await offers.nth(1).locator('.loc b').textContent(), lang === 'zh' ? '频道 —' : 'CH —');
      assert.equal(await offers.nth(1).locator('.loc-room').textContent(), lang === 'zh' ? '洞 —' : 'FM —');
      async function checkLayout(row) {
        const result = await row.evaluate(node => {
          const meta = node.querySelector('.record-meta');
          const fields = [...meta.children].map(child => child.classList.contains('loc')?'loc':child.className);
          const box = meta.getBoundingClientRect();
          const value = node.querySelector('.record-value').getBoundingClientRect();
          const bounds = node.getBoundingClientRect();
          const main = node.querySelector('.w-main').getBoundingClientRect();
          return { fields, centered: value.left >= main.right - 1 && Math.abs((value.top + value.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 1, inside: [...meta.children].every(child => { const b = child.getBoundingClientRect(); return b.left >= box.left - 1 && b.right <= box.right + 1; }), columns: getComputedStyle(node).gridTemplateColumns.split(' ').length, secondaryWrap: getComputedStyle(node.querySelector('.name-secondary')).whiteSpace };
        });
        assert.deepEqual(result.fields, ['loc']);
        assert(result.inside, 'every metadata field stays within the name column');
        assert.equal(result.columns, 3, 'icon, names/metadata and a separate value column');
        assert(result.centered, 'price and stock are vertically centered on the right');
        assert.equal(result.secondaryWrap, 'normal', 'long translations remain readable');
        const viewport=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
        assert(viewport.scroll<=viewport.width,'no horizontal page overflow: '+JSON.stringify(viewport));
      }
      await checkLayout(offers.first());
      const cells=await offers.first().locator('.loc-shop').evaluate(node=>[...node.children].map(child=>child.getBoundingClientRect().width));
      assert.equal(cells.length,3);assert.equal(cells[0],50);assert.equal(cells[1],44);
      assert(await offers.locator('.loc-shop').evaluateAll(nodes=>nodes.every(node=>{const cells=[...node.children].map(child=>child.getBoundingClientRect().width);return cells[0]===50&&cells[1]===44&&Math.abs(cells.reduce((a,b)=>a+b,0)-node.clientWidth)<1;})),'CH and FM retain the same column widths across rows while shop uses the remaining space');
      assert.equal(await offers.first().locator('.loc-room').textContent(),lang === 'zh' ? '9洞' : 'FM9');
      assert.match(await offers.first().locator('.loc-shop').getAttribute('title'), lang === 'zh' ? /^23频道 · 9洞 · / : /^CH 23 · FM9 · /);
      assert(await offers.locator('.loc-shop').evaluateAll(nodes=>nodes.every(node=>[...node.children].slice(0,2).every(cell=>cell.scrollWidth<=cell.clientWidth))),'translated channel and room labels fit their columns');
      const longShop=offers.first().locator('.record-shop');
      const naturalShop=await longShop.evaluate(node=>{node.textContent='hi';node.title='hi';const frame=node.parentElement.getBoundingClientRect();return {width:frame.width,available:node.closest('.record-meta').getBoundingClientRect().width,shopWidth:node.getBoundingClientRect().width};});
      assert(naturalShop.width<naturalShop.available-10&&naturalShop.shopWidth<30,'short shop names keep the frame fitted to their content');
      await longShop.evaluate(node=>{node.textContent='A very long shop title that must not expand the row';node.title=node.textContent;});
      assert(await longShop.evaluate(node=>{const s=getComputedStyle(node);return s.textOverflow==='ellipsis'&&s.whiteSpace==='nowrap'&&node.scrollWidth>node.clientWidth;}),'long shop titles clip with ellipsis inside the third cell');
      assert(await longShop.evaluate((node,shortWidth)=>node.parentElement.getBoundingClientRect().width>shortWidth,naturalShop.width),'the shop cell grows for longer titles');
      await longShop.evaluate(node=>{node.textContent='First shop';node.title='First shop';});
      assert.match(await offers.nth(2).locator('.offer-equipment').textContent(), /可升 5|Upgrades left 5/);
      assert.equal(await offers.nth(2).locator('.offer-equipment').evaluate(node=>getComputedStyle(node).fontSize), '11px');
      const attributes=await offers.nth(2).locator('.offer-equipment').evaluate(node=>{
        const style=getComputedStyle(node);
        return {text:node.textContent,title:node.title,whiteSpace:style.whiteSpace,overflow:style.overflow,textOverflow:style.textOverflow,height:node.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight),clipped:node.scrollWidth>node.clientWidth};
      });
      assert.equal(attributes.title,attributes.text,'full attributes remain available in the tooltip and item details');
      assert.equal(attributes.whiteSpace,'nowrap');
      assert.equal(attributes.overflow,'hidden');
      assert.equal(attributes.textOverflow,'ellipsis');
      assert(attributes.height<=attributes.lineHeight+1,'attributes stay on one line at every viewport');
      if(width===320) assert(attributes.clipped,'long attributes are truncated on narrow phones');
      const sizes=await offers.first().evaluate(node=>Object.fromEntries(['.ware-price','.name-secondary','.record-time','.record-stock','.loc','.record-shop'].map(selector=>[selector,getComputedStyle(node.querySelector(selector)).fontSize])));
      assert.equal(sizes['.ware-price'],'18px');
      assert.equal(sizes['.name-secondary'],'11px','translations are smaller than other secondary text');
      for(const [selector,size] of Object.entries(sizes)) if(!['.ware-price','.name-secondary'].includes(selector)) assert.equal(size,'12px',selector);
      const metaText=await offers.first().evaluate(node=>['.loc b','.loc-room','.record-shop'].map(selector=>{
        const range=document.createRange();range.selectNodeContents(node.querySelector(selector));
        const bounds=range.getBoundingClientRect();return (bounds.top+bounds.bottom)/2;
      }));
      assert(Math.max(...metaText)-Math.min(...metaText)<=1,'channel, room and shop text share the same vertical alignment');


      if (screenshots) await page.screenshot({ path: path.join(screenshots, `quotes-${width}-${lang}.png`) });
      await page.locator('[data-nav-key=watch]:visible').click();
      await page.locator('[data-search]').fill(String(product.item_id));
      await page.locator(`[data-add="${product.item_id}"]`).click();
      const matches = page.locator('[data-matches] .market-record');
      await matches.first().waitFor();
      await page.locator('[data-watch-sort]').selectOption('recent');
      assert.equal(await matches.first().getAttribute('data-id'), 'recent-expensive');
      await checkLayout(matches.first());
      assert.equal(await matches.first().locator('.ware-price').textContent(), '900');
      await page.locator('[data-watch-sort]').selectOption('price');
      await page.waitForFunction(() => document.querySelector('[data-matches] [data-item-row]')?.dataset.id === 'unknown-stock');
      assert.equal(await matches.first().getAttribute('data-id'), 'unknown-stock');
      await page.locator('[data-watch-filter]').click();const watchFilters=page.locator('#offer-filter-dialog[open]');
      await watchFilters.locator('[name=minPrice]').fill('100');await watchFilters.locator('[data-offer-apply]').click();
      assert.equal(await matches.count(),1);assert.equal(await matches.first().getAttribute('data-id'),'recent-expensive');
      await page.reload();await matches.first().waitFor();assert.equal(await matches.count(),1,'watch view filters survive reload');
      await page.locator('[data-watch-clear=all]').click();assert.equal(await matches.count(),2);
      await page.locator('[data-watch-filter]').click();await watchFilters.locator('[name=percentile]').selectOption('50');await watchFilters.locator('[data-offer-apply]').click();
      assert.equal(await matches.count(),1);assert.equal(await matches.first().getAttribute('data-id'),'unknown-stock','percentile keeps the cheaper matching quote');
      await page.locator('[data-watch-clear=all]').click();
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `watch-${width}-${lang}.png`) });

      for (const mode of ['recent', 'lastsale']) {
        await page.goto(`${origin}/prices?sort=${mode}&hours=all&lang=${lang}`);
        const row = page.locator('[data-price-records] .market-record');
        await row.waitFor();
        await checkLayout(row);
        assert.equal(await row.locator('.record-value > .record-time').count(), 1);
        assert.equal(await row.locator('.record-shop').textContent(), 'First shop');
        assert.equal(await row.locator('.offer-equipment').count(), 0);
        if(mode==='lastsale') assert.match(await row.locator('.name-primary .evi').textContent(), /已售|卖出|卖光|Sold/);
        if(width>=640) {
          const star=page.locator('.price-record-actions [data-star]').first();
          const before=await star.getAttribute('aria-pressed');
          await star.click();
          await page.waitForFunction(before=>document.querySelector('.price-record-actions [data-star]')?.getAttribute('aria-pressed')!==before,before);
          assert.equal(new URL(page.url()).pathname,'/prices','watching a record does not navigate');
        }

        if(screenshots) await page.screenshot({path:path.join(screenshots,`prices-${mode}-${width}-${lang}.png`)});
      }
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${width}px ${lang}: one row layout for sales, actual latest quotes and watched offers; location/time/price/stock agree`);
    }
  }
} finally {
  await browser.close(); for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve));
}
