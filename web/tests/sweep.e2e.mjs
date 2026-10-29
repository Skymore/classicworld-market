// Device sign-in page, My devices, the watch-page sweep panel and the shared
// account event stream, against mocked SWEEP.md endpoints. No real server.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const shots=process.env.SWEEP_SCREENSHOT_DIR||'/tmp/cwm-sweep-shots';await mkdir(shots,{recursive:true});
const now=()=>Date.now()/1000,iso=s=>new Date(Date.now()+s*1000).toISOString();
const PASSWORD='a long unique maple passphrase',CSRF='csrf-fixture';
const products=[
 {item_id:2000000,name_zh:'红药水',name_en:'Red Potion',category:'消耗品',typical:50},
 {item_id:1452003,name_zh:'战斗弓',name_en:'Battle Bow',category:'装备',typical:95000},
 {item_id:2070000,name_zh:'海星镖',name_en:'Subi Throwing-Stars',category:'消耗品',typical:900},
];
const group=(id,cap)=>({id,name:'',cap,notify:false,buy:true,reminder:{}});
const records=[
 {kind:'watch',key:'2000000',version:1,value:{position:0,cap:null,notify:false,buyLimit:20,groups:[group('g1',60)]}},
 {kind:'watch',key:'1452003',version:1,value:{position:1,cap:null,notify:false,buyLimit:1,groups:[group('g2',80000)]}},
];
const device=(id,name,{online=true,allow=true,ready=true,reason='',seen=-10}={})=>({id,name,created_at:iso(-86400),last_seen_at:iso(seen),online,client_version:'0.7.0',
 state:{client_version:'0.7.0',sweep:{allow_web_start:allow,max_spend:5000000,max_order:0,reserve_mesos:0,executor:{ready,reason}}}});
const statuses=['bought','not_bought','held','unknown','expired'];
const purchases=Array.from({length:24},(_,i)=>({id:'p'+i,device:'dev-a',item_id:[2000000,1452003,2070000][i%3],status:statuses[i%5],quantity:i%3===2?1:2,units:i%3===2?500:2,price:i%3===1?75000:50,
 spent:statuses[i%5]==='bought'?(i%3===1?75000:100):0,reason:statuses[i%5]==='not_bought'?'sold_out':null,room:3,channel:12,owner:'店主'+i,created_at:iso(-i*30),settled_at:iso(-i*30+5)}));
let state,profile,calls,accountStreams=new Set(),marketStreams=new Set();
function reset({signedIn=true,mode=undefined,hasPassword=true}={}){
 profile={signed_in:signedIn,google_enabled:true,...(signedIn?{public_id:'acct-1',username:hasPassword?'maple_one':null,has_password:hasPassword,google_linked:!hasPassword,nickname:'枫叶玩家',listed:false,csrf:CSRF,collectors:1,stats:{shops:3,quotes:9}}:{}),
  ...(mode?{mode,sync_scope:'watch',linked:true}:{})};
 state={run:null,devices:[device('dev-a','书房电脑'),device('dev-b','笔记本',{online:false,seen:-7200}),device('dev-c','网吧电脑',{allow:false}),device('dev-d','客厅电脑',{ready:false,reason:'此电脑尚未安装购买执行器'})],
  authorize:'ok',reauth:!hasPassword};
 calls=[];
}
const newRun=input=>({id:'run-1',status:'running',stop_reason:null,budget:input.budget,spent:1200000,reserved:300000,unknown:50000,remaining:input.budget-1550000,
 started_at:iso(-60),ends_at:iso(input.minutes*60),started_by:'web',plan_version:1,plan_stale:false,items:[{item_id:2000000,limit:20,units:4},{item_id:1452003,limit:1,units:0}],
 devices:[{id:'dev-a',name:'书房电脑',state:'active',message:'正在扫 3 洞',online:true,spent:1200000}],purchases});
