import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../desktop_ui/', import.meta.url));
const out = process.env.DESKTOP_SCREENSHOTS;
const server = createServer(async (req,res) => { try { const p = new URL(req.url,'http://localhost').pathname; const file=path.join(root,p==='/'?'index.html':p); const raw=await readFile(file); res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(raw); } catch {res.writeHead(404).end();} });
await new Promise(r => server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
const activities=n=>Array.from({length:n},(_,i)=>({at:Date.now()/1000-i*60,text:i===1?'买到 红色药水 ×100 @41 · 3 洞 12 频道 COSTCO':`正在扫描 8 洞 · ${12-i%12}频道`,kind:i===1?'sweep':'info'}));
try {
  // The window opens at 880x740 (its minimum) and can be maximized; the delayed bridge case starts dark.
  for (const [label,width,height,theme] of [['light',880,740,'light'],['dark',1100,860,'dark']]) {
    const page=await browser.newPage({viewport:{width,height}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({theme, delayed})=>{
      window.calls=[];
      window.state={version:'0.6.4',phase:'idle',mode:'scan',message:'准备就绪，选择游戏后即可开始。',room:null,channel:null,visited:0,uploaded:0,run_shops:0,run_items:0,run_started_at:Date.now()/1000-11958,started_at:null,stopped_at:null,capture:'connected',upload:'ready',last_shop_at:null,updates:'up_to_date',selected:12,windows:[{id:12,title:'MapleStory',pid:42},{id:13,title:'MapleStory',pid:43}],theme,activities:[{at:Date.now()/1000,text:'扫描器已就绪。',kind:'info'}],maximized:false};
      const cycle={light:'dark',dark:'system',system:'light'};
      window.pywebview={api:{ready:async()=>{window.calls.push('ready');return structuredClone(window.state);},command:async(name,value)=>{window.calls.push(value===undefined?name:name+':'+(typeof value==='object'?JSON.stringify(value):value));if(name==='window'&&value==='maximize')window.state.maximized=!window.state.maximized; if(name==='theme'){if(value!==cycle[window.state.theme])throw new Error('theme skipped');window.state.theme=value;}if(name==='mode')window.state.mode=value;if(name==='start')Object.assign(window.state,{phase:'scanning',desired:true,selected:value,room:8,channel:12,visited:3,started_at:Date.now()/1000,message:'正在扫描 8 洞 · 12频道'});if(name==='pause')window.state.phase='paused';if(name==='resume')window.state.phase='scanning';if(name==='stop')Object.assign(window.state,{phase:'stopped',desired:false});return structuredClone(window.state);},workspace:async()=>({linked:false,account:null,device:null,sweep:null})}};
      if(delayed){const api=window.pywebview.api;window.pywebview.api={};window.finishBridge=()=>{window.pywebview.api=api;window.dispatchEvent(new Event('pywebviewready'));};}
    },{theme,delayed:label==='dark'});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const start=page.getByRole('button',{name:'开始扫描',exact:true});await start.waitFor();
    if(label==='dark'){assert(await start.isDisabled());await page.evaluate(()=>window.finishBridge());}
    // One header row: brand, five tabs, a single theme button and the window buttons.
    const tabs=page.getByRole('navigation',{name:'功能'});
    assert.deepEqual(await tabs.getByRole('button').allInnerTexts(),['扫描采集','关注','价格表','扫货','账号']);
    assert.equal(await page.locator('.desktop-tabs,.theme-switch,.page-heading').count(),0,'old second tab row, theme switch and slogan are gone');
    const header=await page.locator('header').boundingBox();assert.equal(header.height,56);
    assert((await tabs.boundingBox()).y<header.y+header.height,'tabs sit in the header');
    await page.getByRole('button',{name:'最小化',exact:true}).click();
    await page.getByRole('button',{name:'最大化',exact:true}).click();
    await page.getByRole('button',{name:'还原',exact:true}).click();
    await page.getByRole('button',{name:'最大化',exact:true}).waitFor();
    await page.locator('#game-window').selectOption('13');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('scanner-state',{detail:{...window.state,uploaded:18}})));
    assert.equal(await page.locator('#game-window').inputValue(),'13','updates preserve game selection');
    await start.click();
    // Scanning collapses the panel to one row with pause and stop.
    const running=page.locator('[data-scan-running]');await running.waitFor();
    assert.match(await running.innerText(),/MapleStory[\s\S]*自动扫描 · 待传 0/);
    assert.equal(await page.locator('#game-window').count(),0,'window picker hidden while scanning');
    await page.getByRole('button',{name:'暂停',exact:true}).click();
    await page.getByRole('button',{name:'继续',exact:true}).click();
    await page.evaluate(n=>window.dispatchEvent(new CustomEvent('scanner-state',{detail:{...window.state,uploaded:153,visited:17,run_shops:1286,run_items:18420,pending_uploads:2,last_progress_at:Date.now()/1000-5,activities:n}})),activities(30));
    await page.getByLabel('采集',{exact:true}).getByText('1,286',{exact:false}).waitFor();
    assert.match(await running.innerText(),/待传 2 · 最近进展 \d+ 秒前/);
    assert.equal(await page.locator('.metrics>div').count(),3);
    assert.equal(await page.locator('.scan-panel .phase').innerText(),'扫描中 · 8 洞 · 12 频道');
    assert.equal(await page.locator('.metrics>div').nth(1).locator('strong').innerText(),'18,420件');
    // The activity panel shows every entry, fills the rest of the window and scrolls.
    const list=page.locator('.activity-list');
    assert.equal(await list.locator('.activity').count(),30);
    assert.equal(await list.locator('.activity.sweep').count(),1,'purchases have their own marker');
    assert(await list.evaluate(e=>e.scrollHeight>e.clientHeight),'long activity list scrolls');
    const panel=await page.locator('.activity-panel').boundingBox(),main=await page.locator('main').boundingBox();
    assert(Math.abs(panel.y+panel.height-(main.y+main.height-12))<=2,'activity panel reaches the bottom of the page area');
    await page.evaluate(()=>Object.assign(window.state,{run_shops:1286,run_items:18420}));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal clipping');
    assert(await page.evaluate(()=>{const m=document.querySelector('main');return m.scrollHeight<=m.clientHeight+1;}),'the page itself does not scroll');
    assert(await page.evaluate(()=>document.querySelector('footer').getBoundingClientRect().bottom<=innerHeight),'footer remains visible');
    if(out){await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,`scanner-${label}.png`)});}
    for (const phase of ['recovering_network','waiting_task','waiting_game','rebuilding','needs_attention']) {
      await page.evaluate(phase=>window.dispatchEvent(new CustomEvent('scanner-state',{detail:{...window.state,phase,desired:true,message:'等待恢复测试',pending_uploads:42,retries:3,next_retry_at:Date.now()/1000+30}})),phase);
      await page.locator('.recovery-status').getByText('等待恢复测试',{exact:false}).waitFor();
      assert(await page.getByRole('button',{name:'停止',exact:true}).isEnabled(),'Stop remains available during '+phase);
      assert(await page.getByRole('button',{name:'暂停',exact:true}).isDisabled(),'recovery cannot pause stale input');
    }
    await page.getByRole('button',{name:'停止',exact:true}).click();
    await start.waitFor();
    assert.equal(await page.locator('.scan-panel .phase').innerText(),'已停止 · 手动采集中');
    assert.equal(await page.locator('.metrics>div').first().locator('strong').innerText(),'1,286家');
    await tabs.getByRole('button',{name:'账号',exact:true}).click();
    await page.getByRole('heading',{name:'登录枫叶市集',exact:true}).waitFor();
    await tabs.getByRole('button',{name:'扫描采集',exact:true}).click();
    await page.getByRole('button',{name:'手动逛摊',exact:true}).click();
    await page.getByText('按你的节奏逛摊').waitFor();
    // One theme button cycles light → dark → system.
    const first=theme==='light'?['浅色','dark','深色']:['深色','system','跟随系统'];
    await page.getByRole('button',{name:'主题：'+first[0],exact:true}).click();
    await page.getByRole('button',{name:'主题：'+first[2],exact:true}).waitFor();
    if(theme==='light')assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    assert(await page.evaluate(t=>window.calls.includes('theme:'+t),first[1]));
    assert.equal(await page.evaluate(()=>window.calls.filter(x=>x==='ready').length),1,'no polling');
    assert(await page.evaluate(()=>['window:minimize','window:maximize'].every(c=>window.calls.includes(c))));
    // The corner grip resizes the frameless window; it is hidden while maximized.
    if(await page.evaluate(()=>window.state.maximized)){await page.getByRole('button',{name:'还原'}).click();}
    const grip=page.locator('.resize-grip');await grip.waitFor();const box=await grip.boundingBox();
    await page.mouse.move(box.x+7,box.y+7);await page.mouse.down();await page.mouse.move(box.x+107,box.y+57,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>window.calls.some(c=>c.startsWith('window:{"resize":')));
    const size=await page.evaluate(()=>[innerWidth+100,innerHeight+50]);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.startsWith('window:{"resize":')).at(-1)),`window:{"resize":[${size}]}`);
    await page.getByRole('button',{name:'最大化'}).click();await grip.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);console.log('PASS desktop',label,'merged header, theme cycle, maximize, compact running row, full-height activity');await page.close();
  }
} finally {await browser.close();server.closeAllConnections();server.close();}
