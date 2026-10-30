import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../..',import.meta.url));
const entry=execFileSync(process.env.PYTHON||'python',['-c',
  'from pathlib import Path; from scanner_desktop import desktop_entry_url; print(desktop_entry_url(Path("desktop_ui/index.html")))'],{cwd:root,encoding:'utf8'}).trim();
let updated=false, entryRequests=0;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/blank'){res.end('blank');return;}
  if(url.pathname==='/index.html'){
    entryRequests++;
    res.setHeader('Cache-Control','public, max-age=3600');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(updated?await readFile(path.join(root,'desktop_ui/index.html')):'<main>old desktop UI</main>');return;
  }
  if(!url.pathname.startsWith('/assets/')){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');
  res.end(await readFile(path.join(root,'desktop_ui',url.pathname)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined,headless:true});
try{
  const page=await browser.newPage({viewport:{width:880,height:740}});
  await page.goto(origin+'/index.html');
  await page.evaluate(()=>localStorage.setItem('profile-marker','preserved'));
  await page.context().addCookies([{url:origin,name:'session-marker',value:'preserved'}]);
  updated=true;
  await page.goto(origin+'/blank');await page.goto(origin+'/index.html');
  assert.equal(await page.locator('main').innerText(),'old desktop UI');
  assert.equal(entryRequests,1,'unchanged URL reproduces stale cached entry');
  await page.goto(origin+'/index.html?'+entry.split('?')[1]);
  await page.locator('.app-header .app-tabs').waitFor();
  assert.equal(await page.locator('.app-header .header-tools > .icon-btn').count(),1,'new compact theme control');
  assert.equal(entryRequests,2,'versioned entry fetches current UI');
  assert.equal(await page.evaluate(()=>localStorage.getItem('profile-marker')),'preserved');
  assert((await page.context().cookies()).some(c=>c.name==='session-marker'&&c.value==='preserved'));
  console.log('PASS cached old entry bypassed; current UI rendered; profile storage/cookies preserved');
}finally{await browser.close();server.closeAllConnections();server.close();}
