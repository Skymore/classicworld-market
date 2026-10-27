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
let reads = 0, revision = 0, stale = false, delay = 0, craftReads = 0;
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
    if(delay)return setTimeout(()=>json(res,value),delay);
    return json(res,value);
  }
  if(url.pathname==='/api/v1/crafting/prices'){craftReads++;return json(res,{prices:[]});}
  if(url.pathname==='/api/v1/account')return json(res,{signed_in:false});
  if(url.pathname.startsWith('/api/'))return json(res,{});
  if(url.pathname.startsWith('/web/')){
    const file=path.resolve(root,'.'+url.pathname.slice(4));
    if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
    try {res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(file));}
    catch {res.writeHead(404);res.end();}return;
  }
  const seed={url:'/item/4010001?hours=all',updatedAt:Date.now()-(stale?60000:0),data:snapshot()};
  const html=(await readFile(path.join(root,'index.html'),'utf8')).replace('</body>',
    `<script id="catalog-snapshot" type="application/json">${JSON.stringify(seed).replaceAll('<','\\u003c')}</script></body>`);
  res.setHeader('Content-Type','text/html');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/item/4010001?hours=all&lang=zh');
  await page.locator('[data-react-catalogue="item"]').waitFor();
  assert.equal(reads,0,'fresh SSR data must avoid a second full-detail request');
  assert.equal(await page.locator('.cgroup').count(),40,'every channel remains discoverable');
  assert.equal(await page.locator('.cgroup:not(.open) [data-quote]').count(),0,'collapsed offers must not inflate the DOM');
  assert.equal(await page.locator('.cgroup.open [data-quote]').count(),50);
  const second=page.locator('.cgroup').nth(1);
  await second.locator('[data-ch]').click();
  assert.equal(await second.locator('[data-quote]').count(),50,'opening a channel exposes all its offers');
  revision++;
  for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(at=>Number(document.querySelector('.item-stall')?.dataset.asOf)===at,(now+revision*1000)/1000);
  assert.equal(await second.locator('[data-ch]').getAttribute('aria-expanded'),'true','live refresh preserves opened channels');
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
  await second.locator('[data-ch]').click();
  assert.equal(await second.locator('[data-quote]').count(),0);
  await page.selectOption('[data-offer-sort]','recent');
  assert.equal(await page.locator('.recent-offers [data-quote]').count(),50,'recent order starts with the latest 50 offers');
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
  console.log('PASS item detail: no duplicate fresh request; 2000 offers defer collapsed DOM; expand/collapse + SSE; stale HTML refresh');
}finally{await browser.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
