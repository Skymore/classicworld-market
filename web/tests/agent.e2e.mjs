// Isolated UI fixture; never calls OpenRouter or the production market.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.resolve(root,'../market_data/agent-tests');await mkdir(output,{recursive:true});
let enabled=true,mode='success',requests=[];
const streams=new Set();
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(url.pathname==='/api/v1/agent/tools')return json(res,{enabled,tools:[{function:{name:'search_items'}},{function:{name:'get_price_advice'}}]});
 if(url.pathname==='/api/v1/agent/chat'){
  let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
  if(mode==='quota')return json(res,{error:'agent_free_quota_exceeded'},429);
  if(mode==='slow'){setTimeout(()=>{if(!res.destroyed)json(res,{answer:'late'});},1500).unref();return;}
  return json(res,{answer:'建议先看 **钢铁** 的报价。\n[物品详情](/item/4010001)\n<script>window.agentPwned=true</script>\n[bad](javascript:alert(1))',
   tool_calls:[{name:'search_items',arguments:{query:'钢铁'},ok:true},{name:'get_price_advice',arguments:{item_id:4010001},ok:true}],
   sources:['/item/4010001','javascript:alert(1)','https://evil.test']});
 }
 if(url.pathname==='/api/v1/account')return json(res,{signed_in:false});
 if(url.pathname.startsWith('/api/'))return json(res,{});
 const file=url.pathname.startsWith('/web/')?path.resolve(root,'.'+url.pathname.slice(4)):path.join(root,'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
 for(const mobile of [true,false]){
  enabled=true;mode='success';requests=[];
  const page=await browser.newPage({viewport:mobile?{width:375,height:812}:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/agent?lang=${mobile?'zh':'en'}&theme=${mobile?'light':'dark'}`);
  await page.locator('.agent-welcome').waitFor();
  assert.equal(await page.locator('[data-nav-key=agent][aria-current=page]').count(),2);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,`agent-empty-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  await page.locator('[data-example="0"]').click();await page.locator('.agent-send').click();
  await page.locator('.agent-sources a').waitFor();
  assert.equal(requests.length,1);assert.deepEqual(requests[0].history,[]);
  assert.equal(requests[0].language,mobile?'zh':'en');
  assert.equal(await page.locator('.agent-sources a').count(),1);
  assert.equal(await page.locator('.agent-answer a').getAttribute('href'),'/item/4010001');
  assert.equal(await page.evaluate(()=>window.agentPwned),undefined);
  assert.equal(await page.locator('.agent-answer script').count(),0);
  assert.equal(await page.locator('[data-stop]').isVisible(),false);
  await page.locator('.agent-trace summary').click();assert.match(await page.locator('.agent-trace pre').innerText(),/get_price_advice/);
  await page.locator('textarea').fill(mobile?'我要快点卖呢？':'What if I want a quick sale?');
  await page.locator('.agent-send').click();await page.locator('.agent-assistant').nth(1).locator('.agent-sources').waitFor();
  assert.equal(requests.at(-1).history.length,2);assert.equal(requests.at(-1).history[1].role,'assistant');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,`agent-results-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  mode='quota';await page.locator('textarea').fill('retry this');await page.locator('.agent-send').click();
  await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.length>0);
  assert.match(await page.locator('[data-status]').innerText(),mobile?/免费模型/:/free model/);
  assert.equal(await page.locator('textarea').inputValue(),'retry this');
  assert.equal(await page.locator('.agent-user').count(),2);
  mode='slow';await page.locator('.agent-send').click();await page.locator('[data-stop]').click();
  await page.waitForFunction(()=>!document.querySelector('.agent-send').disabled);
  assert.match(await page.locator('[data-status]').innerText(),mobile?/已停止/:/Stopped/);
  await page.locator('[data-clear]').click();assert.equal(await page.locator('.agent-message').count(),0);
  mode='success';await page.locator('textarea').fill('sell ores');await page.locator('.agent-send').click();await page.locator('.agent-sources').waitFor();
  assert.deepEqual(requests.at(-1).history,[]);
  // Language changes remount this cached module, including all page-local text.
  await page.locator('[data-lang-toggle]:visible').click();
  await page.waitForFunction(expected=>document.querySelector('.agent-panel h1').textContent===expected,mobile?'Market assistant':'市场助手');
  enabled=false;const previous=requests.length;await page.reload();
  await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('OPENROUTER_API_KEY'));
  await page.locator('textarea').fill('buy ores');await page.locator('.agent-send').click();assert.equal(requests.length,previous);
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${mobile?'mobile Chinese/light':'desktop English/dark'}: chat, history, queries, safe links, quota, cancel, clear, language, setup state`);
 }
}finally{await browser?.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
