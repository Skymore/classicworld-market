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

const emit=()=>{revision++;for(const stream of streams)stream.write('event: market\ndata: {}\n\n');};
async function tags(page,expected){await page.waitForFunction(tags=>JSON.stringify(window.desktopNotifications)===JSON.stringify(tags),expected,{polling:100});}
async function navigate(page,url){
 await page.evaluate(url=>{const a=document.createElement('a');a.href=url;document.body.append(a);a.click();a.remove();},url);
 await page.waitForURL(origin+url);
}
let browser;
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
 for(const mobile of [false,true]){
  shared=[];personal=[];
  const context=await browser.newContext({viewport:{width:mobile?375:1280,height:900},isMobile:mobile,hasTouch:mobile}); const page=await context.newPage();
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const requests=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));
  await page.addInitScript(()=>{
   localStorage.setItem('lang','zh');localStorage.setItem('watchlist','[2000000]');
   localStorage.setItem('watchlist_settings',JSON.stringify({2000000:{cap:100,notify:true}}));
   localStorage.setItem('watch.listCollapsed','true');
   window.desktopNotifications=[];window.permissionRequests=0;
   window.Notification=class{
    static permission='default';
    static async requestPermission(){window.permissionRequests++;this.permission='granted';return 'granted';}
    constructor(title,options){window.desktopNotifications.push(options.tag);}
   };
  });
  // Start on a different page: the watch route has never mounted.
  await page.goto(origin+'/?lang=zh');
  await page.waitForFunction(()=>document.documentElement.dataset.liveConnection==='connected');
  await page.waitForFunction(()=>document.querySelector('#site-react-shell'));
  for(let attempt=0;attempt<100&&!requests.includes('/api/v1/collector/watch-listings');attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  assert(requests.includes('/api/v1/collector/watch-listings'));
  await navigate(page,'/watch');
  await page.locator('[data-notification-state="default"]').waitFor();
  assert.equal(await page.locator('#watch-list').isVisible(),false);
  assert(await page.locator('[data-allow]').isVisible(),'permission control remains visible when the watchlist is collapsed');
  assert.equal(await page.evaluate(()=>window.permissionRequests),0,'permission is never requested automatically');
  await page.locator('[data-allow]').click();
  await page.locator('[data-notification-test]').click();await tags(page,['watch-notification-test']);
  assert.equal(await page.evaluate(()=>window.permissionRequests),1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'notification controls fit mobile width');
  if(process.env.WATCH_SCREENSHOT_DIR){await mkdir(process.env.WATCH_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.WATCH_SCREENSHOT_DIR,`notifications-${mobile?'phone':'desktop'}.png`)});}
  const reads=requests.filter(p=>p==='/api/v1/watchlist/listings').length;
  await navigate(page,'/prices');await page.locator('[data-notification-state]').waitFor({state:'detached'});
  shared=[offer('on-prices',60),offer('over-cap',150),offer('old',50,{observed:now()-600})];
  emit();await tags(page,['watch-notification-test','on-prices']);
  assert.equal(requests.filter(p=>p==='/api/v1/watchlist/listings').length,reads+1,'one shared feed survives route changes');
  await navigate(page,'/account');
  personal=[shared[0],offer('personal-on-account',40)];emit();
  const expected=['watch-notification-test','on-prices','personal-on-account'];await tags(page,expected);
  await navigate(page,'/watch');await page.locator('[data-notification-state="granted"]').waitFor();
  await refresh(page);await tags(page,expected);assert.deepEqual(await page.evaluate(()=>window.desktopNotifications),expected,'returning to Watch does not replay offers');
  // Permission changed in browser site settings is reflected without a reload.
  await page.evaluate(()=>{Notification.permission='denied';window.dispatchEvent(new Event('focus'));});
  await page.locator('[data-notification-state="denied"]').waitFor();
  assert.match(await page.locator('.watch-notification-bar').innerText(),/地址栏/);
  assert.equal(await page.locator('[data-allow]').count(),0,'denied permission offers instructions instead of a useless prompt');
  await page.evaluate(()=>{Notification.permission='granted';window.dispatchEvent(new Event('focus'));});
  await page.locator('[data-notification-test]').waitFor();
  await navigate(page,'/');
  // Market updates continue even when this tab is in the background.
  const front=await page.context().newPage();await front.goto('about:blank');await front.bringToFront();
  shared.unshift(offer('background',30));emit();expected.push('background');await tags(page,expected);
  await front.close();await page.bringToFront();
  // Removing a watch on another page takes effect without opening Watch.
  await page.evaluate(()=>{localStorage.setItem('watchlist','[]');window.dispatchEvent(new StorageEvent('storage',{key:'watchlist'}));});
  await frames(page);
  shared.unshift(offer('removed',20));emit();await frames(page);
  assert.deepEqual(await page.evaluate(()=>window.desktopNotifications),expected);
  assert.deepEqual(errors,[]);
  await context.close();
 }
 // Unsupported browsers keep a visible status instead of hiding everything.
 const page=await browser.newPage();await page.addInitScript(()=>{delete window.Notification;});
 await page.goto(origin+'/watch?lang=zh');await page.locator('[data-notification-state="unsupported"]').waitFor();
 assert.match(await page.locator('.watch-notification-bar').innerText(),/不可用/);await page.close();
 console.log('PASS site-wide watch notifications: route changes, shared/personal deduplication, background delivery, permission states, collapsed list, test notification and watch removal');
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
