import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.resolve(root,'../market_data/enhancement-review');await mkdir(output,{recursive:true});
const source=await readFile(path.join(root,'js/lib/enhancement.js'),'utf8');
const {calculateMixedEnhancement:calculate}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const streams=new Set();let generation=0;
const equipment=id=>({item_id:id,name_zh:id===1082000?'工地手套':'战斗弓',name_en:id===1082000?'Work Gloves':'Battle Bow',mapledex_reference:{data:{tuc:id===1082000?5:7}}});
const scroll=(id,rate,gain)=>({item_id:id,name_zh:`攻击卷轴 ${rate}%`,name_en:`Attack scroll ${rate}%`,mapledex_reference:{data:{success:rate,d:{en:`Success rate: ${rate}%, Weapon Attack +${gain}`}}}});
const records={1082000:equipment(1082000),1452003:equipment(1452003),2040801:scroll(2040801,60,2),2040802:scroll(2040802,10,3),2044501:scroll(2044501,60,2),2044502:scroll(2044502,10,3)};
const json=(res,data)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(url.pathname==='/api/v1/account')return json(res,{signed_in:false});
 if(url.pathname==='/api/v1/watchlist/catalog')return json(res,{items:[equipment(1452003),equipment(1082000)]});
 if(url.pathname.startsWith('/api/v1/enhancement/scrolls/')){const gloves=url.pathname.endsWith('1082000');return json(res,{scrolls:[records[gloves?2040801:2044501],records[gloves?2040802:2044502]]});}
 if(url.pathname.startsWith('/api/v1/items/'))return json(res,records[url.pathname.split('/').pop()]);
 if(url.pathname.startsWith('/api/v1/item/')){const id=Number(url.pathname.split('/').pop()),gear=id<2000000;return json(res,{generated_at:Date.now()/1000,listings:gear?[{unit_price:100,stock:1,equipment:{enhancements:0,remaining_upgrades:id===1082000?5:7}},{unit_price:1,stock:1,equipment:{enhancements:1,remaining_upgrades:4}},{unit_price:2,stock:1,equipment:{enhancements:0,remaining_upgrades:4}}]:[{unit_price:(id%100===1?100:20)+generation,stock:1}]});}
 if(url.pathname.startsWith('/api/'))return json(res,{});
 const asset=url.pathname.startsWith('/web/')?url.pathname.slice(5):'index.html';
 try{res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(root,asset)));}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try{
 for(const width of [375,1280]){
  generation=0;
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width===375,hasTouch:width===375});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('lang','zh');localStorage.setItem('theme','light');window.documentIdentity=Math.random();});
  await page.goto(origin+'/tools');await page.locator('[data-tool=enhancement]').waitFor();
  assert.equal(await page.locator('[data-nav-key=tools]:visible').textContent(),'工具');assert.equal(await page.locator('[data-nav-key=alerts]').count(),0);
  const identity=await page.evaluate(()=>window.documentIdentity);
  await page.locator('[data-tool=enhancement]').click();await page.locator('[data-enhance-total]').waitFor();
  assert.equal(await page.locator('#enhance-equipment-price').inputValue(),'100');
  assert.equal(await page.locator('#enhance-scroll-2040801').inputValue(),'100');assert.equal(await page.locator('#enhance-scroll-2040802').inputValue(),'20');
  const expected=target=>calculate({equipmentPrice:100,slots:5,target,scrolls:[{id:2040801,price:100,gain:2,successRate:.6},{id:2040802,price:20,gain:3,successRate:.1}]}).expectedCost;
  const near=async value=>{await page.waitForFunction(value=>Math.abs(Number(document.querySelector('[data-enhance-total]')?.dataset.enhanceTotal)-value)<1e-5,value);};
  await near(expected(6));await page.locator('#enhance-target').fill('7');await near(expected(7));
  await page.locator('.enhance-steps summary').click();assert(await page.locator('.enhance-steps tbody tr').count()>1);
  await page.locator('#enhance-scroll-2040802').fill('12');
  generation=5;for(const stream of streams)stream.write('event: market\ndata: {}\n\n');
  await page.waitForFunction(()=>document.querySelector('#enhance-scroll-2040801')?.value==='105');
  assert.equal(await page.locator('#enhance-scroll-2040802').inputValue(),'12','manual prices survive SSE');
  await page.locator('#enhance-target').fill('');await page.locator('[data-enhance-total]').waitFor({state:'detached'});
  await page.locator('#enhance-target').fill('999');assert.equal(await page.locator('[data-enhance-total]').count(),0);
  await page.locator('#enhance-target').fill('10');await page.locator('[data-enhance-total]').waitFor();
  const input=page.locator('.enhance-picker input');await input.fill('战斗弓');await page.locator('.enhance-choices button').first().click();
  await page.locator('#enhance-scroll-2044501').waitFor();await page.locator('[data-enhance-total]').waitFor();assert.equal(await page.locator('#enhance-target').inputValue(),'10');
  assert.match(await page.locator('.enhance-quote').first().textContent(),/7 次/);
  for(const theme of ['light','dark']){
   if(theme==='dark')await page.locator('[data-theme-toggle]:visible').click();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
   const fonts=await page.locator('.enhancement-page input,.enhancement-page select').evaluateAll(nodes=>nodes.map(node=>parseFloat(getComputedStyle(node).fontSize)));assert(fonts.every(size=>size>=16));
   await page.screenshot({path:path.join(output,`enhancement-${width}-${theme}.png`),fullPage:true});
  }
  await page.locator('.tool-breadcrumb a').click();await page.locator('[data-tool=collection]').click();await page.locator('.alerts-page h1').waitFor();
  assert.equal(await page.locator('[data-nav-key=tools]:visible').getAttribute('aria-current'),'page');
  assert.equal(await page.evaluate(()=>window.documentIdentity),identity,'secondary navigation stays in the same document');
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${width}px: tools, mixed scrolls, typed targets, market quotes, SSE edits, equipment switching, themes and collection`);
 }
}finally{await browser.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
