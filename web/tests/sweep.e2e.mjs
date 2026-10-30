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
const groupSource=await readFile(path.join(root,'js/lib/quote-groups.js'),'utf8');
const {mergeShopOffers}=await import('data:text/javascript;base64,'+Buffer.from(groupSource).toString('base64'));
const now=()=>Date.now()/1000,iso=s=>new Date(Date.now()+s*1000).toISOString();
const PASSWORD='a long unique maple passphrase',CSRF='csrf-fixture';
const products=[
 {item_id:2000000,name_zh:'红药水',name_en:'Red Potion',category:'消耗品',typical:50},
 {item_id:1452003,name_zh:'战斗弓',name_en:'Battle Bow',category:'装备',typical:95000},
 {item_id:2070000,name_zh:'海星镖',name_en:'Subi Throwing-Stars',category:'消耗品',typical:900},
];
const group=(id,cap,notify=false)=>({id,name:'',cap,notify,buy:true,reminder:{}});
const records=[
 {kind:'watch',key:'2000000',version:1,value:{position:0,cap:null,notify:false,buyLimit:20,groups:[group('g1',60)]}},
 {kind:'watch',key:'1452003',version:1,value:{position:1,cap:null,notify:false,buyLimit:1,groups:[group('g2',80000,true)]}},
];
const device=(id,name,{online=true,allow=true,ready=true,reason='',seen=-10,version='0.7.0'}={})=>({id,name,created_at:iso(-86400),last_seen_at:iso(seen),online,client_version:version,
 state:{client_version:version,sweep:{allow_web_start:allow,recent_scan:true,max_spend:5000000,max_order:0,reserve_mesos:0,executor:{ready,reason},holdings:{observed_at:Math.floor(now()),mesos:434333,categories:[2,3,4],items:[{item_id:2000000,quantity:189},{item_id:2070000,quantity:500}]}}}});
const statuses=['bought','not_bought','held','unknown','expired'];
const purchases=Array.from({length:24},(_,i)=>({id:'p'+i,device:'dev-a',item_id:[2000000,1452003,2070000][i%3],status:statuses[i%5],quantity:i%3===2?1:2,units:i%3===2?500:2,price:i%3===1?75000:50,
 spent:statuses[i%5]==='bought'?(i%3===1?75000:100):0,reason:statuses[i%5]==='not_bought'?'sold_out':null,room:3,channel:12,owner:'店主'+i,created_at:iso(-i*30),settled_at:iso(-i*30+5)}));
