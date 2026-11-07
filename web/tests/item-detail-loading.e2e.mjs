// First-paint reuse, bounded collapsed DOM, and live updates on a busy item.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const streams = new Set();
let reads = 0, revision = 0, stale = false, delay = 0, craftReads = 0, unchanged = 0;
const now = Date.now();
const snapshot = () => ({kind:'item', page:{
  item:{id:4010001,name_zh:'青铜母矿',name_en:'Bronze Ore',category:'其他'},
  stats:null,droppers:[],npc_offers:[],npc_sell:null,
  market:{as_of:new Date(now+revision*1000).toISOString(),base_stats:[],days:[],listing_days:[],sale_points:[],sales:[],expired_listings:[],
    listings:Array.from({length:2000},(_,i)=>({shop:`Shop ${i}`,channel:i%40+1,room:i%22+1,unit_price:100+i+revision,
      stock:1,seen_at:new Date(now).toISOString(),variant:null}))},
}});
const json = (res,data) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
const server = createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/api/v1/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');
    streams.add(res);req.on('close',()=>streams.delete(res));return;
  }
  if(url.pathname==='/api/v1/catalog/page'){
    reads++;const value=snapshot();
    const tag=`W/"fixture-${revision}"`;res.setHeader('ETag',tag);
    if(req.headers['if-none-match']===tag){unchanged++;res.writeHead(304);return res.end();}
    if(delay)return setTimeout(()=>json(res,value),delay);
    return json(res,value);
  }
  if(url.pathname==='/api/v1/crafting/prices'){craftReads++;return json(res,{prices:[]});}
  if(url.pathname==='/api/v1/account')return json(res,{signed_in:false});
  if(url.pathname==='/api/v1/market/period-default')return json(res,{default_hours:'72'});
  if(url.pathname.startsWith('/api/'))return json(res,{});
  if(url.pathname.startsWith('/web/')){
    const file=path.resolve(root,'.'+url.pathname.slice(4));
    if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
    try {res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(file));}
    catch {res.writeHead(404);res.end();}return;
  }
  const seed={url:url.pathname+url.search,etag:`W/"fixture-${revision}"`,updatedAt:Date.now()-(stale?60000:0),data:snapshot()};
  const html=(await readFile(path.join(root,'index.html'),'utf8')).replace('</body>',
    `<script id="catalog-snapshot" type="application/json">${JSON.stringify(seed).replaceAll('<','\\u003c')}</script></body>`);
  res.setHeader('Content-Type','text/html');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({ args: ['--lang=zh-CN'], channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/item/4010001?hours=all&lang=zh');
  await page.locator('[data-react-catalogue="item"]').waitFor();
  assert.equal(reads,0,'fresh SSR data must avoid a second full-detail request');
  const quotes=page.locator('.where-well [data-quote]');
  assert.equal(await page.locator('.cgroup').count(),0,'lowest-price order is one list, not channel groups');
  assert.equal(await quotes.count(),20,'phones start with the cheapest 20 offers');
  assert.equal(await quotes.first().getAttribute('data-unit-price'),'100','cheapest offer first');
  await page.locator('[data-more=where]').click();
  assert.equal(await quotes.count(),2000,'show all exposes every offer');
  revision++;
  for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(at=>Number(document.querySelector('.item-stall')?.dataset.asOf)===at,(now+revision*1000)/1000);
  assert.equal(await quotes.count(),2000,'live refresh keeps the full list open');
  assert.equal(reads,1);
  const beforeBurst=reads;delay=350;revision++;
  const started=page.waitForRequest(r=>r.url().includes('/api/v1/catalog/page'));
  for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await started;
  await new Promise(resolve=>setTimeout(resolve,40));
  revision++;
  for(let i=0;i<20;i++)for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(at=>Number(document.querySelector('.item-stall')?.dataset.asOf)===at,(now+revision*1000)/1000);
  assert.equal(reads,beforeBurst+2,'an in-flight refresh finishes and a burst causes only one trailing request');
  delay=0;
  await page.selectOption('[data-offer-sort]','recent');
  assert.equal(await page.locator('.recent-offers [data-quote]').count(),20,'recent order starts with the latest 20 offers on phones');
  await page.locator('[data-more=recent]').click();
  assert.equal(await page.locator('.recent-offers [data-quote]').count(),2000,'all sorted offers stay accessible');
  await page.selectOption('[data-offer-sort]','price');
  stale=true;const before=reads;
  await page.reload();
  await page.locator('[data-react-catalogue="item"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-react-catalogue="item"]')?.getAttribute('aria-busy')==='false');
  assert.equal(reads,before+1,'an old cached HTML snapshot must refresh');
  assert.equal(craftReads,0,'items without recipes must not fetch crafting prices');
  assert.deepEqual(errors,[]);
  await page.close();stale=false;
  const defaultPage=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const defaultReads=reads;
  await defaultPage.goto(origin+'/item/4010001?lang=zh');
  await defaultPage.locator('[data-react-catalogue="item"]').waitFor();
  await defaultPage.waitForTimeout(200);
  assert.equal(reads,defaultReads,'default 72h must reuse the HTML snapshot');
  assert.equal(new URL(defaultPage.url()).searchParams.has('hours'),false,'do not rewrite the unchanged default period');
  const response=defaultPage.waitForResponse(r=>r.url().includes('/api/v1/catalog/page'));
  for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  assert.equal((await response).status(),304,'first unchanged SSE reuses the seeded validator');
  assert(unchanged>0);
  assert.equal(await defaultPage.locator('.where-well [data-quote]').count(),20,'304 retains rendered data');
  console.log('PASS item detail: no duplicate fresh request; cheapest 20 first on phones; show all survives SSE; stale HTML refresh');
}finally{await browser.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
