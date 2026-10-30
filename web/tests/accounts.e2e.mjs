// Two isolated browser contexts exercise account UI, migration, offline
// conflicts and account isolation. Backend security has PostgreSQL API tests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.resolve(root,'../market_data/account-review');await mkdir(output,{recursive:true});
const users=new Map(),sessions=new Map(),streams=new Set();
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),sid=req.headers.cookie?.match(/test_session=([^;]+)/)?.[1],user=users.get(sessions.get(sid));
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(req.method==='POST'){
  let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);
  const action=url.pathname.replace('/api/v1/account/','');
  if(['register','login','recover'].includes(action)){
   const name=data.username.toLowerCase();let next=users.get(name);
   if(action==='register'){if(next)return json(res,{error:'username_unavailable'},409);next={signed_in:true,public_id:randomBytes(12).toString('hex'),username:name,has_password:true,google_linked:false,google_enabled:true,nickname:'枫叶玩家',listed:false,csrf:randomBytes(16).toString('hex'),stats:{},password:data.password,records:[]};users.set(name,next);}
   else if(!next||next.password!==data.password)return json(res,{error:'invalid_credentials'},401);
   const session=randomBytes(16).toString('hex');sessions.set(session,name);res.setHeader('Set-Cookie',`test_session=${session}; HttpOnly; SameSite=Lax; Path=/`);return json(res,{ok:true,...(action==='register'?{recovery_code:'r'.repeat(43)}:{})});
  }
  if(!user)return json(res,{error:'login_required'},401);
  if(req.headers['x-csrf-token']!==user.csrf)return json(res,{error:'invalid_request'},403);
  if(action==='logout'){sessions.delete(sid);res.setHeader('Set-Cookie','test_session=; Max-Age=0; Path=/');return json(res,{ok:true});}
  if(action==='data'||action==='data/import'){
   const records=structuredClone(user.records);
   for(const r of data.operations){const old=records.find(x=>x.kind===r.kind&&x.key===r.key);if(action==='data/import'&&old)continue;if(action==='data'&&(old?.version??0)!==r.version)return json(res,{error:'sync_conflict'},409);if(old){old.value=r.value;old.version++;}else records.push({...r,version:1});}
   if(records.filter(r=>r.kind==='watch'&&r.value!==null).length>100)return json(res,{error:'watch_limit'},409);user.records=records;return json(res,{records});
  }
  return json(res,{ok:true});
 }
 if(url.pathname==='/api/v1/account'){if(!user)return json(res,{signed_in:false,google_enabled:true});const {password,records,...publicProfile}=user;return json(res,publicProfile);}
 if(url.pathname==='/api/v1/account/data')return user?json(res,{records:user.records}):json(res,{error:'login_required'},401);
 if(url.pathname.startsWith('/api/'))return json(res,{});
 const file=url.pathname.startsWith('/web/')?path.resolve(root,'.'+decodeURIComponent(url.pathname.slice(4))):path.join(root,'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const errors=[];
// The app's own user-data instance (exposed under automation); importing the file would load a second copy.
const userData=page=>page.waitForFunction(()=>globalThis.cwmUserData);
const state=async page=>{await userData(page);return page.evaluate(()=>{const m=globalThis.cwmUserData;return{...m.getSyncState(),ids:JSON.parse(m.userStorage.getItem('watchlist')||'[]'),settings:JSON.parse(m.userStorage.getItem('watchlist_settings')||'{}')};});};
const refresh=page=>page.evaluate(async()=>{await globalThis.cwmUserData.refreshIdentity();});
const setCap=(page,cap)=>page.evaluate(async cap=>{const m=globalThis.cwmUserData;m.userStorage.setItem('watchlist_settings',JSON.stringify({4010001:{cap,notify:true}}));await m.flush();},cap);
const filterKey='item.offerFilters.1002000',otherFilterKey='item.offerFilters.1002001';
const getPref=async(page,key)=>{await userData(page);return page.evaluate(key=>globalThis.cwmUserData.userStorage.getItem(key),key);};
const setPref=(page,key,value)=>page.evaluate(async({key,value})=>{const m=globalThis.cwmUserData;if(value===null)m.userStorage.removeItem(key);else m.userStorage.setItem(key,value);await m.flush();},{key,value});
async function auth(page,name,register=false){
 await page.goto(origin+'/account?lang=zh');await page.locator('[data-auth]').waitFor();
 if(register)await page.locator('[data-auth-tab=register]').click();
 await page.locator('[data-auth] [name=username]').fill(name);await page.locator('[data-auth] [name=password]').fill('a long unique maple passphrase');
 if(register)await page.locator('[data-auth] [name=confirm_password]').fill('a long unique maple passphrase');
 await page.locator('[data-auth] button[type=submit]').click();await page.locator('[data-logout]').waitFor();
 // The page shows the account a moment before user-data.js switches storage to it.
 await page.waitForFunction(async()=>globalThis.cwmUserData.getSyncState().signed_in);
}
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
 const a=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
 await a.addInitScript(()=>{if(!localStorage.getItem('seeded')){localStorage.setItem('watchlist','[4010001]');localStorage.setItem('watchlist_settings','{"4010001":{"cap":100,"notify":true}}');localStorage.setItem('seeded','1');}});
 const pageA=await a.newPage();pageA.on('pageerror',e=>errors.push(e.message));
 await pageA.goto(origin+'/account?lang=zh');await pageA.locator('[data-auth]').waitFor();
 await setPref(pageA,filterKey,'{"hours":"1"}');
 await pageA.screenshot({path:path.join(output,'login-mobile.png'),fullPage:true});
 await auth(pageA,'maple_one',true);await pageA.locator('.recovery-code').waitFor();assert.equal(await pageA.locator('.recovery-code').textContent(),'r'.repeat(43));
 assert.deepEqual((await state(pageA)).ids,[],'registration must not silently import guest watches');
 assert.equal(await getPref(pageA,filterKey),null,'new accounts must not inherit guest filters');
 await pageA.locator('[data-import-guest]').click();await pageA.locator('[data-import-guest]').waitFor({state:'detached'});
 assert.deepEqual((await state(pageA)).ids,[4010001]);await pageA.locator('[data-dismiss-recovery]').click();
 assert.equal(await getPref(pageA,filterKey),'{"hours":"1"}','explicit guest import includes per-product filters');
 assert(await pageA.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile account overflows');
 await pageA.screenshot({path:path.join(output,'account-mobile.png'),fullPage:true});
 const b=await browser.newContext({viewport:{width:1280,height:900}}),pageB=await b.newPage();pageB.on('pageerror',e=>errors.push(e.message));
 await auth(pageB,'maple_one');assert.deepEqual((await state(pageB)).ids,[4010001]);
 assert.equal(await getPref(pageB,filterKey),'{"hours":"1"}');
 await setPref(pageA,filterKey,'{"stock":"known","stats":[{"stat":"str","min":2}]}');
 await setPref(pageA,'item.showExpired.1002000','false');
 await setPref(pageB,otherFilterKey,'{"percentile":"25"}');
 await refresh(pageA);await refresh(pageB);
 assert.equal(await getPref(pageB,'item.showExpired.1002000'),'false');
 assert.equal(await getPref(pageA,otherFilterKey),'{"percentile":"25"}');
 const savedFilters=await getPref(pageA,filterKey);
 assert.equal(await getPref(pageB,filterKey),savedFilters,'per-product filters sync across devices');
 await pageB.reload();await pageB.locator('[data-logout]').waitFor();assert.equal(await getPref(pageB,filterKey),savedFilters);
 // Independent product edits made offline merge without deleting other products.
 await pageA.route('**/api/v1/account/data',route=>route.abort());
 await setPref(pageA,filterKey,'{"hours":"6"}');
 await setPref(pageB,otherFilterKey,'{"percentile":"50"}');
 await pageA.unroute('**/api/v1/account/data');await refresh(pageA);await refresh(pageB);
 assert.equal(await getPref(pageB,filterKey),'{"hours":"6"}');
 assert.equal(await getPref(pageA,otherFilterKey),'{"percentile":"50"}');
 await setPref(pageA,filterKey,null);await refresh(pageB);
 assert.equal(await getPref(pageB,filterKey),null,'clearing one product syncs its deletion');
 assert.equal(await getPref(pageB,otherFilterKey),'{"percentile":"50"}');
 const reminder={percentile:'25',minPrice:10,stock:'known',minStock:5,equipment:'all',stats:[]};
  const group={id:'test-rule',name:'升级次数',cap:200,notify:true,buy:false,reminder:{minUpgrades:0,maxUpgrades:5}};
  await pageA.evaluate(async group=>{const m=globalThis.cwmUserData;m.userStorage.setItem('watchlist_settings',JSON.stringify({4010001:{cap:null,notify:true,buyLimit:3,groups:[group]}}));await m.flush();},group);
  await refresh(pageB);assert.deepEqual((await state(pageB)).settings[4010001].groups,[group]);assert.equal((await state(pageB)).settings[4010001].buyLimit,3);
  await pageA.evaluate(async()=>{const m=globalThis.cwmUserData;m.userStorage.setItem('watchlist_settings',JSON.stringify({4010001:{cap:null,notify:true,groups:[]}}));await m.flush();});
  await refresh(pageB);assert.deepEqual((await state(pageB)).settings[4010001].groups,[],'deleting last condition group syncs as empty, never unrestricted');
 await pageA.evaluate(async reminder=>{const m=globalThis.cwmUserData;m.userStorage.setItem('watchlist_settings',JSON.stringify({4010001:{cap:100,notify:true,reminder}}));await m.flush();},reminder);
 await refresh(pageB);assert.deepEqual((await state(pageB)).settings[4010001].reminder,reminder);
 await pageB.reload();await pageB.locator('[data-logout]').waitFor();assert.deepEqual((await state(pageB)).settings[4010001].reminder,reminder);
 await setCap(pageA,150);await refresh(pageB);assert.equal((await state(pageB)).settings[4010001].cap,150);
 // Offline edits remain queued, and a conflicting remote write is not overwritten.
 await pageA.route('**/api/v1/account/data',route=>route.abort());await setCap(pageA,200);assert.equal((await state(pageA)).pending,1);
 await setCap(pageB,300);await pageA.unroute('**/api/v1/account/data');await refresh(pageA);
 assert.equal((await state(pageA)).settings[4010001].cap,300);assert.equal((await state(pageA)).conflicts,1);
 await pageA.locator('[data-retry-conflicts]').click();await pageA.evaluate(async()=>{await globalThis.cwmUserData.flush();});await refresh(pageB);assert.equal((await state(pageB)).settings[4010001].cap,200);
 // A tombstone wins over an old offline modification.
 await pageA.route('**/api/v1/account/data',route=>route.abort());await setCap(pageA,250);
 await pageB.evaluate(async()=>{const m=globalThis.cwmUserData;m.userStorage.setItem('watchlist','[]');await m.flush();});
 await pageA.unroute('**/api/v1/account/data');await refresh(pageA);assert.deepEqual((await state(pageA)).ids,[]);
 // Theme choices sync too.
 await pageB.evaluate(async()=>{const m=globalThis.cwmUserData;m.userStorage.setItem('theme','dark');await m.flush();});await refresh(pageA);assert.equal(await pageA.locator('html').getAttribute('data-theme'),'dark');
 await pageA.locator('[data-logout]').click();await pageA.locator('[data-auth]').waitFor();assert.deepEqual((await state(pageA)).ids,[4010001],'logout restores the original guest list');
 assert.equal(await getPref(pageA,filterKey),'{"hours":"1"}','logout restores guest filters');
 await auth(pageA,'maple_two',true);assert.deepEqual((await state(pageA)).ids,[],'another account must not inherit account one data or edits');assert.equal((await state(pageA)).pending,0);assert.equal((await state(pageA)).conflicts,0);
 assert.equal(await getPref(pageA,otherFilterKey),null,'another user has independent product preferences');
 assert.equal(await getPref(pageA,'item.showExpired.1002000'),null);
 // Tabs share a browser cache but must retain independent pending item edits.
 const otherTab=await a.newPage();otherTab.on('pageerror',e=>errors.push(e.message));await otherTab.goto(origin+'/account?lang=zh');await otherTab.locator('[data-logout]').waitFor();
 await Promise.all([pageA,otherTab].map((page,i)=>page.evaluate(async id=>{const m=globalThis.cwmUserData;m.userStorage.setItem('watchlist',JSON.stringify([id]));},4010010+i)));
 await pageA.waitForTimeout(700);await refresh(pageA);await refresh(otherTab);
 assert.deepEqual((await state(pageA)).ids.slice().sort(),[4010010,4010011]);assert.deepEqual((await state(otherTab)).ids.slice().sort(),[4010010,4010011]);
 // Logging out in one tab must immediately stop the other's account queue.
 await otherTab.locator('[data-logout]').click();await otherTab.locator('[data-auth]').waitFor();await pageA.waitForFunction(async()=>!globalThis.cwmUserData.getSyncState().signed_in);
 await pageB.screenshot({path:path.join(output,'account-desktop.png'),fullPage:true});assert.deepEqual(errors,[]);
 await a.close();await b.close();console.log('PASS: registration, recovery display, guest import, two-device sync, offline queue, conflict recovery, tombstones, preferences, logout and account isolation');
}finally{await browser?.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