let state,profile,calls,runs=0,accountStreams=new Set(),marketStreams=new Set();
function reset({signedIn=true,mode=undefined,hasPassword=true}={}){
 profile={signed_in:signedIn,google_enabled:true,...(signedIn?{public_id:'acct-1',username:hasPassword?'maple_one':null,has_password:hasPassword,google_linked:!hasPassword,nickname:'枫叶玩家',listed:false,csrf:CSRF,collectors:1,stats:{shops:3,quotes:9}}:{}),
  ...(mode?{mode,sync_scope:'watch',linked:true}:{})};
 state={run:null,devices:[device('dev-a','书房电脑'),device('dev-b','笔记本',{online:false,seen:-7200}),device('dev-c','网吧电脑',{allow:false}),device('dev-d','客厅电脑',{version:'0.6.18',ready:false,reason:'old executor text'}),device('dev-e','游戏本',{ready:false,reason:'购买功能加载失败'})],
  authorize:'ok',reauth:!hasPassword,listings:[]};
 calls=[];runs=0;
}
const newRun=input=>{const spent=Math.floor(input.budget*.24),reserved=Math.floor(input.budget*.06),unknown=Math.floor(input.budget*.01);return {id:'run-'+(++runs),status:'running',stop_reason:null,budget:input.budget,spent,reserved,unknown,remaining:input.budget-spent-reserved-unknown,
 started_at:iso(-60),ends_at:iso((input.minutes??10080)*60),stopped_at:null,started_by:'web',plan_version:1,plan_stale:false,plan:{scan:input.scan||{mode:'market'},watches:records.filter(r=>r.kind==='watch').map(r=>({item_id:Number(r.key),limit:r.value.buyLimit,groups:r.value.groups.filter(g=>g.buy)}))},bought:1234,items:[{item_id:2000000,limit:20,units:4,bought:4},{item_id:1452003,limit:1,units:0,bought:0}],
 devices:[{id:'dev-a',name:'书房电脑',state:'active',message:'正在扫 3 洞',online:true,leased:true,checked:273,progress_at:iso(-2),spent}],purchases};};
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
  if(p==='/api/v1/account/sweep/stop'){if(input.run!==state.run?.id||state.run.status!=='running')return json(res,{error:'sweep_stopped'},409);state.run={...state.run,status:'stopped',stop_reason:'stopped_on_web',stopped_at:iso(0)};return json(res,sweepBody());}
  return json(res,{ok:true});
 }
 if(p.startsWith('/api/v1/account/')&&!profile.signed_in)return json(res,{error:'login_required'},401);
 if(p==='/api/v1/account/data')return json(res,{records});
 if(p==='/api/v1/account/devices')return json(res,{devices:state.devices});
 if(p==='/api/v1/account/sweep'){calls.push({path:p});return json(res,sweepBody());}
 if(p==='/api/v1/market/selected')return json(res,{products:products.filter(x=>(url.searchParams.get('ids')||'').split(',').map(Number).includes(x.item_id)),as_of:now()});
 if(p==='/api/v1/market/period-default')return json(res,{default_hours:'all'});
 if(p==='/api/v1/watchlist/catalog')return json(res,{items:products,presets:[]});
 if(p==='/api/v1/watchlist/listings')return json(res,{listings:state.listings,grouped_listings:mergeShopOffers(state.listings),percentile_caps:{},base_stats:{},generated_at:now(),revision:1});
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
  const rows=page.locator('[data-device-row]');await rows.first().waitFor();assert.equal(await rows.count(),5);
  const row=id=>page.locator(`[data-device-row="${id}"]`);
  assert.match(await row('dev-a').innerText(),/书房电脑[\s\S]*在线 · v0\.7\.0 · 可以扫货/);
  assert.match(await row('dev-b').innerText(),/最后在线 2小时前/);
  assert.match(await row('dev-d').innerText(),/版本 0\.6\.18 过旧，请更新采集端/,'old collectors are judged by version, not by the reported reason');
  assert.match(await row('dev-e').innerText(),/购买功能加载失败/);
  await waitFor(()=>accountStreams.size===1,'account page opens one account event stream');
  assert(await noOverflow(page));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,`account-devices-${tag}.png`),fullPage:true});
  await row('dev-c').getByRole('button',{name:'退出这台设备'}).click();await row('dev-c').waitFor({state:'detached'});
  assert.deepEqual(lastCall('/devices/revoke').body,{device:'dev-c'});assert.equal(lastCall('/devices/revoke').csrf,CSRF);
  state.devices[1]={...state.devices[1],online:true};emit('devices');
  await row('dev-b').getByText('在线 · v0.7.0').waitFor();
  // The legacy ?link= flow still works for old collectors.
  await page.goto(origin+'/account?lang=zh&link='+'x'.repeat(43));await page.locator('[data-claim]').click();
  await page.waitForURL(u=>!u.search.includes('link='));assert.deepEqual(lastCall('/account/link').body,{code:'x'.repeat(43)});

  // Watch page: Items | Sweep tabs. Cards keep the per-group sweep box; limits live in the sweep tab.
  reset({hasPassword:!mobile});
  const hit=(id,item,price,stock,age,extra={})=>({id,item_id:item,unit_price:price,stock,bundle:1,observed:now()-age,shop:'店'+id,location:{channel:12,room:3},...extra});
  state.listings=[hit('l1',2000000,50,15,600),hit('l2',2000000,55,10,7200),hit('l3',2000000,58,9,30*3600),
   hit('l4',1452003,70000,1,300,{equipment:{status:'candidate',stats:[{key:'weapon_attack',value:60}]}})];
  await page.goto(origin+'/watch?lang=zh');
  const tabs=page.locator('.watch-tabs');await tabs.waitFor();
  await waitFor(()=>accountStreams.size===1,'watch page shares one account event stream');
  const tabText=async key=>(await page.locator(`[data-watch-tab=${key}]`).innerText()).replace(/\s+/g,' ').trim();
  assert.equal(await tabText('items'),'物品 2');assert.equal(await tabText('sweep'),'扫货 2 件');
  assert.equal(await page.locator('[data-watch-tab=items]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-card="2000000"] .wg-rule input[type=checkbox]').count(),2,'signed-in web shows the per-group sweep box');
  assert.equal(await page.locator('.wg-footer').count(),0,'cards no longer carry the quantity row');
  assert.equal(await page.locator('[data-sweep-panel]').count(),0,'the sweep tab renders only when chosen');
  await page.locator('[data-watch-tab=sweep]').click();
  const panel=page.locator('[data-sweep-panel]');await panel.waitFor();
  assert.equal(await page.locator('#watch-list').isVisible(),false);
  assert.equal(await panel.getAttribute('data-sweep-state'),'idle');
  assert.equal((await panel.locator('.sweep-line').first().innerText()).replace(/\s+/g,' '),'未开始 2 件物品 · 书房电脑、网吧电脑、客厅电脑、游戏本在线 开始扫货');
  const rule=id=>panel.locator(`[data-sweep-rule="${id}"]`);
  assert.match(await rule(2000000).innerText(),/红药水[\s\S]*≤ 60/);
  assert.equal(await rule(2000000).locator('[data-rule-held]').innerText(),'756','held units add up over online devices');
  assert.equal(await rule(1452003).locator('[data-rule-held]').innerText(),'—','an unread inventory tab is unknown, not zero');
  // Recent matches: within range, in stock, under the cap, cut at each item's limit.
  const hits=panel.locator('[data-sweep-hits]');
  assert.match((await hits.innerText()).replace(/\s+/g,' '),/有 2 条命中[\s\S]*合计约 70.8K[\s\S]*先买这些/);
  await hits.locator('[data-sweep-recent-range]').selectOption('360');
  assert.match(await hits.innerText(),/有 3 条命中[\s\S]*合计约 71K/,'six hours adds the second shop, cut at the 20-unit limit');
  await hits.locator('[data-sweep-recent-range]').selectOption('60');
  // Limits: number box and "no limit" box, synced to the account.
  const unlimited=page.getByLabel('红药水数量不限',{exact:true});
  await unlimited.check();
  await waitFor(()=>records[0].value.buyLimit===0,'unlimited quantity syncs to account');
  await page.reload();await unlimited.waitFor();
  assert.equal(await page.locator('[data-watch-tab=sweep]').getAttribute('aria-selected'),'true','the chosen tab survives reload');
  assert.equal(await unlimited.isChecked(),true,'unlimited survives account reload');
  assert.equal(await page.getByLabel('红药水本轮购买上限',{exact:true}).count(),0);
  await unlimited.uncheck();
  await page.getByLabel('红药水本轮购买上限',{exact:true}).fill('20');
  await waitFor(()=>records[0].value.buyLimit===20,'finite limit can be restored');
  await panel.locator('[data-sweep-edit-rules]').click();
  assert.equal(await page.locator('#watch-list').isVisible(),true,'"edit in watchlist" opens the items tab');
  await page.locator('[data-watch-tab=sweep]').click();
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-idle-${tag}.png`)});
  // Start dialog: devices, budget, duration and password only.
  await panel.locator('[data-sweep-start]').click();
  const dialog=page.locator('.sweep-start-dialog');await dialog.waitFor();
  const choice=id=>dialog.locator(`[data-sweep-choice="${id}"]`);
  assert.equal(await choice('dev-a').locator('input').isChecked(),true,'available devices start ticked');
  for(const [id,why] of [['dev-b','离线'],['dev-c','未允许网页启动'],['dev-d','版本 0.6.18 过旧，请更新采集端'],['dev-e','购买功能加载失败']]){
   assert.equal(await choice(id).locator('input').isDisabled(),true);assert.equal(await choice(id).locator('[data-sweep-blocker]').innerText(),why);
  }
  assert.equal(await dialog.locator('[data-sweep-rules],[data-sweep-holdings],[data-sweep-recent-range]').count(),0,'no repeated rules, inventory or mode');
  assert.equal(await dialog.locator('[data-sweep-duration="10080"]').getAttribute('aria-checked'),'true');
  assert.equal(await dialog.locator('[data-sweep-submit]').isDisabled(),true,'no budget, no start');
  await dialog.locator('[data-sweep-quick="1000000"]').click();
  assert.equal(await dialog.locator('[name=budget]').inputValue(),'1000000');
  await dialog.locator('[name=budget]').fill('5000000');
  await dialog.locator('[data-sweep-duration="1440"]').click();
  assert.match(await dialog.locator('[data-sweep-start-summary]').innerText(),/^红药水、战斗弓 · 预算 5M · 明天 \d\d:\d\d 结束$/);
  await dialog.locator('[data-sweep-duration="10080"]').click();
  assert.match(await dialog.locator('[data-sweep-start-summary]').innerText(),/· \d{1,2}\/\d{1,2} \d\d:\d\d 结束$/);
  const fonts=await dialog.locator('input:not([type=checkbox])').evaluateAll(els=>els.map(e=>parseFloat(getComputedStyle(e).fontSize)));
  assert(fonts.every(size=>size>=16),'editable dialog controls are at least 16px');
  if(!mobile)assert(await dialog.evaluate(d=>d.scrollHeight<=d.clientHeight),'the start dialog fits a 1280x900 window');
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
  assert.deepEqual(lastCall('/sweep/start').body,{devices:['dev-a'],budget:5000000,minutes:10080,scan:{mode:'market'},current_password:mobile?'':PASSWORD});
  assert.equal(lastCall('/sweep/start').csrf,CSRF);
  // Running: status, budget bar, devices, this run's rules and the latest five purchases.
  assert.equal(await panel.getAttribute('data-sweep-state'),'running');
  assert.equal(await tabText('sweep'),'扫货 运行中');
  assert.equal(await panel.locator('[data-sweep-summary]').innerText(),'运行中');
  assert.match(await panel.locator('[data-sweep-progress-line]').innerText(),/^已运行 1 分 · \d{1,2}\/\d{1,2} \d\d:\d\d 结束$/);
  assert.equal((await panel.locator('[data-sweep-spent]').innerText()).replace(/\s+/g,' '),'已花 1,200,000 / 5,000,000');
  assert.equal((await panel.locator('[data-sweep-remaining]').innerText()).replace(/\s+/g,' '),'剩余 3,450,000');
  assert.equal(await panel.locator('[data-sweep-run-device="dev-a"]').innerText(),'书房电脑 · 正在扫 3 洞 · 已查 273 店次');
  assert.equal(await panel.locator('[data-sweep-hits],[data-sweep-start]').count(),0);
  assert.match(await rule(2000000).innerText(),/红药水[\s\S]*4[\s\S]*20/);
  assert.equal(await rule(2000000).locator('input').count(),0,'this run\'s limits are read-only');
  state.run.items[0].bought=20;emit('sweep');
  await rule(2000000).locator('.sweep-tag').filter({hasText:'已满'}).waitFor();
  assert.match(await rule(2000000).getAttribute('class'),/full/);
  const buys=panel.locator('[data-sweep-recent-purchases] [data-purchase]');
  assert.equal(await buys.count(),5);
  assert.match(await panel.locator('[data-sweep-recent-purchases] [data-purchase="p0"]').innerText(),/红药水[\s\S]*2 件 @50 · 12频道 3洞 · 店主0[\s\S]*100/);
  assert.equal(await panel.locator('[data-purchase="p1"] [data-purchase-label]').innerText(),'未买 · 已售完 · 12频道 3洞 · 店主1');
  await panel.locator('[data-sweep-all-records]').filter({hasText:'全部 24 条'}).click();
  const details=page.locator('.sweep-details-dialog');await details.waitFor();
  const tab=name=>details.getByRole('tab',{name,exact:true}).click();
  const close=()=>details.locator('.sweep-detail-footer').getByRole('button',{name:'关闭',exact:true}).click();
  const stat=key=>details.locator(`[data-sweep-stat=${key}] b`).innerText();
  assert.equal(await details.getByRole('tab',{name:'记录',exact:true}).getAttribute('aria-selected'),'true','"all records" opens the records tab');
  assert.equal(await details.locator('[data-purchase]').count(),5);
  await details.locator('[data-sweep-more]').click();assert.equal(await details.locator('[data-purchase]').count(),24);
  const label=id=>details.locator(`[data-purchase="${id}"] [data-purchase-label]`).innerText();
  assert.deepEqual([await label('p0'),await label('p1'),await label('p2'),await label('p3'),await label('p4')],['已买','未买 · 已售完','处理中','结果未知，请到游戏里核对','结果未知，请到游戏里核对']);
  assert.match(await details.locator('[data-purchase="p0"]').innerText(),/红药水[\s\S]*2 件 @50 · 12频道 3洞 · 店主0[\s\S]*100/);
  assert.match(await details.locator('[data-purchase="p2"]').innerText(),/海星镖[\s\S]*1 组 · 500 件 @50/);
  await close();
  await panel.locator('[data-sweep-details]').click();await details.waitFor();
  assert.equal(await details.getByRole('tab',{name:'进度',exact:true}).getAttribute('aria-selected'),'true');
  assert.deepEqual([await stat('spent'),await stat('reserved'),await stat('unknown'),await stat('remaining')],['1,200,000','300,000','50,000','3,450,000']);
  assert.equal(await details.locator('[data-sweep-bought]').innerText(),'1,234','total is not inferred from the recent-record page');
  assert.equal(await details.locator('[data-sweep-checked]').innerText(),'273');
  assert.equal(await details.locator('[data-device-activity]').innerText(),'正在扫 3 洞','reported activity is not prefixed with another sweeping label');
  state.run.devices[0].message='扫货中';emit('sweep');
  await details.locator('[data-device-activity]').filter({hasText:'已加入任务'}).waitFor();
  assert(!/扫货中.*扫货中/.test(await details.innerText()));
  await tab('背包');
  assert.equal(await details.locator('[data-inventory-balance]').innerText(),'434,333');
  assert.match(await details.locator('[data-inventory-targets]').innerText(),/红药水.*189/s);
  assert.match(await details.locator('[data-inventory-targets]').innerText(),/战斗弓.*—/s,'unread equipment is unknown, not zero');
  await details.getByText('其他已读物品 · 1',{exact:true}).click();
  await details.getByText('海星镖',{exact:true}).waitFor();
  state.devices[0].state.sweep.holdings.mesos=430000;state.devices[0].state.sweep.holdings.items[0].quantity=200;emit('devices');
  await details.locator('[data-inventory-balance]').filter({hasText:'430,000'}).waitFor();
  assert.match(await details.locator('[data-inventory-targets]').innerText(),/红药水.*200/s);
  state.devices[0].online=false;state.run.devices[0].online=false;emit('devices');
  await details.locator('[data-inventory-balance]').filter({hasText:'—'}).waitFor();
  await tab('进度');await details.locator('[data-device-activity]').filter({hasText:'设备离线'}).waitFor();
  state.devices[0].online=true;state.run.devices[0].online=true;state.run.devices[0].leased=false;emit('sweep');
  await details.locator('[data-device-activity]').filter({hasText:'等待重新连接'}).waitFor();
  state.run.devices[0].leased=true;state.run.devices[0].message='正在扫 3 洞';
  await tab('设置');
  assert.match(await details.locator('[data-sweep-settings]').innerText(),/本轮预算.*5,000,000/s);
  assert.match(await stat('ends'),/^\d{1,2}(\/\d{1,2} )?\d{2}:\d{2}$|^\d{2}:\d{2}$/);
  await close();
  // Editing rules during a run shows a notice; this run keeps its snapshot.
  await page.locator('[data-watch-tab=items]').click();
  await page.locator('[data-card="1452003"] [data-watch-group]').getByRole('checkbox',{name:'扫货',exact:true}).uncheck();
  await page.locator('[data-watch-tab=sweep]').click();
  await panel.locator('[data-sweep-stale]').filter({hasText:'关注里的扫货条件已修改，下一轮生效'}).waitFor();
  assert.equal(await rule(1452003).count(),1,'this run keeps its own rules');
  await panel.locator('[data-sweep-details]').click();await tab('设置');
  assert.match(await details.locator('[data-sweep-rules]').innerText(),/最多 20/);
  await details.locator('[data-sweep-stale]').waitFor();
  // SSE refreshes data without closing the dialog or resetting the selected tab.
  const fetches=calls.filter(c=>c.path==='/api/v1/account/sweep').length;
  state.run={...state.run,spent:2000000,remaining:2650000,plan_stale:true};emit('sweep');
  await waitFor(()=>calls.filter(c=>c.path==='/api/v1/account/sweep').length===fetches+1,'one event, one fetch');
  assert.equal(await details.getByRole('tab',{name:'设置',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-sweep-apply]').count(),0);
  await tab('进度');assert.equal(await stat('spent'),'2,000,000');
  if(mobile)await page.setViewportSize({width:320,height:700});
  assert(await noOverflow(page));
  const bounds=await details.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=page.viewportSize().width+1);
  assert(await details.locator('.sweep-detail-footer').isVisible());
  const stopCalls=calls.filter(c=>c.path.endsWith('/sweep/stop')).length;
  await details.locator('[data-sweep-stop]').click();
  await details.getByRole('button',{name:'继续本轮',exact:true}).click();
  assert.equal(calls.filter(c=>c.path.endsWith('/sweep/stop')).length,stopCalls);
  await close();
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-running-${tag}.png`),fullPage:true});
  if(mobile)await page.setViewportSize({width:390,height:844});
  await page.locator('[data-watch-tab=items]').click();
  await page.locator('[data-card="1452003"] [data-watch-group]').getByRole('checkbox',{name:'扫货',exact:true}).check();
  await waitFor(()=>records[1].value.groups[0].buy===true,'sweep box restored');
  await page.locator('[data-watch-tab=sweep]').click();
  // Stop in place: Stop becomes Confirm stop / Cancel, no dialog.
  await panel.locator('[data-sweep-stop]').click();
  assert.equal(await page.locator('.sweep-dialog').count(),0,'stopping asks in place');
  await panel.locator('[data-sweep-cancel-stop]').click();
  assert.equal(calls.filter(c=>c.path.endsWith('/sweep/stop')).length,stopCalls);
  await panel.locator('[data-sweep-stop]').click();await panel.locator('[data-sweep-confirm-stop]').click();
  await panel.locator('[data-sweep-start]').waitFor();
  assert.deepEqual(lastCall('/sweep/stop').body,{run:'run-1'});
  assert.equal(await tabText('sweep'),'扫货 2 件');
  assert.match(await panel.locator('[data-sweep-last]').innerText(),/^上一轮 今天 \d\d:\d\d 结束 · 花 2,000,000 · 买到 1,234 件 · 记录$/);
  // Buy recent matches first: devices, budget (the total) and password.
  await panel.locator('[data-sweep-recent]').click();
  const recent=page.locator('.sweep-start-dialog');await recent.waitFor();
  assert.equal(await recent.locator('[data-sweep-recent-summary]').innerText(),'过去 1 小时命中 2 条，涉及红药水、战斗弓 · 买完后等新命中');
  assert.equal(await recent.locator('[name=budget]').inputValue(),'70750');
  assert.equal(await recent.locator('[data-sweep-duration]').count(),0,'no duration: the server default applies');
  state.devices[0].state.sweep.recent_scan=false;emit('devices');
  await choice('dev-a').getByText('请更新采集端').waitFor();
  assert(await recent.locator('[data-sweep-submit]').isDisabled());
  state.devices[0].state.sweep.recent_scan=true;emit('devices');
  await waitFor(async()=>!(await choice('dev-a').locator('input').isDisabled()),'new collector can run recent route');
  await choice('dev-a').locator('input').check();
  if(!mobile)await recent.locator('[name=current_password]').fill(PASSWORD);
  else state.reauth=false;
  await recent.locator('[data-sweep-submit]').click();await recent.waitFor({state:'detached'});
  assert.deepEqual(lastCall('/sweep/start').body,{devices:['dev-a'],budget:70750,scan:{mode:'recent',recent_minutes:60},current_password:mobile?'':PASSWORD});
  assert.equal(await tabText('sweep'),'扫货 买命中的');
  assert.equal(await panel.locator('[data-sweep-summary]').innerText(),'正在买命中的');
  // The heartbeat's `pending` decides the queue state; the message text is only a fallback for old collectors.
  state.run.devices[0].message='近期命中：3 洞 · 12频道';state.run.devices[0].pending=7;emit('sweep');
  await panel.locator('[data-sweep-progress-line]').filter({hasText:/^剩 7 处待回访 · 已买 1,234 件 · 已运行 1 分$/}).waitFor();
  state.run.devices[0].message='等待新的命中店铺';state.run.devices[0].pending=5;emit('sweep');
  await panel.locator('[data-sweep-progress-line]').filter({hasText:/^剩 5 处待回访/}).waitFor();
  assert.equal(await panel.locator('[data-sweep-summary]').innerText(),'正在买命中的','a structured count outranks the message text');
  state.run.devices[0].message='近期命中';state.run.devices[0].pending=0;emit('sweep');
  await panel.locator('[data-sweep-summary]').filter({hasText:'命中的都看过了'}).waitFor();
  assert.equal(await panel.locator('[data-sweep-progress-line]').innerText(),'已查 273 店次 · 买到 1,234 件 · 等新命中');
  delete state.run.devices[0].pending;state.run.devices[0].message='近期命中：3 洞 · 12频道 · 待访 2 处';emit('sweep');
  await panel.locator('[data-sweep-progress-line]').filter({hasText:/^剩 2 处待回访/}).waitFor();
  state.run.devices[0].message='等待新的命中店铺';emit('sweep');
  await panel.locator('[data-sweep-summary]').filter({hasText:'命中的都看过了'}).waitFor();
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-recent-drained-${tag}.png`)});
  // Switching to a full-market sweep stops this run and starts one with what is left.
  const left=state.run.remaining;
  await panel.locator('[data-sweep-convert]').click();
  const convert=page.locator('.sweep-start-dialog');await convert.waitFor();
  assert.equal(await convert.locator('[name=budget]').inputValue(),String(left));
  if(!mobile)await convert.locator('[name=current_password]').fill(PASSWORD);
  await convert.locator('[data-sweep-submit]').click();await convert.waitFor({state:'detached'});
  const order=calls.filter(c=>/\/sweep\/(stop|start)$/.test(c.path)).slice(-2).map(c=>c.path.split('/').pop());
  assert.deepEqual(order,['stop','start']);assert.deepEqual(lastCall('/sweep/stop').body,{run:'run-2'});
  assert.deepEqual(lastCall('/sweep/start').body.scan,{mode:'market'});assert.equal(lastCall('/sweep/start').body.budget,left);
  assert.equal(await tabText('sweep'),'扫货 运行中');
  state.run={...state.run,status:'finished',stop_reason:'time_up',stopped_at:iso(0)};emit('sweep');
  await panel.locator('[data-sweep-last]').waitFor();
  assert.equal(await panel.locator('[data-sweep-start]').isVisible(),true);
  assert(await noOverflow(page));await page.screenshot({path:path.join(shots,`sweep-finished-${tag}.png`)});
  // Signing out closes the account stream.
  await page.goto(origin+'/account?lang=zh');await page.locator('[data-logout]').click();await page.locator('[data-auth]').waitFor();
  await waitFor(()=>accountStreams.size===0,'sign-out closes the account event stream');
  await page.goto(origin+'/watch?lang=zh');await page.locator('.watch-page').waitFor();
  assert.equal(await page.locator('.watch-tabs,[data-sweep-panel]').count(),0,'guests have no sweep tab');
  assert.deepEqual(errors,[]);await context.close();
  console.log(`PASS ${tag}: device page, my devices, sweep tab`);
 }
 // The collector embeds the page (?embed=1, mode "collector"): no site chrome, and
 // the sweep tab only edits the rules. The collector has no sweep API.
 reset({mode:'collector'});
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/watch?lang=zh&theme=light&embed=1');await page.locator('[data-card="2000000"]').waitFor();
 await waitFor(()=>accountStreams.size===1,'the embedded page also listens for account events');
 assert.equal(await page.locator('.dhead,.ptop,.dock,.assistant-fab,[data-notification-state]').count(),0,'embedded pages have no site chrome or notification row');
 assert.equal(await page.locator('[data-card="2000000"] .wg-rule input[type=checkbox]').count(),2);
 await page.locator('[data-watch-tab=sweep]').click();
 const rules=page.locator('[data-sweep-panel]');await rules.waitFor();
 assert.equal(await rules.getAttribute('data-sweep-state'),'rules');
 assert.equal(await rules.locator('[data-sweep-start],[data-sweep-recent],[data-sweep-recent-purchases],[data-rule-held]').count(),0,'rules only');
 await page.getByLabel('红药水本轮购买上限',{exact:true}).fill('7');
 await waitFor(()=>records[0].value.buyLimit===7,'embedded limit edits sync');
 await page.locator('[data-watch-tab=items]').click();await page.locator('[data-watch-tab=sweep]').click();
 assert.equal(await page.getByLabel('红药水本轮购买上限',{exact:true}).inputValue(),'7');
 assert.equal(calls.filter(c=>c.path==='/api/v1/account/sweep').length,0,'collector mode never asks for the sweep run');
 assert.equal(await page.evaluate(()=>document.querySelector('main').getBoundingClientRect().top),0,'content starts at the top');
 await page.screenshot({path:path.join(shots,'sweep-embedded.png')});
 assert.deepEqual(errors,[]);await page.close();
 console.log('PASS embedded collector page: no chrome, rules-only sweep tab');
}finally{await browser?.close();for(const s of [...accountStreams,...marketStreams])s.end();server.closeAllConnections();await new Promise(r=>server.close(r));}