const sweepBody=()=>({run:state.run,devices:state.devices});
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const sse=(req,res,set)=>{res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write(set===accountStreams?'event: hello\ndata: {}\n\n':': ready\n\n');set.add(res);req.on('close',()=>set.delete(res));};
const emit=topic=>{for(const s of accountStreams)s.write(`event: ${topic}\ndata: {}\n\n`);};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let input={};
 if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;input=raw?JSON.parse(raw):{};}
 const p=url.pathname;
 if(p==='/api/v1/events')return sse(req,res,marketStreams);
 if(p==='/api/v1/account/events'){if(!profile.signed_in)return json(res,{error:'login_required'},401);return sse(req,res,accountStreams);}
 if(p==='/api/v1/account')return json(res,profile);
 if(req.method==='POST'&&(p.startsWith('/api/v1/account/')||p.startsWith('/api/v1/device/'))){
  calls.push({path:p,body:input,csrf:req.headers['x-csrf-token']});
  if(p==='/api/v1/account/login'){if(input.password!==PASSWORD)return json(res,{error:'invalid_credentials'},401);reset();return json(res,{ok:true});}
  if(!profile.signed_in)return json(res,{error:'login_required'},401);
  if(req.headers['x-csrf-token']!==CSRF)return json(res,{error:'invalid_request'},403);
  if(p==='/api/v1/account/logout'){reset({signedIn:false});return json(res,{ok:true});}
  if(p==='/api/v1/account/data'){for(const op of input.operations||[]){const old=records.find(r=>r.kind===op.kind&&r.key===op.key);if(old){old.value=op.value;old.version++;}else records.push({...op,version:1});}return json(res,{records});}
  if(p==='/api/v1/device/authorize'){if(state.authorize==='rate_limited')return json(res,{error:'rate_limited'},429);return json(res,{code:'C'.repeat(43)});}
  if(p==='/api/v1/account/devices/revoke'){state.devices=state.devices.filter(d=>d.id!==input.device);return json(res,{ok:true});}
  const sensitive=()=>{if(profile.has_password)return input.current_password===PASSWORD?null:'invalid_current_password';if(state.reauth){state.reauth=false;return 'reauth_required';}return null;};
  if(p==='/api/v1/account/sweep/start'){const e=sensitive();if(e)return json(res,{error:e},401);if(state.run?.status==='running')return json(res,{error:'sweep_running'},409);state.run=newRun(input);return json(res,sweepBody());}
  if(p==='/api/v1/account/sweep/apply'){const e=sensitive();if(e)return json(res,{error:e},401);state.run={...state.run,plan_stale:false,plan_version:state.run.plan_version+1};return json(res,sweepBody());}
  if(p==='/api/v1/account/sweep/stop'){state.run={...state.run,status:'stopped',stop_reason:'stopped_on_web'};return json(res,sweepBody());}
  return json(res,{ok:true});
 }
 if(p.startsWith('/api/v1/account/')&&!profile.signed_in)return json(res,{error:'login_required'},401);
 if(p==='/api/v1/account/data')return json(res,{records});
 if(p==='/api/v1/account/devices')return json(res,{devices:state.devices});
 if(p==='/api/v1/account/sweep'){calls.push({path:p});return json(res,sweepBody());}
 if(p==='/api/v1/market/selected')return json(res,{products:products.filter(x=>(url.searchParams.get('ids')||'').split(',').map(Number).includes(x.item_id)),as_of:now()});
 if(p==='/api/v1/market/period-default')return json(res,{default_hours:'all'});
 if(p==='/api/v1/watchlist/catalog')return json(res,{items:products,presets:[]});
 if(p==='/api/v1/watchlist/listings')return json(res,{listings:[],grouped_listings:[],percentile_caps:{},base_stats:{},generated_at:now(),revision:1});
 if(p.startsWith('/api/'))return json(res,{});
 const file=p.startsWith('/web/')?path.resolve(root,'.'+decodeURIComponent(p.slice(4))):path.join(root,'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const CALLBACK='http://127.0.0.1:43123/callback',STATE='s'.repeat(43),CHALLENGE='c'.repeat(43);
const deviceUrl=(redirect=CALLBACK,name='书房电脑')=>`${origin}/device?lang=zh&redirect_uri=${encodeURIComponent(redirect)}&state=${STATE}&challenge=${CHALLENGE}&name=${encodeURIComponent(name)}`;
const noOverflow=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
const lastCall=suffix=>calls.filter(c=>c.path.endsWith(suffix)).at(-1);
const waitFor=async(fn,message)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail(message);};
let browser;
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
 for(const mobile of [false,true]){
  const tag=mobile?'phone':'desktop';
  const context=await browser.newContext({viewport:{width:mobile?390:1280,height:mobile?844:900},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // A returning browser can retain the pre-device account module for four
  // hours at the CDN. New account/watch chunks must work with that stale URL.
  await page.route('**/web/js/lib/user-data.js', route=>route.fulfill({
   contentType:'text/javascript',body:'export const userStorage=localStorage; export const ready=Promise.resolve();',
  }));
  const callbacks=[];await page.route('http://127.0.0.1:43123/**',route=>{callbacks.push(route.request().url());route.fulfill({contentType:'text/html',body:'<p>callback</p>'});});

  // /device: invalid links show only an error.
  reset();
  for(const bad of ['http://localhost:43123/callback','http://127.0.0.1:80/callback','http://127.0.0.1:43123/other','https://127.0.0.1:43123/callback']){
   await page.goto(deviceUrl(bad));await page.locator('[data-device-invalid]').waitFor();
   assert.equal(await page.locator('[data-device-allow],[data-device-cancel]').count(),0,'invalid redirect has no buttons: '+bad);
  }
  await page.goto(`${origin}/device?lang=zh&redirect_uri=${encodeURIComponent(CALLBACK)}&state=${STATE}&challenge=short&name=x`);await page.locator('[data-device-invalid]').waitFor();
  if(!mobile)await page.screenshot({path:path.join(shots,`device-invalid-${tag}.png`)});
  // Not signed in: the site's sign-in form, then the question on the same page.
  reset({signedIn:false});
  await page.goto(deviceUrl());await page.locator('[data-auth]').waitFor();
  assert.equal(await page.locator('[data-device-allow]').count(),0);
  assert.equal(await page.locator('a.google-signin').getAttribute('href'),'/auth/google/start');
  await page.locator('[data-auth] [name=username]').fill('maple_one');await page.locator('[data-auth] [name=password]').fill(PASSWORD);
  await page.locator('[data-auth] button[type=submit]').click();
  await page.locator('[data-device-question]').waitFor();
  assert.equal(new URL(page.url()).pathname,'/device','sign-in stays on the device page');
  assert.equal((await page.locator('[data-device-question]').innerText()).replace(/\s+/g,''),'允许「书房电脑」登录枫叶玩家？');
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`device-${tag}.png`)});
  // Rate limits and other errors stay on the page.
  state.authorize='rate_limited';await page.locator('[data-device-allow]').click();
  await page.locator('[data-device-status]').filter({hasText:'请求较多'}).waitFor();assert.equal(new URL(page.url()).pathname,'/device');
  // Allow: authorize with CSRF, then back to the loopback callback with code and state.
  state.authorize='ok';await page.locator('[data-device-allow]').click();
  await page.waitForURL(u=>u.href.startsWith(CALLBACK));
  const allowed=new URL(page.url());assert.equal(allowed.searchParams.get('code'),'C'.repeat(43));assert.equal(allowed.searchParams.get('state'),STATE);
  const authorize=lastCall('/device/authorize');assert.equal(authorize.csrf,CSRF);assert.deepEqual(authorize.body,{redirect_uri:CALLBACK,challenge:CHALLENGE,name:'书房电脑'});
  // Cancel: access_denied with the same state, no authorize call.
  const before=calls.filter(c=>c.path.endsWith('/device/authorize')).length;
  await page.goto(deviceUrl());await page.locator('[data-device-cancel]').click();
  await page.waitForURL(u=>u.href.startsWith(CALLBACK));
  const denied=new URL(page.url());assert.equal(denied.searchParams.get('error'),'access_denied');assert.equal(denied.searchParams.get('state'),STATE);
  assert.equal(calls.filter(c=>c.path.endsWith('/device/authorize')).length,before);

  // My devices: status, executor, revoke, live update; one shared event stream.
  reset();
  await page.goto(origin+'/account?lang=zh');await page.locator('[data-setting=devices]').waitFor();
  assert.equal(await page.locator('[data-setting=collectors]').count(),0,'the old collector-linking section is gone for new clients');
  await page.locator('[data-setting=devices] summary').click();
  const rows=page.locator('[data-device-row]');await rows.first().waitFor();assert.equal(await rows.count(),4);
  const row=id=>page.locator(`[data-device-row="${id}"]`);
  assert.match(await row('dev-a').innerText(),/书房电脑[\s\S]*在线 · v0\.7\.0 · 可以扫货/);
  assert.match(await row('dev-b').innerText(),/最后在线 2小时前/);
  assert.match(await row('dev-d').innerText(),/此电脑尚未安装购买执行器/);
  await waitFor(()=>accountStreams.size===1,'account page opens one account event stream');
  assert(await noOverflow(page));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,`account-devices-${tag}.png`),fullPage:true});
  await row('dev-c').getByRole('button',{name:'退出这台设备'}).click();await row('dev-c').waitFor({state:'detached'});
  assert.deepEqual(lastCall('/devices/revoke').body,{device:'dev-c'});assert.equal(lastCall('/devices/revoke').csrf,CSRF);
  state.devices[1]={...state.devices[1],online:true};emit('devices');
  await row('dev-b').getByText('在线 · v0.7.0').waitFor();
  // The legacy ?link= flow still works for old collectors.
  await page.goto(origin+'/account?lang=zh&link='+'x'.repeat(43));await page.locator('[data-claim]').click();
  await page.waitForURL(u=>!u.search.includes('link='));assert.deepEqual(lastCall('/account/link').body,{code:'x'.repeat(43)});

  // Watch page sweep panel.
  reset({hasPassword:!mobile});
  await page.goto(origin+'/watch?lang=zh');const panel=page.locator('[data-sweep-panel]');await panel.waitFor();
  await waitFor(()=>accountStreams.size===1,'watch page shares one account event stream');
  assert.equal(await panel.getAttribute('data-sweep-state'),'idle');
  assert.equal(await page.locator('[data-sweep-summary]').innerText(),'2 组已选');
  assert.equal(await page.locator('[data-card="2000000"] .wg-rule input[type=checkbox]').count(),2,'signed-in web shows the per-group sweep box');
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-idle-${tag}.png`)});
  await page.locator('[data-sweep-start]').click();
  const dialog=page.locator('.sweep-dialog');await dialog.waitFor();
  const choice=id=>dialog.locator(`[data-sweep-choice="${id}"]`);
  assert.equal(await choice('dev-a').locator('input').isChecked(),true,'available devices start ticked');
  for(const [id,why] of [['dev-b','离线'],['dev-c','未允许网页启动'],['dev-d','此电脑尚未安装购买执行器']]){
   assert.equal(await choice(id).locator('input').isDisabled(),true);assert.equal(await choice(id).locator('[data-sweep-blocker]').innerText(),why);
  }
  assert.equal(await dialog.locator('[name=minutes]').inputValue(),'120');
  assert.equal(await dialog.locator('[data-sweep-submit]').isDisabled(),true,'no budget, no start');
  await dialog.locator('[name=budget]').fill('5000000');
  const fonts=await dialog.locator('input:not([type=checkbox])').evaluateAll(els=>els.map(e=>parseFloat(getComputedStyle(e).fontSize)));
  assert(fonts.every(size=>size>=16),'editable dialog controls are at least 16px');
  if(mobile){
   assert.equal(await dialog.locator('[name=current_password]').count(),0,'Google-only accounts have no password field');
   await page.screenshot({path:path.join(shots,`sweep-start-${tag}.png`)});
   await dialog.locator('[data-sweep-submit]').click();
   await dialog.locator('[data-sweep-error]').filter({hasText:'请重新登录后再继续'}).waitFor();
   assert.equal(await dialog.getByRole('link',{name:'重新登录'}).getAttribute('href'),'/auth/google/start');
  }else{
   await dialog.locator('[name=current_password]').fill('wrong password');await dialog.locator('[data-sweep-submit]').click();
   await dialog.locator('[data-sweep-error]').filter({hasText:'当前密码不正确'}).waitFor();
   await dialog.locator('[name=current_password]').fill(PASSWORD);
   await page.screenshot({path:path.join(shots,`sweep-start-${tag}.png`)});
  }
  await dialog.locator('[data-sweep-submit]').click();await dialog.waitFor({state:'detached'});
  assert.deepEqual(lastCall('/sweep/start').body,{devices:['dev-a'],budget:5000000,minutes:120,current_password:mobile?'':PASSWORD});
  assert.equal(lastCall('/sweep/start').csrf,CSRF);
  // Running: totals, end time, devices and the latest 20 purchases with labels.
  await page.locator('[data-sweep-stat=spent]').waitFor();
  assert.equal(await panel.getAttribute('data-sweep-state'),'running');
  const stat=key=>page.locator(`[data-sweep-stat=${key}] b`).innerText();
  assert.deepEqual([await stat('spent'),await stat('reserved'),await stat('unknown'),await stat('remaining')],['1.2M','300K','50K','3.5M']);
  assert.match(await stat('ends'),/^\d{1,2}(\/\d{1,2} )?\d{2}:\d{2}$|^\d{2}:\d{2}$/);
  assert.match(await page.locator('[data-sweep-device="dev-a"]').innerText(),/书房电脑[\s\S]*扫货中 · 正在扫 3 洞[\s\S]*1\.2M[\s\S]*在线/);
  assert.equal(await page.locator('[data-purchase]').count(),5,'purchases fold to five');
  await page.locator('[data-sweep-more]').click();assert.equal(await page.locator('[data-purchase]').count(),20,'at most the latest 20 purchases');
  const label=id=>page.locator(`[data-purchase="${id}"] [data-purchase-label]`).innerText();
  assert.deepEqual([await label('p0'),await label('p1'),await label('p2'),await label('p3'),await label('p4')],['已买','未买 · 已售完','处理中','结果未知，请到游戏里核对','结果未知，请到游戏里核对']);
  assert.match(await page.locator('[data-purchase="p0"]').innerText(),/红药水[\s\S]*2 件 · @50 · FM 3 · CH 12 · 店主0[\s\S]*100/);
  assert.match(await page.locator('[data-purchase="p2"]').innerText(),/海星镖[\s\S]*1 组 · 500 件/,'items outside the watch list are named from the catalogue');
  // A `sweep` event refetches: rules changed on another device.
  const fetches=calls.filter(c=>c.path==='/api/v1/account/sweep').length;
  state.run={...state.run,spent:2000000,plan_stale:true};emit('sweep');
  await page.locator('[data-sweep-stale]').waitFor();assert.equal(await stat('spent'),'2M');
  assert.equal(calls.filter(c=>c.path==='/api/v1/account/sweep').length,fetches+1,'one event, one refetch');
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-running-${tag}.png`),fullPage:true});
  await page.locator('[data-sweep-apply]').click();
  const apply=page.locator('.sweep-dialog');await apply.waitFor();
  if(!mobile)await apply.locator('[name=current_password]').fill(PASSWORD);
  await apply.locator('[data-sweep-submit]').click();await apply.waitFor({state:'detached'});
  assert.deepEqual(lastCall('/sweep/apply').body,{run:'run-1',current_password:mobile?'':PASSWORD});
  await page.locator('[data-sweep-stale]').waitFor({state:'detached'});
  // Stop needs no password; the stopped run stays as a summary.
  await page.locator('[data-sweep-stop]').click();
  await page.locator('[data-sweep-summary]').filter({hasText:'已结束 · 已停止'}).waitFor();
  assert.deepEqual(lastCall('/sweep/stop').body,{run:'run-1'});
  assert.equal(await page.locator('[data-sweep-start]').isVisible(),true);
  state.run={...state.run,status:'finished',stop_reason:'time_up'};emit('sweep');
  await page.locator('[data-sweep-summary]').filter({hasText:'已结束 · 时间到'}).waitFor();
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-finished-${tag}.png`)});
  state.run={...state.run,stop_reason:'budget_spent'};emit('sweep');
  await page.locator('[data-sweep-summary]').filter({hasText:'预算用完'}).waitFor();
  // Signing out closes the account stream.
  await page.goto(origin+'/account?lang=zh');await page.locator('[data-logout]').click();await page.locator('[data-auth]').waitFor();
  await waitFor(()=>accountStreams.size===0,'sign-out closes the account event stream');
  await page.goto(origin+'/watch?lang=zh');await page.locator('.watch-page').waitFor();
  assert.equal(await page.locator('[data-sweep-panel]').count(),0,'guests have no sweep panel');
  assert.deepEqual(errors,[]);await context.close();
  console.log(`PASS ${tag}: device page, my devices, sweep panel`);
 }
 // The collector's embedded page edits rules but never shows the panel.
 reset({mode:'collector'});
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/watch?lang=zh');await page.locator('[data-card="2000000"]').waitFor();
 await waitFor(()=>accountStreams.size===1,'the embedded page also listens for account events');
 assert.equal(await page.locator('[data-sweep-panel]').count(),0,'collector mode hides the panel');
 assert.equal(await page.locator('[data-card="2000000"] .wg-rule input[type=checkbox]').count(),2);
 assert.deepEqual(errors,[]);await page.close();
 console.log('PASS collector mode hides the sweep panel');
}finally{await browser?.close();for(const s of [...accountStreams,...marketStreams])s.end();server.closeAllConnections();await new Promise(r=>server.close(r));}
