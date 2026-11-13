// Isolated SSR-shaped fixture; tests the actual item page module and live swaps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import {groupEquipmentVariants} from '../../frontend/src/lib/item-market.ts';
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
let offers = original, revision = 0, saleRows = [];
const captured = new Map();
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
const variant=(r,i)=>r.captured?{id:r.variantId??(original.findIndex(v=>v.id===r.id)+100+i),stats:r.stats||[{key:'weapon_attack',label:'物理攻击',value:17}],enhancements:r.enhancements??1,remaining_upgrades:7,unknown_fields:0}:null;
function snapshot(url) {
 const target=new URL(url.searchParams.get('url')||'/item/1002000','http://fixture');
 let listings=offers.map((r,i)=>({shop:r.id,channel:r.ch==='unknown'?null:Number(r.ch),room:r.room,unit_price:r.price,seen_at:new Date((now-r.age)*1000).toISOString(),stock:r.stock===undefined?1:r.stock,variant:variant(r,i)}));
 let sales=saleRows.map((r,i)=>({shop:r.id,channel:1,room:1,unit_price:r.price,detected_at:new Date((now-r.age)*1000).toISOString(),quantity:r.captured?1:null,kind:'found_sold',variant:variant(r,i)}));
 for(const row of [...listings,...sales])if(row.variant)captured.set(row.variant.id,row.variant);
 const selected=captured.get(Number(target.searchParams.get('variant')));
 if(target.searchParams.has('variant')) {
  const matches=row=>row.variant&&selected&&groupEquipmentVariants([{variant:selected},row]).length===1;
  listings=listings.filter(matches);sales=sales.filter(matches);
 }
 return {kind:'item',page:{item:{id:Number(target.pathname.split('/')[2]),name_zh:'测试装备',name_en:'Test equipment',category:'装备',req_level:10},selected_variant:selected,stats:null,droppers:[],npc_offers:[],npc_sell:null,market:{as_of:new Date((now+revision)*1000).toISOString(),base_stats:[['weapon_attack',1],['str',1],['weapon_defense',10],['magic_defense',5]],days:[],sale_points:[],sales,listings}}};
}
const catalogRequests=[];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/api/v1/account')return res.end(JSON.stringify({signed_in:false}));
    if(url.pathname==='/api/v1/catalog/page'){catalogRequests.push(url.searchParams.get('url'));return res.end(JSON.stringify(snapshot(url)));}
    return res.end('{}');
  }
  if (url.pathname.startsWith('/web/')) {
    const file = path.resolve(root, '.' + url.pathname.slice(4));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(await readFile(file)); }
    catch { res.writeHead(404); return res.end(); }
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(await readFile(path.join(root,'index.html')));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const broadcast = () => { for (const stream of streams) stream.write('event: market\ndata: {}\n\n'); };
let browser;
try {
  browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    offers = original; saleRows=[]; captured.clear(); revision++;
    const page = await browser.newPage({ viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.selectFocusCalls = 0;
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function(...args) { if (this.tagName === 'SELECT') window.selectFocusCalls++; return focus.apply(this, args); };
    });
    const url = origin + `/item/1002000?hours=all&lang=${mobile ? 'zh' : 'en'}&device=${mobile ? 'phone' : 'desktop'}`;
    const visibleRows = () => page.locator('.where-well [data-quote]:visible').evaluateAll(els => els.map(el => el.querySelector('.record-shop,.lshop').textContent.trim().replace('›','')));
    const waitRevision = () => page.waitForFunction(rev => Number(document.querySelector('.item-stall')?.dataset.asOf) === rev, now+revision);
    const open = async () => { await page.locator('[data-offer-filter-open]').click(); await page.locator('dialog[open]').waitFor(); };
    const submit = async () => { await page.locator('[data-offer-apply]').click(); await page.locator('dialog[open]').waitFor({state:'hidden'}); };
    await page.goto(url); await waitRevision();
    await page.evaluate(()=>localStorage.setItem('market.offerFilters','{"hours":"1","equipment":"bonus"}'));
    assert.equal(await page.locator('[data-offer-view=groups]').getAttribute('aria-checked'),'true','equipment offers are grouped by stat set by default');
    await page.evaluate(()=>localStorage.setItem('item.offerView','list'));
    await page.reload();await waitRevision();
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
    assert.equal(await page.locator('.where-well .well-h > small').textContent(), mobile ? '7 条挂单 · 7 摊' : '7 listings · 7 shops', 'draft conditions do not change results before applying');
    await page.screenshot({path:path.join(output, `advanced-panel-${mobile?'mobile':'desktop'}.png`),fullPage:false});
    await submit();
    assert.equal(await page.locator('.where-well .well-h > small').textContent(), mobile ? '4 条挂单 · 4 摊' : '4 listings · 4 shops');
    assert.deepEqual(await visibleRows(), ['unknown', 'newer', 'fresh', 'expensive'], 'cheapest first across channels, newer first on ties');
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
    assert.equal(await page.locator('dialog [name=minStock]').count(),0,'equipment has no stock minimum');
    await page.selectOption('dialog [name=equipment]', 'captured');
    await submit(); assert.deepEqual(await visibleRows(), ['fresh']);
    await page.selectOption('[data-offer-sort]', 'price');
    assert.deepEqual(await visibleRows(), ['fresh'], 'all conditions survive sort changes');
    await page.reload(); await waitRevision();
    assert.deepEqual(await visibleRows(), ['fresh'], 'all conditions survive reload');
    await page.locator('.show-expired-toggle input').uncheck();
    const switchItem=async id=>{
      await page.evaluate(id=>{history.pushState({},'',`/item/${id}?hours=all`);dispatchEvent(new PopStateEvent('popstate'));},id);
      await page.locator(`.item-stall[data-item="${id}"]`).waitFor();
    };
    await switchItem(1002001);
    const requested=new URL(catalogRequests.at(-1),'http://fixture');
    assert.equal(requested.searchParams.has('attributes'),false,'server fetch must not inherit another product attributes');
    assert.equal(requested.searchParams.has('equipment'),false);
    assert.equal(await page.locator('.offer-filter-summary').isVisible(),false,'another product starts with independent filters');
    assert.equal(await page.locator('.show-expired-toggle input').isChecked(),true,'expired toggle is per product');
    await open();await page.locator('dialog [name=maxPrice]').fill('20000');await submit();
    await switchItem(1002000);
    assert.deepEqual(await visibleRows(),['fresh'],'SPA navigation restores the original product filters');
    assert.equal(await page.locator('.show-expired-toggle input').isChecked(),false);
    await page.goBack();await page.locator('.item-stall[data-item="1002001"]').waitFor();
    await open();assert.equal(await page.locator('dialog [name=maxPrice]').inputValue(),'20000');await page.keyboard.press('Escape');
    await page.locator('[data-offer-clear=all]').click();
    await switchItem(1002000);
    assert.deepEqual(await visibleRows(),['fresh'],'clearing one product preserves the other');
    offers = [...original, { id:'incoming',ch:'35',room:3,price:24000,age:0,stock:10,equipment:true,captured:true }]; revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('.where-well .well-h > small').textContent(), mobile ? '2 条挂单 · 2 摊' : '2 listings · 2 shops');
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
    assert.equal(await page.locator('.where-well .well-h > small').textContent(), mobile ? '3 条挂单 · 3 摊' : '3 listings · 3 shops');
    offers = original.map(row => ({...row,age:row.age+7200})); revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('[data-offer-empty]').isVisible(), true);
    await page.locator('[data-offer-clear=all]').click();
    assert.equal(await page.locator('[data-offer-empty]').isVisible(), false);
    offers = Array.from({length:10},(_,i)=>({id:`channel-${i}`,ch:String(i+1),room:1,price:i+1,age:i<3?60:7200})); revision++; broadcast(); await waitRevision();
    assert.equal(await page.locator('.where-well [data-quote]:visible').count(), 10);
    await open(); await page.selectOption('[data-offer-hours]','1'); await submit();
    assert.equal(await page.locator('.where-well [data-quote]:visible').count(), 3);
    assert.equal(await page.locator('[data-more]:visible').count(), 0);

    // Useful-stat grouping ignores defence rolls and successful enhancement counts.
    await page.locator('[data-offer-clear=all]').click();
    const stats=(key,value,def,magic=5)=>[{key,label:key,value},{key:'weapon_defense',label:'物理防御',value:def},{key:'magic_defense',label:'魔法防御',value:magic}];
    offers=[
      {id:'plain-a',stats:stats('str',1,10)},
      {id:'plain-b',stats:stats('str',1,15,9)},
      {id:'dex2-a',stats:stats('dex',2,12)},
      {id:'dex2-b',stats:stats('dex',2,18,8),enhancements:2},
      {id:'dex4',stats:stats('dex',4,8)},
      {id:'def-enhanced',stats:stats('str',1,30),enhancements:1},
    ].map((r,i)=>({...r,variantId:100+i,ch:'1',room:1,price:10000+i*1000,age:60,stock:1,equipment:true,captured:true,enhancements:r.enhancements??0}));
    revision++;broadcast();await waitRevision();
    const groups=()=>page.locator('[data-equipment-group]:visible');
    // Grouped view: one header per stat set, its offers listed under it; the choice is remembered.
    assert.equal(await page.locator('[data-equipment-group]').count(),0,'the list view has no stat-set headers');
    await page.locator('[data-offer-view=groups]').click();
    assert.equal(await page.locator('[data-offer-view=groups]').getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('[data-equipment-group]').count(),3);
    assert.equal(await page.locator('[data-more=groups]').count(),0,'enhancement counts no longer add another group');
    const plain=page.locator('[data-equipment-group]').filter({hasText:'10–30'});
    assert.equal(await plain.count(),1);assert.equal(await plain.locator('.attr-count').textContent(),mobile?'3 件':'3');
    assert.match(await plain.textContent(),/1万|10K/,'group minimum includes all defence and enhancement counts');
    assert.doesNotMatch((await page.locator('.offer-group-head').allTextContents()).join(' '),/\+\d/,'headers have no plus sign and no enhancement counts');
    assert.deepEqual(await visibleRows(),['plain-a','plain-b','def-enhanced','dex2-a','dex2-b','dex4'],'each set lists its own offers, cheapest first');
    const plainOffers=page.locator('.offer-group').filter({has:plain}).locator('[data-quote]');
    assert.deepEqual(await plainOffers.locator('.offer-equipment').allTextContents(),mobile?['物防 10 · 魔防 5','物防 15 · 魔防 9','物防 30 · 魔防 5 · 强化 +1']:['DEF 10 · M.DEF 5','DEF 15 · M.DEF 9','DEF 30 · M.DEF 5 · Enhancements +1'],'rows keep only what varies inside the set');
    await page.screenshot({path:path.join(output,`offer-groups-${mobile?'mobile':'desktop'}.png`)});

    assert.equal(await page.locator('[data-equipment-stat]').count(),0,'one filter dialog serves the entire page');
    const bonusSwitch=page.locator('[data-bonus-only]');
    assert.equal(await bonusSwitch.getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('[data-offer-filter-open]').count(),1);
    const addStat=async(key,min)=>{await page.locator('[data-stat-add]').click();const row=page.locator('[data-stat-row]').last();await row.locator('[data-stat-key]').selectOption(key);await row.locator('[data-stat-min]').fill(String(min));};
    await bonusSwitch.click();
    assert.equal(await bonusSwitch.getAttribute('aria-pressed'),'true');
    assert.equal(await groups().count(),2,'defence-only rolls and defensive enhancements are excluded');
    await open();assert.equal(await page.locator('dialog [name=equipment]').inputValue(),'bonus');await page.keyboard.press('Escape');
    await page.locator('[data-offer-clear=equipment]').click();assert.equal(await bonusSwitch.getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('[data-equipment-group]').count(),3);
    await bonusSwitch.click();
    await open();await addStat('dex',3);await submit();
    assert.equal(await groups().count(),1);assert.deepEqual(await visibleRows(),['dex4']);
    await open();await addStat('str',1);assert.match(await page.locator('[data-offer-apply]').textContent(),/0/);await submit();
    assert.equal(await groups().count(),0,'attribute conditions combine with AND');
    assert.equal(await bonusSwitch.isVisible(),true,'the switch remains reachable with no matches');
    await page.locator('[data-offer-clear="stat:str"]').click();
    assert.equal(await groups().count(),1);
    await page.reload();await waitRevision();assert.equal(await page.locator('[data-bonus-only]').getAttribute('aria-pressed'),'true');await open();
    assert.equal(await page.locator('[data-stat-row]').count(),1);
    assert.equal(await page.locator('[data-stat-min]').inputValue(),'3');
    await page.locator('[data-stat-min]').fill('4');
    offers=[...offers,{...offers[4],id:'live-dex5',variantId:106,stats:stats('dex',5,40),price:16000}];
    revision++;broadcast();await waitRevision();
    assert.equal(await page.locator('[data-stat-min]').inputValue(),'4');assert.match(await page.locator('[data-offer-apply]').textContent(),/2/);
    await addStat('weapon_defense',10);
    await page.screenshot({path:path.join(output,`attribute-panel-${mobile?'mobile':'desktop'}.png`)});
    await page.locator('[data-stat-row]').last().locator('[data-stat-remove]').click();
    await submit();assert.deepEqual(await visibleRows(),['dex4','live-dex5']);
    await page.locator('[data-offer-clear=all]').click();
    saleRows=[{...offers[2],price:14500},{id:'external-sale',ch:'1',room:1,age:180,price:8000,captured:false}];revision++;broadcast();await waitRevision();
    if(mobile)await page.locator('[data-tab=sales]').click();
    const salePanel=page.locator(mobile?'[data-pane=sales]':'.sales-well');
    const known=salePanel.locator('[data-sale-stats]').first();
    assert.equal(await known.locator('.sale-equipment').isVisible(),true,'captured stats are visible without clicking');
    assert.match(await known.locator('.sale-equipment').textContent(),mobile?/敏 \+2/:/DEX \+2/);
    const unknown=salePanel.locator('[data-sale-stats]').last();
    assert.match(await unknown.locator('.sale-equipment').textContent(),mobile?/属性未知/:/Unknown stats/);
    assert.equal(await salePanel.locator('details,summary,.tip').count(),0,'sales use compact direct summaries');
    revision++;broadcast();await waitRevision();assert.equal(await known.locator('.sale-equipment').isVisible(),true,'SSE keeps captured stats visible');
    await salePanel.screenshot({path:path.join(output,`sale-stats-${mobile?'mobile':'desktop'}.png`)});
    await page.locator('[data-equipment-group][href*="variant=102"]').click();
    await page.locator('[data-selected-attributes]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('variant'),'102');
    assert.deepEqual(await visibleRows(),['dex2-a','dex2-b'],'the child page combines defence and enhancement counts and keeps buying locations');
    assert.equal(await page.locator('[data-equipment-group]').count(),1);
    await page.screenshot({path:path.join(output,`attribute-child-${mobile?'mobile':'desktop'}.png`),fullPage:true});
    await open();await page.locator('dialog [name=maxPrice]').fill('20000');await submit();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('item.offerFilters.1002000')).maxPrice),20000,'variant detail saves under the same item');
    await page.reload();await page.locator('[data-selected-attributes]').waitFor();
    await open();assert.equal(await page.locator('dialog [name=maxPrice]').inputValue(),'20000');await page.keyboard.press('Escape');
    assert.deepEqual(await visibleRows(),['dex2-a','dex2-b']);
    const shared=await browser.newPage({viewport:{width:375,height:812}});
    await shared.goto(page.url());await shared.locator('[data-selected-attributes]').waitFor();
    assert.equal(await shared.locator('.where-well [data-quote]').count(),2,'a shared link works without saved filters');await shared.close();
    offers=offers.filter(row=>row.id!=='dex2-a');revision++;broadcast();await waitRevision();
    assert.deepEqual(await visibleRows(),['dex2-b'],'a selected group survives its original offer disappearing');
    await page.locator('[data-all-attributes]').click();await page.locator('[data-selected-attributes]').waitFor({state:'detached'});
    assert.equal(new URL(page.url()).searchParams.has('variant'),false);
    // A large stat set previews three offers in the chosen order and pages through the rest inside the set.
    offers=[...Array.from({length:45},(_,i)=>({id:`bulk-${String(i).padStart(2,'0')}`,stats:stats('str',1,10),variantId:200+i,price:10000+i*100,age:60+i})),{id:'other',stats:stats('dex',2,12),variantId:300,price:19000,age:5000}]
      .map((r,i)=>({...r,ch:String(1+i%20),room:1+Math.floor(i/20),stock:1,equipment:true,captured:true,enhancements:0}));
    revision++;broadcast();await waitRevision();
    const bulk=page.locator('.offer-group').filter({has:page.locator('[data-equipment-group]').filter({hasText:/力|STR/})}).first();
    const bulkRows=()=>bulk.locator('[data-quote]').evaluateAll(els=>els.map(el=>el.querySelector('.record-shop,.lshop').textContent.trim().replace('›','')));
    assert.deepEqual(await bulkRows(),['bulk-00','bulk-01','bulk-02'],'three offers per set by default');
    await bulk.locator('[data-group-expand]').click();
    assert.equal((await bulkRows()).length,20,'opening a set shows one page of twenty');
    assert.match(await bulk.locator('.og-pager.top').textContent(),/1–20/);
    await bulk.locator('[data-group-page="3"]').click();
    assert.equal((await bulkRows()).length,5,'the last page holds the remainder');
    await bulk.screenshot({path:path.join(output,`offer-group-page-${mobile?'mobile':'desktop'}.png`)});
    await bulk.locator('[data-group-collapse]').first().click();
    assert.equal((await bulkRows()).length,3,'collapsing returns to the preview');
    assert.equal(await page.locator('.offer-group').count(),2,'other sets keep their own preview');
    await page.screenshot({path:path.join(output,`offer-group-paging-${mobile?'mobile':'desktop'}.png`)});
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${mobile?'mobile Chinese':'desktop English'}: adjacent button, draft/apply/reset, combined filters, sort independence, reload, realtime dialog, room map, pagination and layout`);
  }
} finally {
  await browser?.close(); for (const stream of streams) stream.end();
  await new Promise(resolve => server.close(resolve));
}
