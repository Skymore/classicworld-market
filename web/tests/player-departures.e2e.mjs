import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const now=Date.now()/1000, streams=new Set();
let revision=0;
const offer=(shop,price,age)=>({shop_key:shop,visit_id:shop,slot:1,bundle:1,source:'packet',shop,
 owner_name:shop==='Gone shop'?'ExampleHost':null,channel:26,room:1,unit_price:price,stock:5,
 seen_at:new Date((now-age)*1000).toISOString(),variant:{id:1,stats:[{key:'str',label:'力量',value:6}],remaining_upgrades:0,enhancements:3,unknown_fields:0}});
const snapshot=()=>({kind:'item',page:{item:{id:1002000,name_zh:'测试装备',name_en:'Test equipment',category:'装备',req_level:10},stats:null,
 droppers:[],npc_offers:[],npc_sell:null,market:{as_of:new Date((now+revision)*1000).toISOString(),base_stats:[],days:[{date:'2026-10-24',median:200,low:100,high:300,count:2},{date:'2026-10-25',median:null,low:null,high:null,count:0}],listing_days:[{date:'2026-10-24',median:800,low:600,high:1000,count:3},{date:'2026-10-25',median:900,low:900,high:900,count:1}],sale_points:[],sales:[],
 listings:[offer('Live shop',900,10)],expired_listings:[{...offer('Gone shop',100,30),invalidated_at:new Date((now-5)*1000).toISOString()}]}}});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(':ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname==='/api/v1/catalog/page'?snapshot():url.pathname==='/api/v1/account'?{signed_in:false}:{}));}
 const file=url.pathname.startsWith('/web/')?path.resolve(root,'.'+url.pathname.slice(4)):path.join(root,'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try{
 for(const width of [375,1280]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<640,hasTouch:width<640});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/item/1002000?hours=all&lang=zh');
  const expired=page.locator('.where-well .expired-record');await expired.waitFor({state:'visible'});
  assert.equal(await expired.locator('.quote-expired').textContent(),'已失效');
  assert.match(await expired.locator('.record-stock').textContent(),/当时库存 5/);
  assert.equal(await page.locator('.where-well [data-quote]').first().getAttribute('data-unit-price'),'100','expired quote keeps its price order');
  const toggle=expired.locator('.shop-name-toggle');const url=page.url();
  await toggle.click();assert.equal(await toggle.textContent(),'ExampleHost');assert.equal(page.url(),url);
  assert(await page.locator('.item-peek').isHidden(),'toggle must not open the equipment tooltip');
  await toggle.focus();await page.keyboard.press('Enter');assert.equal(await toggle.textContent(),'Gone shop');
  await toggle.click();revision++;for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(v=>Number(document.querySelector('.item-stall')?.dataset.asOf)===v,now+revision);
  assert.equal(await toggle.textContent(),'ExampleHost','SSE preserves owner toggle');
  await page.locator('[data-offer-sort]').selectOption('recent');
  assert.equal(await page.locator('.where-well [data-quote]').first().getAttribute('data-unit-price'),'900');
  assert.equal(await page.locator('.shop-name-toggle').count(),1,'unknown owners do not get a misleading button');
  const showExpired=page.getByRole('checkbox',{name:'显示已失效',exact:true});
  assert.equal(await showExpired.isChecked(),true,'expired quotes are shown by default');
  await showExpired.uncheck();
  assert.equal(await expired.count(),0,'hide expired quotes');
  assert.equal(await page.locator('.where-well [data-quote]').count(),1);
  revision++;for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(v=>Number(document.querySelector('.item-stall')?.dataset.asOf)===v,now+revision);
  assert.equal(await expired.count(),0,'SSE preserves hidden expired quotes');
  await page.reload();
  await showExpired.waitFor();
  assert.equal(await showExpired.isChecked(),false,'remember choice after reload');
  assert.equal(await expired.count(),0);
  await showExpired.check();
  await expired.waitFor({state:'visible'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('tab',{name:'走势',exact:true}).click();
  const modes=page.getByRole('group',{name:'走势类型'});
  await modes.getByRole('button',{name:'挂单',exact:true}).click();
  await page.locator('[data-trend-day="1"]').click();
  assert.equal(await page.locator('[data-trend-value="median"]').textContent(),'900');
  await modes.getByRole('button',{name:'对比',exact:true}).click();
  assert.equal(await page.locator('[data-listing-series] circle').count(),2);
  assert.match(await page.locator('[data-listing-readout]').textContent(),/900/);
  assert.equal(await page.locator('[data-trend-value="median"]').textContent(),'—','missing sales must not become listing prices');
  revision++;for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(v=>Number(document.querySelector('.item-stall')?.dataset.asOf)===v,now+revision);
  assert.equal(await modes.getByRole('button',{name:'对比',exact:true}).getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
  if(process.env.REACT_SCREENSHOT_DIR){await mkdir(process.env.REACT_SCREENSHOT_DIR,{recursive:true});await page.locator('.where-well').screenshot({path:path.join(process.env.REACT_SCREENSHOT_DIR,`expired-${width}.png`)});}
  await page.close();
 }
 console.log('Expired offers, minima, price/recent order, owner toggle, keyboard/touch and SSE passed.');
}finally{await browser.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
