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
try {
  for (const [label,width,theme] of [['light',864,'light'],['dark',864,'dark'],['compact',640,'dark']]) {
    const page=await browser.newPage({viewport:{width,height:701}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({theme, delayed})=>{
      window.calls=[];
      window.state={version:'0.6.4',phase:'idle',mode:'scan',message:'准备就绪，选择游戏后即可开始。',room:null,channel:null,visited:0,uploaded:0,run_shops:0,run_items:0,run_started_at:Date.now()/1000-11958,started_at:null,stopped_at:null,capture:'connected',upload:'ready',last_shop_at:null,updates:'up_to_date',selected:12,windows:[{id:12,title:'MapleStory',pid:42},{id:13,title:'MapleStory',pid:43}],theme,activities:[{at:Date.now()/1000,text:'扫描器已就绪。',kind:'info'}]};
      window.pywebview={api:{ready:async()=>{window.calls.push('ready');return structuredClone(window.state);},command:async(name,value)=>{window.calls.push(name);if(name==='window'&&value==='maximize')window.state.maximized=!window.state.maximized; if(name==='theme')window.state.theme=value;if(name==='mode')window.state.mode=value;if(name==='start')Object.assign(window.state,{phase:'scanning',selected:value,room:8,channel:12,visited:3,started_at:Date.now()/1000,message:'正在扫描 8 洞 · CH 12'});if(name==='pause')window.state.phase='paused';if(name==='resume')window.state.phase='scanning';if(name==='stop')window.state.phase='stopped';return structuredClone(window.state);}}};
      if(delayed){const api=window.pywebview.api;window.pywebview.api={};window.finishBridge=()=>{window.pywebview.api=api;window.dispatchEvent(new Event('pywebviewready'));};}
    },{theme,delayed:label==='compact'});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button',{name:'开始扫描',exact:true}).waitFor();
    if(label==='compact'){assert(await page.getByRole('button',{name:'开始扫描',exact:true}).isDisabled());await page.evaluate(()=>window.finishBridge());}
    await page.getByRole('button',{name:'最小化',exact:true}).click();
    await page.locator('#game-window').selectOption('13');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('scanner-state',{detail:{...window.state,uploaded:18}})));
    assert.equal(await page.locator('#game-window').inputValue(),'13','updates preserve game selection');
    await page.getByRole('button',{name:'开始扫描',exact:true}).click();
    await page.getByRole('button',{name:'暂停扫描',exact:true}).click();
    await page.getByRole('button',{name:'继续扫描',exact:true}).click();
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('scanner-state',{detail:{...window.state,uploaded:153,visited:17,run_shops:1286,run_items:18420,activities:[{at:Date.now()/1000,text:'正在扫描 8 洞 · CH 12',kind:'info'},{at:Date.now()/1000-30,text:'已领到 8 洞；当前 2 人协同扫描。',kind:'info'}]}})));
    await page.getByLabel('本次运行',{exact:true}).getByText('1,286',{exact:false}).waitFor();
    assert.equal(await page.locator('.metrics>div').count(),3);
    assert.equal(await page.locator('.upload-panel,.status-line').count(),0);
    assert.equal(await page.locator('.progress-panel .phase').innerText(),'扫描中 · 8 洞 · CH 12');
    assert.equal(await page.locator('.metrics>div').nth(1).locator('strong').innerText(),'18,420件');
    await page.evaluate(()=>Object.assign(window.state,{run_shops:1286,run_items:18420}));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal clipping');
    assert(await page.evaluate(()=>{const m=document.querySelector('main');return m.scrollHeight===m.clientHeight;}),'normal window has no vertical scrollbar');
    assert(await page.evaluate(()=>document.querySelector('footer').getBoundingClientRect().bottom<=innerHeight),'footer remains visible');
    if(out){await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,`scanner-${label}.png`),fullPage:true});}
    await page.getByRole('button',{name:'停止',exact:true}).click();
    assert.equal(await page.locator('.progress-panel .phase').innerText(),'已停止 · 手动采集中');
    assert.equal(await page.locator('.metrics>div').first().locator('strong').innerText(),'1,286家');
    await page.getByRole('button',{name:'账号与提醒',exact:true}).click();
    assert((await page.evaluate(()=>window.calls)).includes('account'));
    await page.getByRole('button',{name:'手动逛摊',exact:true}).click();
    await page.getByText('按你的节奏逛摊').waitFor();
    await page.getByRole('button',{name:'深色主题',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    assert.equal(await page.evaluate(()=>window.calls.filter(x=>x==='ready').length),1,'no polling');
    assert.deepEqual(errors,[]);console.log('PASS desktop',label,'bridge controls, pushed updates, themes, responsive layout');await page.close();
  }
} finally {await browser.close();server.closeAllConnections();server.close();}
