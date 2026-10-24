// Isolated fixture: exercises the shipped account UI without real Google accounts.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.resolve(process.env.ACCOUNT_SCREENSHOT_DIR||path.join(root,'../market_data/account-redesign'));await mkdir(output,{recursive:true});
let profile={},saves=[],claims=0,lastPeriod='',failure=false,dataFailure=false;
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const streams=new Set();
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(url.pathname==='/api/v1/account/data')return json(res,{records:[]},dataFailure?503:200);
 if(req.method==='POST'){
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.headers['x-csrf-token']!=='fixture-csrf')return json(res,{error:'invalid_request'},403);
  if(url.pathname==='/api/v1/account/logout')profile={signed_in:false,google_enabled:true};
  else if(url.pathname==='/api/v1/account/link'){claims++;profile.collectors=1;}
  else {const data=JSON.parse(raw);saves.push(data);if(failure)return json(res,{error:'invalid_nickname'},400);profile={...profile,...data};}
  return json(res,{ok:true});
 }
 if(url.pathname==='/api/v1/account')return json(res,profile);
 if(url.pathname==='/api/v1/contributors'){lastPeriod=url.searchParams.get('period');return json(res,{contributors:lastPeriod==='month'?[]:[{nickname:'枫叶探路者 / Finder',shops:132,quotes:804,days:7},{nickname:'Second',shops:88,quotes:260,days:3}]});}
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
  const page=await browser.newPage({viewport:mobile?{width:375,height:812}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const lang=mobile?'zh':'en';
  profile={signed_in:false,google_enabled:true};
  await page.goto(origin+'/account?lang='+lang);await page.locator('.google-signin').waitFor();
  const shellStylesheet=(await readFile(path.join(root,'index.html'),'utf8')).match(/href="(\/web\/css\/base\.css[^"\s]*)"/)[1];
  assert.equal(await page.locator('link[href*="/web/css/base.css"]').getAttribute('href'),shellStylesheet,'quick search must keep the current shell stylesheet');
  assert.equal(await page.locator('.google-signin').getAttribute('href'),'/auth/google/start');
  assert.equal(await page.locator('.account-link:visible').getAttribute('aria-label'),mobile?'登录账号':'Sign in to your account');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'login layout overflows');
  await page.screenshot({path:path.join(output,`account-signin-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  profile={mode:'collector',signed_in:true,nickname:'Old',listed:false,csrf:'fixture-csrf',stats:{shops:10,quotes:24},google_enabled:true};
  await page.reload();await page.locator('[data-edit-profile]').click();await page.locator('[name=nickname]').waitFor();
  if(mobile){
   for(const width of [320,375,402,430]){
    await page.setViewportSize({width,height:812});
    await page.evaluate(()=>{const fresh=document.querySelector('.ptop .fresh');fresh.hidden=false;fresh.querySelector('span').textContent='数据 36分钟前更新';});
    const controls=await page.locator('.ptop .prefs .iconbtn').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return{right:r.right,width:r.width,height:r.height,top:r.top,text:el.textContent,label:el.getAttribute('aria-label'),title:el.title,icon:!!el.querySelector('.pref-glyph'),viewport:innerWidth};}));
    assert.equal(controls.length,3);
    for(const bounds of controls){assert.equal(bounds.width,36);assert.equal(bounds.height,36);assert.equal(bounds.text,'');assert(bounds.label&&bounds.title&&bounds.icon);assert.equal(bounds.top,controls[0].top);assert(bounds.right<=bounds.viewport);}
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`header overflow at ${width}`);
   }
   await page.setViewportSize({width:375,height:812});
  }
  await page.locator('[name=nickname]').fill('枫叶玩家');await page.locator('[name=listed]').check();
  await page.locator('form[data-profile] button').click();await page.waitForFunction(()=>document.querySelector('.account-status').textContent.includes('Saved')||document.querySelector('.account-status').textContent.includes('已保存'));
  assert.deepEqual(saves.at(-1),{nickname:'枫叶玩家',listed:true});
  failure=true;await page.locator('[name=nickname]').fill('<bad>');await page.locator('form[data-profile] button').click();await page.waitForFunction(()=>document.querySelector('.account-status').textContent.includes('24'));failure=false;
  await page.locator('[name=nickname]').fill('枫叶玩家');await page.locator('[name=listed]').uncheck();await page.locator('form[data-profile] button').click();await page.waitForFunction(()=>!document.querySelector('form[data-profile] button').disabled);assert.equal(saves.at(-1).listed,false);
  await page.screenshot({path:path.join(output,`contributor-profile-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  profile={...profile,mode:undefined,public_id:'fixture-user',nickname:'朝气蓬勃的冰独眼兽',temporary:true,google_linked:true,collectors:0};
  await page.goto(origin+'/account?lang='+lang);await page.locator('[data-sync-status][data-state=synced]').waitFor();
  assert.equal(await page.locator('[data-edit-profile]').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.account-setting[open]').count(),0,'routine settings start folded');
  assert.equal(await page.locator('[name=nickname]').isVisible(),false);
  assert.match(await page.locator('.account-name h2').textContent(),/朝气蓬勃/);
  if(mobile){
   for(const width of [320,375,402,430]){
    await page.setViewportSize({width,height:812});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`profile overflow at ${width}`);
    assert(await page.locator('.account-footer').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.dock').getBoundingClientRect().top),'the compact overview fits above mobile navigation');
   }
   await page.setViewportSize({width:390,height:844});
  }
  await page.screenshot({path:path.join(output,`account-overview-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  await page.locator('[data-theme-toggle]:visible').click();
  await page.screenshot({path:path.join(output,`account-overview-${mobile?'mobile':'desktop'}-dark.png`),fullPage:true});
  await page.locator('[data-theme-toggle]:visible').click();
  await page.locator('[data-edit-profile]').click();await page.locator('[name=nickname]').fill('Unsaved');await page.locator('[name=listed]').check();
  await page.locator('[data-edit-profile]').click();await page.locator('[data-edit-profile]').click();
  assert.equal(await page.locator('[name=nickname]').inputValue(),profile.nickname,'closing the editor discards the draft');
  assert.equal(await page.locator('[name=listed]').isChecked(),false);
  assert.equal(await page.locator('[name=nickname]').evaluate(el=>getComputedStyle(el).fontSize),'16px');
  await page.screenshot({path:path.join(output,`account-edit-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  await page.locator('[data-edit-profile]').click();
  await page.locator('[data-setting=security]>summary').click();
  await page.locator('[data-setting=security] details>summary').click();
  await page.locator('[data-password] input[name=username]').fill('maple_user');
  assert.equal(await page.locator('[data-password] input[name=password]').isVisible(),true,'password setup remains reachable');
  await page.locator('[data-setting=security]>summary').click();
  dataFailure=true;await page.reload();await page.locator('[data-sync-status][data-state=offline]').waitFor();
  assert.equal(await page.locator('[data-setting=sync]').getAttribute('open'),'','sync failures expand their recovery controls');
  dataFailure=false;await page.locator('[data-sync-now]').click();await page.locator('[data-sync-status][data-state=synced]').waitFor();
  const before=claims;
  await page.goto(origin+'/account?link='+'x'.repeat(43)+'&lang='+lang);await page.locator('[data-claim]').click();await page.locator('[data-claim]').waitFor({state:'detached'});assert.equal(claims,before+1);assert(!page.url().includes('link='));
  await page.locator('[data-logout]').click();await page.locator('.google-signin').waitFor();assert.equal(await page.locator('.account-link:visible').getAttribute('aria-label'),mobile?'登录账号':'Sign in to your account');
  await page.goto(origin+'/contributors?lang='+lang);await page.locator('.board-row').first().waitFor();assert.equal(lastPeriod,'week');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'leaderboard overflows');
  await page.screenshot({path:path.join(output,`contributors-${mobile?'mobile':'desktop'}.png`),fullPage:true});
  await page.locator('[data-board=month]').click();await page.locator('.contributor-empty').waitFor();assert.equal(lastPeriod,'month');
  await page.locator('[data-board=all]').click();await page.locator('.board-row').first().waitFor();assert.equal(lastPeriod,'all');
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${mobile?'mobile Chinese':'desktop English'}: login, profile save/error/opt-out, linking, logout, leaderboard periods`);
 }
}finally{await browser?.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
