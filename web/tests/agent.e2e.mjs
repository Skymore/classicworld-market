// Isolated AI SDK stream/history fixture; no external model calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),output=path.resolve(root,'../market_data/agent-native-tests');await mkdir(output,{recursive:true});
const streams=new Set(),threads=new Map();let profile={signed_in:false},mode='success',requests=[],counter=0;
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(url.pathname==='/api/v1/account')return json(res,profile);
 if(url.pathname==='/api/v1/account/data')return json(res,{records:[]});
 if(url.pathname==='/api/v1/agent/threads'&&req.method==='GET')return json(res,{threads:[...threads.values()].map(({messages,...rest})=>rest)});
 const match=/^\/api\/v1\/agent\/threads\/([^/]+)$/.exec(url.pathname);
 if(match){const thread=threads.get(match[1]);if(!thread)return json(res,{error:'conversation_not_found'},404);if(req.method==='GET')return json(res,{...thread,has_more:false});assert.equal(req.headers['x-csrf-token'],'fixture-csrf');if(req.method==='DELETE'){threads.delete(match[1]);return json(res,{ok:true});}let raw='';for await(const chunk of req)raw+=chunk;thread.title=JSON.parse(raw).title;return json(res,thread);}
 if(url.pathname==='/api/v1/agent/stream'){
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);if(mode==='quota')return json(res,{error:'agent_free_quota_exceeded'},429);
  const id=profile.signed_in?(body.thread_id||'t'+(++counter)):null;
  const answer='建议 **钢铁**。 [物品详情](/item/4010001) <script>window.agentPwned=true</script> [bad](javascript:alert(1))';
  const metadata={thread_id:id,state:'complete',sources:['/item/4010001','javascript:alert(1)','https://evil.test'],tool_calls:[{name:'get_price_advice',arguments:{item_id:4010001},ok:true}]};
  if(id){const old=threads.get(id)||{id,title:body.message,updated_at:Date.now()/1000,messages:[]};old.messages.push({id:body.request_id,request_id:body.request_id,seq:old.messages.length+1,role:'user',content:body.message,state:'complete',metadata:{}},{id:'answer-'+requests.length,seq:old.messages.length+2,role:'assistant',content:answer,state:'complete',metadata});threads.set(id,old);}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','x-vercel-ai-ui-message-stream':'v1'});
  const send=value=>res.write('data: '+JSON.stringify(value)+'\n\n');send({type:'start',messageId:'answer-'+requests.length});send({type:'data-session',data:{thread_id:id},transient:true});send({type:'text-start',id:'answer'});
  if(mode==='slow'){send({type:'text-delta',id:'answer',delta:'Partial reply'});return;}
  send({type:'text-delta',id:'answer',delta:answer});send({type:'text-end',id:'answer'});send({type:'finish',messageMetadata:metadata});res.end('data: [DONE]\n\n');return;
 }
 if(url.pathname.startsWith('/api/'))return json(res,{});
 const file=url.pathname.startsWith('/web/')?path.resolve(root,'.'+url.pathname.slice(4)):path.join(root,'index.html');if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});for(const mobile of [true,false]){profile={signed_in:false};mode='success';requests=[];threads.clear();const page=await browser.newPage({viewport:{width:mobile?375:1440,height:900},isMobile:mobile,hasTouch:mobile});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/agent?lang='+ (mobile?'zh':'en'));await page.locator('[data-agent-chat]').waitFor();const input=page.locator('.chat-composer textarea'),send=page.locator('.chat-composer button[type=submit]');
 assert.equal(await page.locator('.chat-footnote').count(),0,'redundant account/source footnote is removed');
 for(const width of mobile?[320,375]:[1440]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.locator('.chat-guide-toggle .chat-action-label').isVisible(),true,'Guides has a visible text label on phones');
  const actions=await page.locator('.chat-actions button:visible').evaluateAll(nodes=>nodes.map(node=>{
   const svg=node.querySelector('svg').getBoundingClientRect(),label=node.querySelector('.chat-action-label').getBoundingClientRect(),box=node.getBoundingClientRect();
   const range=document.createRange();range.selectNodeContents(node.querySelector('.chat-action-label'));const text=range.getBoundingClientRect();
   return {icon:svg.width===16&&svg.height===16,centered:Math.abs((svg.top+svg.bottom-label.top-label.bottom)/2)<1,iconTop:svg.top,textTop:text.top,inside:box.left>=0&&box.right<=innerWidth};
  }));
  assert(actions.every(action=>action.icon&&action.centered&&action.inside),'header actions have aligned 16px icons and visible text');
  assert(actions.every(action=>Math.abs(action.iconTop-actions[0].iconTop)<1&&Math.abs(action.textTop-actions[0].textTop)<1),'all header icons and text align across buttons');
  const buttons=page.locator('.chat-examples button');assert.equal(await buttons.count(),4);
  assert(await buttons.evaluateAll(nodes=>nodes.every(node=>{const b=node.getBoundingClientRect();return b.height<=36&&b.width<node.parentElement.clientWidth&&b.right<=innerWidth;})),'example pills stay compact and fit');
  assert(await input.evaluate(node=>{const s=getComputedStyle(node),ctx=document.createElement('canvas').getContext('2d');ctx.font=s.font;return s.whiteSpace==='nowrap'&&ctx.measureText(node.placeholder).width<=node.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight);}), 'placeholder fits on one line without shrinking editable text');
 }
 if(mobile){
  await page.goto(origin+'/agent?lang=en');await page.locator('[data-agent-chat]').waitFor();
  for(const width of [320,375]){await page.setViewportSize({width,height:900});assert(await page.locator('.chat-guide-toggle .chat-action-label').isVisible());assert(await page.locator('.chat-actions').evaluate(node=>{const b=node.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth;}),'English action group stays together inside a narrow viewport');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.goto(origin+'/agent?lang=zh');await page.locator('[data-agent-chat]').waitFor();
 }
 const first=page.locator('.chat-examples button').first(),prompt=await first.getAttribute('title');await first.click();assert.equal(await input.inputValue(),prompt,'compact labels still insert the complete question');
 await input.fill('one\ntwo\nthree');assert(await input.evaluate(node=>node.getBoundingClientRect().height>60),'real multiline questions grow the composer');await input.fill('');
 await page.screenshot({path:path.join(output,`agent-welcome-${mobile?'phone':'desktop'}.png`)});
 await input.fill('sell iron');await send.click();await page.locator('.chat-sources a').waitFor();assert.equal(requests.length,1);assert.deepEqual(requests[0].history,[]);assert.equal(await page.evaluate(()=>window.agentPwned),undefined);assert.equal(await page.locator('.chat-answer script').count(),0);assert.equal(await page.locator('.chat-sources a').count(),1);assert.equal(await page.locator('.chat-answer a').getAttribute('href'),'/item/4010001');await input.fill('quick sale?');await send.click();await page.waitForFunction(()=>document.querySelectorAll('.chat-sources').length===2);assert.equal(requests[1].history.length,2);
 mode='quota';await input.fill('quota');await send.click();await page.locator('.chat-error').waitFor();assert.match(await page.locator('.chat-error').textContent(),/额度|quota/);mode='slow';await page.locator('.chat-retry').click();await page.locator('.chat-composer button[type=button]').click();await input.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.chat-composer textarea').disabled);
 profile={signed_in:true,public_id:'fixture-user',nickname:'Maple',csrf:'fixture-csrf'};mode='success';await page.goto(origin+'/agent?lang='+(mobile?'zh':'en'));assert.equal(await page.locator('.chat-footnote').count(),0,'signed-in state has no footnote');await input.fill('saved conversation');await send.click();await page.waitForURL(url=>url.searchParams.has('chat'));await page.locator('.chat-sources a').waitFor();if(mobile)await page.locator('.chat-history-toggle').click();await page.locator('.chat-history-title').waitFor();await page.locator('[aria-label="'+(mobile?'重命名对话':'Rename conversation')+'"]').click();await page.locator('.chat-title-input').fill('Renamed history');await page.locator('[role=dialog] button[type=submit]').click();await page.locator('.chat-history-title').filter({hasText:'Renamed history'}).waitFor();await page.reload();await page.locator('.chat-sources a').waitFor();if(mobile)await page.locator('.chat-history-toggle').click();await page.locator('[aria-label="'+(mobile?'删除对话':'Delete conversation')+'"]').click();await page.locator('[role=dialog] button[type=submit]').click();await page.waitForFunction(()=>!new URL(location.href).searchParams.has('chat'));assert.equal(threads.size,0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`agent-${mobile?'phone':'desktop'}.png`)});assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${mobile?'phone Chinese':'desktop English'}: AI SDK streams, safe evidence, guest history, quota/retry/stop, saved conversations, rename/delete and reload`);}}
finally{await browser?.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
