import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))), now=Date.now()/1000, streams=new Set();
const product={item_id:4010001,name_zh:'铁矿石',name_en:'Iron Ore',category:'其他',typical:300,low:290,sales_window:4,last_seen:now};
let local=false;
const record=()=>({...product,id:'row',shop:local?'Local shop':null,owner_name:local?'LocalRole':'ExternalRole',source:local?'packet':'mesowatch',
  time:now,observed:now,unit_price:300,sale_unit_price:300,kind:'found_sold',quantity:null,stock:null,location:{room:7}});
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/v1/events') {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
  if(url.pathname.startsWith('/api/')) {
    let data={};
    if(url.pathname==='/api/v1/account')data={signed_in:false};
    if(url.pathname==='/api/v1/market')data={products:[product],as_of:now};
    if(url.pathname==='/api/v1/market/period-default')data={default_hours:'all'};
    if(url.pathname==='/api/v1/market/records')data={records:[record()]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
  }
  const file=url.pathname.startsWith('/web/')?path.resolve(root,'.'+url.pathname.slice(4)):path.join(root,'index.html');
  if(!file.startsWith(root+path.sep)){res.writeHead(404);res.end();return;}
  try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(file));}
  catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try {
  for(const width of [390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900},isMobile:width<640,hasTouch:width<640});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
    for(const mode of ['recent','lastsale']) {
      local=false;await page.goto(`http://127.0.0.1:${server.address().port}/?lang=en&hours=all&sort=${mode}`);
      const row=page.locator('[data-price-records] .market-record');await row.waitFor();
      assert.equal(await row.locator('.record-shop-text').textContent(),'ExternalRole');
      assert.equal(await row.locator('.record-shop').getAttribute('title'),'Player name');
      assert.equal(await row.locator('.shop-name-toggle').count(),0);
      local=true;await page.reload();await row.waitFor();
      assert.equal(await row.locator('.record-shop-text').textContent(),'Local shop');
      await row.locator('.shop-name-toggle').click();
      assert.equal(await row.locator('.record-shop-text').textContent(),'LocalRole');
    }
    assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${width}px: external roles and native shop/role toggle in quotes and sales`);
  }
} finally {await browser.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
