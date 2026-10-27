import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const groupSource=await readFile(path.join(root, 'js/lib/quote-groups.js'), 'utf8');
const { mergeShopOffers } = await import('data:text/javascript,' + encodeURIComponent(groupSource));
// Old tabs/caches already have this URL without the newly exported identity.
const legacyGroups=groupSource.replace('export function shopOfferIdentity(', 'function identity(').replace('const key = shopOfferIdentity(row);','const key = identity(row);');
const legacyReminders=(await readFile(path.join(root,'js/lib/watch-reminders.js'),'utf8')).replace(/\.\/quote-groups\.js\?v=[^'"]+/, './quote-groups.js?v=20261025-presence-1');
const streams = new Set(), now = () => Date.now() / 1000;
const products = [2000000,2000001,1452003].map(item_id=>({item_id,name_zh:item_id===1452003?'战斗弓':'测试药水',name_en:item_id===1452003?'Battle Bow':'Test Potion',category:item_id===1452003?'装备':'消耗品',typical:100}));
let shared=[],personal=[],revision=0,rawLimit=5;
const offer=(id,unit_price,patch={})=>({id,item_id:2000000,unit_price,stock:5,bundle:1,observed:now(),shop:id,location:{channel:3,room:2},...patch});
const json=(res,data)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(url.pathname==='/api/v1/account')return json(res,{signed_in:false});
 if(url.pathname==='/api/v1/market')return json(res,{products,as_of:now()});
 if(url.pathname==='/api/v1/market/period-default')return json(res,{default_hours:'all'});
 if(url.pathname==='/api/v1/watchlist/catalog')return json(res,{items:products,presets:[]});
 if(url.pathname==='/api/v1/watchlist/listings'){
  const grouped=mergeShopOffers(shared),percentile_caps={};
  for(const {item_id} of products){const prices=grouped.filter(r=>r.item_id===item_id&&!r.invalidated_at&&(r.stock===null||r.stock>0)).map(r=>r.unit_price).sort((a,b)=>a-b);if(prices.length)percentile_caps[item_id]=Object.fromEntries([10,25,50].map(p=>[p,prices[Math.ceil(prices.length*p/100)-1]]));}
  return json(res,{listings:shared.slice(0,rawLimit),grouped_listings:grouped.map(({merged_ids,...row})=>row),percentile_caps,base_stats:{1452003:[['weapon_attack',42],['str',0],['weapon_defense',20]]},generated_at:now(),revision,truncated:true});
 }
 if(url.pathname==='/api/v1/collector/status')return json(res,{collector_id:'fixture',local_collector:true});
 if(url.pathname==='/api/v1/collector/watch-listings')return json(res,{collector_id:'fixture',personal:true,listings:personal,generated_at:now(),revision});
 if(url.pathname.startsWith('/api/'))return json(res,{});
 if(url.pathname==='/web/js/lib/quote-groups.js'&&url.searchParams.get('v')==='20261025-presence-1'){
  res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'public, max-age=3600'});return res.end(legacyGroups);
 }
 if(url.pathname==='/web/js/lib/watch-reminders.js'&&url.searchParams.get('v')==='20261026-reminders-1'){
  res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'public, max-age=3600'});return res.end(legacyReminders);
 }
 const file=url.pathname.startsWith('/web/')?path.resolve(root,'.'+url.pathname.slice(4)):path.join(root,'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function refresh(page){revision++;const responses=Promise.all(['/api/v1/watchlist/listings','/api/v1/collector/watch-listings'].map(endpoint=>page.waitForResponse(r=>new URL(r.url()).pathname===endpoint).then(r=>r.finished())));for(const stream of streams)stream.write('event: market\ndata: {}\n\n');await responses;await frames(page);}
async function dismiss(page){while(await page.locator('[data-toast-close]').count())await page.locator('[data-toast-close]').first().click();}
async function editor(page,id){const card=page.locator(`[data-card="${id}"]`);if(!await card.locator('.watch-group-editor').count())await card.getByRole('button',{name:'编辑',exact:true}).first().click();}
async function preset(page,id,value){await dismiss(page);await editor(page,id);await page.locator(`[data-watch-reminder="${id}"]`).click();await page.locator(`[data-card="${id}"] [data-reminder-preset="${value}"]`).click();await frames(page);}
async function advanced(page,id,values){await dismiss(page);await editor(page,id);const card=page.locator(`[data-card="${id}"]`);await card.locator('[data-reminder-advanced]').click();const dialog=page.locator('#offer-filter-dialog:visible');assert.equal(await dialog.locator('[name=hours],[name=percentile],[name=maxPrice]').count(),0);for(const [key,value] of Object.entries(values)){const field=dialog.locator(`[name="${key}"]`);if(['stock','equipment'].includes(key))await field.selectOption(value);else await field.fill(String(value));}return dialog;}
async function notificationsEqual(page,tags){await frames(page);const state=await page.evaluate(()=>({tags:window.desktopNotifications,toasts:window.toastCount}));assert.deepEqual(state.tags,tags);assert.equal(state.toasts,tags.length);}
let browser;
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
 for(const mobile of [true,false]){
  shared=products.flatMap(product=>Array.from({length:10},(_,i)=>offer(`old-${product.item_id}-${i}`,(i+1)*(product.item_id===2000001?10:100),{item_id:product.item_id,observed:now()-600})));
  personal=[];rawLimit=5;
  const page=await browser.newPage({viewport:{width:mobile?375:1280,height:900},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   if(!localStorage.getItem('watchlist')){localStorage.setItem('watchlist','[2000000,2000001,1452003]');localStorage.setItem('watchlist_settings',JSON.stringify({2000000:{cap:1200,notify:true},2000001:{cap:1200,notify:true},1452003:{cap:1200,notify:true}}));localStorage.setItem('watch.offerFilters',JSON.stringify({maxPrice:50}));}
   window.desktopNotifications=[];window.toastCount=0;document.addEventListener('market-toast',()=>window.toastCount++);window.Notification=class{static permission='granted';static async requestPermission(){return'granted';}constructor(title,options){window.desktopNotifications.push(options.tag);}};
  });
  await page.goto(origin+'/watch?lang=zh');await page.locator('.watch-page,.react-error').first().waitFor();assert.equal(await page.locator('.react-error').count(),0,'watch modules must load even when old quote-group and reminder URLs still return cached scripts');await page.locator('[data-card="2000000"] [data-under]').waitFor();await page.waitForFunction(()=>document.documentElement.dataset.liveConnection==='connected');await frames(page);
  const card=page.locator('[data-card="2000000"]'),other=page.locator('[data-card="2000001"]');
  assert.equal(await page.locator('[data-preset]').count(),0,'the bow/crossbow shortcut is removed');
  assert.equal(await page.locator('[data-watch-collapse]').innerText(),'','collapse uses only an icon');
  assert.equal(await page.locator('[data-watch-collapse]').getAttribute('aria-label'),'收起关注列表');
  const compact=async()=>{assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');const checks=await card.locator('.wg-rule label').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().top));assert.equal(new Set(checks).size,1,'group alert/sweep controls align');};
  await compact();
  if(mobile){await page.setViewportSize({width:320,height:900});await compact();await page.locator('[data-lang-toggle]:visible').click();await compact();await page.locator('[data-lang-toggle]:visible').click();await page.setViewportSize({width:375,height:900});}
  if(process.env.WATCH_SCREENSHOT_DIR){await mkdir(process.env.WATCH_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.WATCH_SCREENSHOT_DIR,`compact-${mobile?'phone':'desktop'}.png`)});}
  await card.locator('.wg-rule input[type=checkbox]').first().uncheck();assert.equal(await card.locator('.wg-rule input[type=checkbox]').first().isChecked(),false);await card.locator('.wg-rule input[type=checkbox]').first().check();
  await page.locator('[data-watch-collapse]').click();assert.equal(await page.locator('#watch-list').isVisible(),false);assert(await page.locator('[data-matches-panel]').isVisible());await refresh(page);assert.equal(await page.locator('[data-watch-collapse]').getAttribute('aria-expanded'),'false','SSE preserves collapse');
  await page.reload();await page.locator('[data-watch-collapse]').waitFor();assert.equal(await page.locator('#watch-list').isVisible(),false,'reload remembers collapse');await page.locator('[data-watch-collapse]').click();await card.waitFor();await page.waitForFunction(()=>document.documentElement.dataset.liveConnection==='connected');await frames(page);
  await editor(page,2000000);assert.match(await card.locator('[data-watch-reminder]').textContent(),/手动输入.*1,200/s);
  for(const [percentile,cap] of [['10','100'],['25','300'],['50','500']]){await preset(page,2000000,percentile);assert.equal(await card.locator('.watch-reminder-percent').innerText(),`${percentile}%`);assert(await card.locator('.watch-reminder-percent').isVisible());assert.match(await card.locator('.watch-reminder-price').innerText(),new RegExp(cap));await compact();}
  await editor(page,2000001);assert.match(await other.locator('[data-watch-reminder]').textContent(),/手动输入.*1,200/s);
  await preset(page,2000000,'10');assert.equal(await card.locator('[data-under]').textContent(),'1');
  assert.equal(await card.locator('.wc-details').textContent(),'↗');await card.locator('.wc-details').click();assert.equal(new URL(page.url()).searchParams.get('item'),'2000000');assert.equal(await page.locator('[data-matches] [data-item-row]').count(),1,'detail bypasses unrelated global browsing filters');assert.equal(await page.locator('[data-matches] [data-item-row][data-id="old-2000000-0"]').count(),1);
  await page.getByRole('link',{name:'全部关注',exact:true}).click();
  shared.unshift(offer('high',1000),offer('low',100),offer('tie',100));await refresh(page);const expected=['low','tie'];await notificationsEqual(page,expected);
  let dialog=await advanced(page,2000000,{minStock:'5'});assert.equal(await dialog.locator('[name=equipment]').count(),0);await dialog.locator('[data-offer-apply]').click();await notificationsEqual(page,expected);
  const group=offer('group-slot-1',100,{stock:3,shop_key:'group-shop',visit_id:'group-visit',source:'packet',slot:1});shared.unshift(group,{...group,id:'group-slot-2',slot:2});rawLimit=1;await refresh(page);expected.push('group-slot-1');await notificationsEqual(page,expected);assert.match(await page.locator('.toast .record-stock').first().textContent(),/6$/);
  rawLimit=5;await refresh(page);await notificationsEqual(page,expected);
  personal=[shared.find(r=>r.id==='low'),offer('personal-high',1000),offer('personal-low',100)];await refresh(page);expected.push('personal-low');await notificationsEqual(page,expected);await refresh(page);await notificationsEqual(page,expected);
  dialog=await advanced(page,2000000,{stock:'unknown',minStock:''});await dialog.locator('[data-offer-apply]').click();shared.unshift(offer('unknown-stock',100,{stock:null}));await refresh(page);expected.push('unknown-stock');await notificationsEqual(page,expected);
  dialog=await advanced(page,2000000,{stock:'all'});await dialog.locator('[data-offer-apply]').click();await dismiss(page);await card.locator('[data-watch-reminder]').click();await card.locator('[data-reminder-manual]').click();const input=card.locator('[data-cap]');await input.fill('125');shared.unshift(offer('draft-high',999),offer('draft-low',50));await refresh(page);assert.equal(await input.inputValue(),'125','SSE keeps the manual draft');await page.keyboard.press('Enter');assert.match(await card.locator('[data-watch-reminder]').textContent(),/手动输入.*125/s);
  await preset(page,1452003,'50');dialog=await advanced(page,1452003,{equipment:'bonus'});await dialog.locator('[data-stat-add]').click();await dialog.locator('[data-stat-key]').first().selectOption('weapon_attack');await dialog.locator('[data-stat-min]').first().fill('45');await dialog.locator('[data-stat-add]').click();await dialog.locator('[data-stat-key]').nth(1).selectOption('str');await dialog.locator('[data-stat-min]').nth(1).fill('2');await dialog.locator('[data-offer-apply]').click();
  const equipment=(attack,str,def=20)=>({status:'candidate',unknown_fields:[],stats:[{key:'weapon_attack',value:attack},{key:'str',value:str},{key:'weapon_defense',value:def}]});
  shared.unshift(offer('defence-only',100,{item_id:1452003,equipment:equipment(42,0,30)}),offer('wrong-str',100,{item_id:1452003,equipment:equipment(45,0)}),offer('right-stats',100,{item_id:1452003,equipment:equipment(45,2)}));await refresh(page);
  const bow=page.locator('[data-card="1452003"]');assert.equal(await bow.locator('[data-under]').textContent(),'1');await dismiss(page);await bow.locator('.wc-details').click();assert.equal(await page.locator('[data-matches] [data-item-row]').count(),1);assert.equal(await page.locator('[data-matches] [data-id="right-stats"]').count(),1);
  await page.reload();await page.locator('[data-matches] [data-id="right-stats"]').waitFor();await editor(page,2000000);assert.match(await card.locator('[data-watch-reminder]').textContent(),/手动输入.*125/s);assert.equal(await bow.locator('[data-under]').textContent(),'1');await notificationsEqual(page,[]);
  await dismiss(page);await card.getByRole('button',{name:'＋ 另一组条件',exact:true}).click();
  assert.equal(await card.locator('[data-watch-group]').count(),2);
  const added=card.locator('[data-watch-group]').last();await added.getByRole('button',{name:/删除条件组/}).click();
  assert.equal(await card.locator('[data-watch-group]').count(),1);await card.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await card.locator('[data-watch-group]').count(),2);
  await card.locator('[data-watch-group]').last().getByRole('button',{name:/删除条件组/}).click();
  await card.locator('[data-watch-group]').first().getByRole('button',{name:/删除条件组/}).click();
  assert.equal(await card.locator('[data-under]').innerText(),'0');assert.equal(await card.locator('[data-watch-group]').count(),0);
  await page.reload();await card.waitFor();assert.equal(await card.locator('[data-watch-group]').count(),0,'deleted last group remains empty after reload');
  assert.equal(await card.locator('[data-under]').innerText(),'0');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  if(process.env.WATCH_SCREENSHOT_DIR){await mkdir(process.env.WATCH_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.WATCH_SCREENSHOT_DIR,`watch-${mobile?'phone':'desktop'}.png`),fullPage:true});}
  await page.close();console.log(`PASS ${mobile?'phone':'desktop'}: old module caches, presets, manual/SSE draft, per-item advanced AND filters, full grouped-stock popup, personal/shared dedup, icon link and reload`);
 }
}finally{await browser?.close();for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
