import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const out=path.join(root,'market_data/desktop-workspace-review');await mkdir(out,{recursive:true});
const shots=process.env.SWEEP_SCREENSHOT_DIR||'/tmp/cwm-sweep-shots';await mkdir(shots,{recursive:true});
const products=[{item_id:1002000,name_zh:'褐色皮帽',name_en:'Brown Skullcap',typical:12000},{item_id:1452003,name_zh:'战斗弓',name_en:'Battle Bow',typical:95000},{item_id:2000000,name_zh:'红药水',name_en:'Red Potion',typical:50}];
const records=products.map((i,n)=>({kind:'watch',key:String(i.item_id),version:1,value:{position:n,cap:10000,notify:true,buyLimit:2,groups:[{id:'one',name:'低价自用',cap:10000,notify:true,buy:true,reminder:{minUpgrades:0}}]}}));
// window.pywebview.api.workspace(action, value) as specified for desktop_workspace.py.
const recent=[
 {name:'红药水',item_id:2000000,status:'bought',quantity:2,units:2,price:50,spent:100,reason:null,room:3,channel:12,owner:'店主甲',at:Date.now()/1000-60},
 {name:'战斗弓',item_id:1452003,status:'not_bought',quantity:0,units:0,price:90000,spent:0,reason:'price_changed',room:5,channel:2,owner:'店主乙',at:Date.now()/1000-120},
 {name:'褐色皮帽',item_id:1002000,status:'unknown',quantity:1,units:1,price:9000,spent:0,reason:null,room:7,channel:9,owner:'店主丙',at:Date.now()/1000-180},
];
// sweep.rules as collector_sweep.status() reports it: the account's rules while idle, the run's plan while running.
const rules={watches:products.map(p=>({item_id:p.item_id,name:p.name_zh,limit:2,groups:[{id:'one',name:'低价自用',cap:10000,notify:true,buy:true,reminder:{minUpgrades:0}}]}))};
// Equipment bag read (one cap, no bow); the use bag not read, so potions show "—" rather than 0.
const holdings={observed_at:Date.now()/1000,mesos:3243300,categories:[1],items:[{item_id:1002000,quantity:1}]};
const signedIn=()=>({linked:true,account:{id:'acct-1',nickname:'测试玩家'},device:{id:'dev-a',name:'书房电脑'},
 sweep:{settings:{allow_web_start:false,max_spend:0,max_order:0,reserve_mesos:0},executor:{ready:false,reason:'购买功能加载失败'},run:null,recent:[],message:'',rules,holdings}});
let status=signedIn();
const devices=()=>({devices:[
 {id:'dev-a',name:status.device?.name||'书房电脑',created_at:'2026-10-27T08:00:00Z',last_seen_at:new Date().toISOString(),online:true,client_version:'0.8.2',state:{sweep:{shared_sweep:true,executor:{ready:true},holdings}}},
 {id:'dev-b',name:'笔记本',created_at:'2026-09-01T08:00:00Z',last_seen_at:new Date(Date.now()-7200e3).toISOString(),online:false,client_version:'0.8.1',state:null}]});
const state={version:'0.6.15',phase:'idle',mode:'scan',message:'',capture:'connected',upload:'ready',updates:'ready',windows:[{id:1,title:'MapleStory'}],selected:1,theme:'light',activities:[],run_shops:0,run_items:0};
// The cap matches all three; only the skullcap has known upgrades, so it alone meets `minUpgrades: 0`.
const listings=products.map((p,n)=>({id:'offer-'+n,item_id:p.item_id,unit_price:1000,stock:5,bundle:1,observed:Date.now()/1000,shop:'测试店铺',location:{channel:3,room:2},
 ...(n===0?{equipment:{status:'candidate',remaining_upgrades:3,stats:[]}}:{})}));
const calls=[],streams=new Set();let origin;
const json=(res,d)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(d));};
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');let input={};if(req.method==='POST'){let b='';for await(const c of req)b+=c;input=JSON.parse(b);}
 if(u.pathname==='/test/desktop'){
  const {action,value}=input;calls.push(input);
  if(action==='ready'||action==='command')return json(res,state);
  if(action==='page')return json(res,{url:origin+'/'+value.page+'?lang=zh&theme='+value.theme+'&embed=1'});
  if(action==='devices')return json(res,devices());
  if(action==='rename')status.device={...status.device,name:value.name};
  if(action==='login')return json(res,{opened:true});
  if(action==='logout')status={linked:false,account:null,device:null,sweep:null};
  if(action==='settings')status.sweep.settings={...value};
  if(action==='start')status.sweep={...status.sweep,message:'正在扫 3 洞',recent,run:{id:'run-1',status:'running',budget:value.budget,remaining:value.budget-1100,ends_at:new Date(Date.now()+value.minutes*60000).toISOString(),started_by:'dev-a',state:'active',message:'',spent_here:100,plan_version:1,
   spent:1100,bought:2,items:[{item_id:2000000,limit:2,units:2,bought:2},{item_id:1002000,limit:2,units:0,bought:0}],started_at:null,checked:12}};
  if(action==='stop')status.sweep={...status.sweep,run:null,message:'扫货已停止'};
  return json(res,status);
 }
 if(u.pathname==='/api/v1/events'||u.pathname==='/api/v1/account/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(u.pathname==='/api/v1/events'?': ready\n\n':'event: hello\ndata: {}\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(u.pathname==='/api/v1/account')return json(res,{signed_in:true,mode:'collector',sync_scope:'watch',linked:status.linked,public_id:status.linked?'synthetic':null,nickname:'测试玩家',csrf:'fixture'});
 if(u.pathname==='/api/v1/account/data'){
  if(req.method==='POST'){
   assert.equal(input.account,'synthetic');assert.equal(req.headers['x-csrf-token'],'fixture');
   for(const op of input.operations){assert(op.kind==='watch'||op.key==='watch.sweepSettings','only watch-scoped changes leave the device');const old=records.find(r=>r.key===op.key&&r.kind===op.kind);if(old){old.value=op.value;old.version++;}else records.push({...op,version:1});}
  }
  return json(res,{records});
 }
 if(u.pathname==='/api/v1/market')return json(res,{products,as_of:Date.now()/1000,offers:listings,opportunities:[],shared:true});
 if(u.pathname==='/api/v1/market/period-default')return json(res,{default_hours:'all'});
 if(u.pathname==='/api/v1/watchlist/catalog')return json(res,{items:products,presets:[]});
 if(u.pathname==='/api/v1/watchlist/listings')return json(res,{listings,grouped_listings:listings,base_stats:{},percentile_caps:{},revision:'r1'});
 if(u.pathname==='/api/v1/collector/status')return json(res,{collector_id:'fixture',local_collector:true});
 if(u.pathname==='/api/v1/collector/watch-listings')return json(res,{listings:[],revision:'r1'});
 if(u.pathname.startsWith('/api/'))return json(res,{});
 const file=u.pathname==='/'?path.join(root,'desktop_ui/index.html'):u.pathname.startsWith('/assets/')?path.join(root,'desktop_ui',u.pathname):u.pathname.startsWith('/web/')?path.join(root,u.pathname):path.join(root,'web/index.html');
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"frame-ancestors http://127.0.0.1:*");res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined,headless:true});
try{
 const page=await browser.newPage({viewport:{width:880,height:740}}),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
 await page.addInitScript(()=>{if(location.pathname!=='/')return;const invoke=(action,value)=>fetch('/test/desktop',{method:'POST',body:JSON.stringify({action,value})}).then(r=>r.json());window.pywebview={api:{ready:()=>invoke('ready'),command:(name,value)=>invoke('command',{name,value}),workspace:invoke}};});
 console.log('opening desktop');await page.goto(origin+'/');await page.getByRole('button',{name:'开始扫描',exact:true}).waitFor();
 assert(await page.locator('.desktop-main').evaluate(e=>e.scrollHeight<=e.clientHeight+1));
 assert.equal(await page.locator('[data-sweep-status-line]').count(),0,'no status line without a sweep');
 const tabs=page.getByRole('navigation',{name:'功能'});
 assert.equal(await tabs.getByRole('button',{name:'扫货模拟'}).count(),0,'the simulation tab is renamed');
 await tabs.getByRole('button',{name:'关注',exact:true}).click();
 const watch=page.frameLocator('iframe[title="关注整页"]');
 assert.match(await page.locator('iframe[title="关注整页"]').getAttribute('src'),/[?&]embed=1(&|$)/,'whole pages open in embed mode');
 console.log('waiting website watch');await watch.locator('.watch-page [data-card="1002000"]').waitFor();console.log('watch loaded');
 assert.equal(await watch.locator('.watch-page [data-card]').count(),3,'shared account watches loaded by the entire website page');
 assert.equal(await watch.locator('[data-sweep-panel]').count(),0,'the embedded page has no web sweep panel');
 // The embedded page reports its hits to the collector window; the badge stays while another tab is shown.
 await page.locator('[data-watch-hits]').filter({hasText:/^1$/}).waitFor();
 assert.match(await watch.locator('[data-meta]').first().innerText(),/1 件有符合条件的在售/);
 assert.equal(await tabs.getByRole('button',{name:'关注，1 件有符合条件的在售'}).count(),1);
 const card=watch.locator('[data-card="1002000"]');
 await card.getByRole('button',{name:'编辑',exact:true}).click();
 await card.locator('[data-reminder-advanced]').click();
 const dialog=watch.locator('#offer-filter-dialog:visible');
 assert.equal(await dialog.locator('[name=minUpgrades]').inputValue(),'0');
 await dialog.locator('[name=maxUpgrades]').fill('5');await dialog.locator('[data-offer-apply]').click();
 await page.waitForTimeout(700);assert.equal(records[0].value.groups[0].reminder.maxUpgrades,5);
 await card.getByRole('button',{name:/删除条件组/}).click();await card.getByRole('button',{name:'撤销',exact:true}).click();
 await page.waitForTimeout(700);assert.equal(records[0].value.groups.length,1);
 assert.equal(await page.locator('.native-rule-editor').count(),0,'bespoke desktop rules UI is removed');
 await watch.locator('html').evaluate(()=>scrollTo(0,0));assert((await page.locator('iframe').boundingBox()).height>500,'whole page fills the window');await page.screenshot({path:path.join(out,'website-watch-light.png')});
 await watch.locator('html').evaluate(e=>e.dataset.theme='dark');await page.locator('html').evaluate(e=>e.dataset.theme='dark');
 await page.screenshot({path:path.join(out,'website-watch-dark.png')});
 await watch.locator('html').evaluate(e=>e.dataset.theme='light');await page.locator('html').evaluate(e=>e.dataset.theme='light');
 await tabs.getByRole('button',{name:'价格表',exact:true}).click();
 const prices=page.frameLocator('iframe[title="价格表整页"]');
 await prices.locator('[data-item-row]:visible').first().waitFor();
 assert(await prices.locator('[data-item-row]').count()>=3,'entire price page renders its data rows');
 await page.screenshot({path:path.join(out,'website-prices.png')});

 const text=async locator=>(await locator.innerText()).replace(/\s+/g,' ').trim();
 // Sweep tab: status cells, local start with quick budgets and durations, read-only rules, folded settings.
 await tabs.getByRole('button',{name:'扫货',exact:true}).click();
 const executor=page.locator('[data-executor]');await executor.waitFor();
 assert.equal(await text(executor),'购买功能加载失败');
 assert.equal(await page.getByText(/尚未安装|执行器/).count(),0,'no executor-not-installed state');
 assert.match(await text(page.locator('.sweep-status')),/游戏已连接[\s\S]*金币 3,243,300/);
 const startButton=page.locator('[data-native-start]');assert.equal(await startButton.isDisabled(),true,'purchases unavailable, no start');
 const table=page.locator('[data-sweep-rules]');
 assert.match(await text(table.locator('.native-block-head')),/扫货条件\s*3 件 · 在「关注」里修改/);
 assert.deepEqual(await table.locator('[data-rule]').allInnerTexts().then(r=>r.map(t=>t.replace(/\s+/g,' ').trim())),
  ['褐色皮帽 低价自用 · ≤ 10,000 · 可升级次数 ≥ 0 2 1','战斗弓 低价自用 · ≤ 10,000 · 可升级次数 ≥ 0 2 0','红药水 低价自用 · ≤ 10,000 · 可升级次数 ≥ 0 2 —']);
 assert.equal(await table.locator('input').count(),0,'rules are read-only on the desktop');
 await table.getByRole('button',{name:'关注',exact:true}).click();
 await page.locator('iframe[title="关注整页"]').waitFor();
 await tabs.getByRole('button',{name:'扫货',exact:true}).click();
 status.sweep.executor={ready:true,reason:''};
 await executor.filter({hasText:'购买功能就绪'}).waitFor({timeout:7000});
 assert.equal(await page.locator('[data-sweep-settings]').count(),0);
 const budget=page.locator('[data-sweep-run] [name=budget]');
 await page.locator('[data-sweep-run]').getByRole('button',{name:'1M',exact:true}).click();
 assert.equal(await budget.inputValue(),'1000000');
 await budget.fill('2000000');
 assert.equal(await startButton.isDisabled(),false,'legacy local cap zero no longer blocks a shared run');
 await page.locator('[data-sweep-run]').getByRole('button',{name:'6 小时',exact:true}).click();
 assert.match(await text(page.locator('[data-start-summary]')),/^褐色皮帽、战斗弓、红药水 · 预算 2M · (今天|明天) \d\d:\d\d 结束$/);
 await page.screenshot({path:path.join(shots,'desktop-sweep-idle.png')});
 await startButton.click();
 assert.deepEqual(calls.filter(c=>c.action==='start').at(-1).value,{budget:2000000,minutes:360,devices:['dev-a']});
 assert.equal(await page.evaluate(()=>localStorage.getItem('desktop.sweepMinutes')),'360','the duration is remembered');
 const runBlock=page.locator('[data-sweep-run]');await runBlock.locator('[data-native-stop]').waitFor();
 assert.match(await text(runBlock),/运行中[\s\S]*本机发起 · (今天|明天) \d\d:\d\d 结束[\s\S]*已花 1,100 \/ 2,000,000[\s\S]*剩余 1,998,900[\s\S]*本机 · 正在扫 3 洞 · 已查 12 店次 · 本机已花 100/);
 assert.equal(await runBlock.getByRole('progressbar').getAttribute('aria-valuenow'),'1100');
 assert.match(await text(table.locator('.native-block-head')),/本轮条件/);
 assert.equal(await table.locator('.rules-tr.full').count(),1,'a filled item is greyed');
 assert.match(await text(table.locator('[data-rule="2000000"]')),/已满\s*2[\s\S]*2/);
 assert.equal(await table.locator('[data-rule="2000000"] img.item-icon').getAttribute('src'),'https://mxdgcw.dvg.cn/dbsource/icon/item/2000000.png');
 assert.match(await text(table.locator('[data-rule="1452003"]')),/—/,'no progress yet is unknown, not zero');
 const recentRows=page.locator('[data-sweep-recent] [data-recent-status]');assert.equal(await recentRows.count(),3);
 assert.match(await text(recentRows.nth(0)),/红药水[\s\S]*2 件 @50 · [\s\S]*店主甲[\s\S]*100/);
 assert.match(await text(recentRows.nth(1)),/^\d\d:\d\d\s+战斗弓\s+未买 · 价格变了/,'no quantity on an unbought row');
 assert.match(await text(recentRows.nth(2)),/结果未知，请到游戏里核对/);
 await page.screenshot({path:path.join(shots,'desktop-sweep-running.png')});
 await tabs.getByRole('button',{name:'扫描采集',exact:true}).click();
 const line=page.locator('[data-sweep-status-line]');await line.waitFor();
 assert.equal(await text(line),'扫货中 已花 1.1K / 2M · 正在扫 3 洞 · 本轮已买 2 件 查看');
 await page.screenshot({path:path.join(shots,'desktop-scan-status-line.png')});
 await line.getByRole('button',{name:'查看'}).click();
 await page.locator('[data-native-stop]').click();await startButton.waitFor();
 assert.equal(calls.filter(c=>c.action==='stop').length,1);
 assert.match(await text(page.locator('[data-sweep-message]')),/扫货已停止/);

 // Account tab: rename this device, the read-only device list, the website, sign out and in.
 await tabs.getByRole('button',{name:'账号',exact:true}).click();
 const account=page.locator('[data-account-pane="signed-in"]');await account.waitFor();
 assert.equal(await page.locator('[data-watch-hits]').innerText(),'1','the hidden watch page keeps reporting');
 assert.match(await text(account.locator('[data-sync]')),/关注 3 件 · 已同步/);
 assert.match(await text(account.locator('[data-this-device]')),/本机\s*v0\.6\.15 · 自动更新已开启/);
 const rows=account.locator('[data-device]');await rows.first().waitFor();
 assert.match(await text(account.locator('.account-head')),/测试玩家[\s\S]*设备登录于 10\/27/);
 assert.deepEqual((await rows.allInnerTexts()).map(t=>t.replace(/\s+/g,' ').trim()),['书房电脑 本机 · 在线 · v0.8.2 · 可以扫货','笔记本 最后在线 2 小时前 · v0.8.1']);
 assert.equal(await account.locator('[data-devices] button').count(),0,'other devices are signed out on the website');
 const rename=account.locator('[data-rename]');assert.equal(await rename.isDisabled(),true,'unchanged name');
 await account.locator('[name=device_name]').fill('  游戏电脑 ');await rename.click();
 await account.getByRole('status').filter({hasText:'已改名'}).waitFor();
 assert.deepEqual(calls.filter(c=>c.action==='rename').at(-1).value,{name:'游戏电脑'});
 await rows.first().filter({hasText:'游戏电脑'}).waitFor();
 await page.screenshot({path:path.join(shots,'desktop-account.png')});
 await account.locator('[data-open-website]').click();
 const opened=()=>calls.some(c=>c.action==='command'&&c.value?.name==='website');
 for(let i=0;i<40&&!opened();i++)await page.waitForTimeout(50);
 assert(opened(),'opens the website');
 assert.equal(await page.getByText(/关联|绑定/).count(),0,'no link/bind code wording');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await page.locator('[data-account-pane="signed-out"]').waitFor();
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('status').filter({hasText:'请在浏览器中完成登录'}).waitFor();
 assert.equal(calls.filter(c=>c.action==='login').length,1);
 await tabs.getByRole('button',{name:'扫货',exact:true}).click();
 await page.getByRole('button',{name:'登录',exact:true}).waitFor();
 await page.screenshot({path:path.join(shots,'desktop-sweep-signed-out.png')});
 assert.equal(await page.locator('[data-sweep-status-line]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS embedded watch/price pages, same-account sync, upgrade-zero, delete/undo, sweep tab (status cells, quick budget, durations, read-only rules, folded settings, run progress, recent), status line, account rename/devices, sign-out/in');
}catch(e){console.error(e);throw e;}finally{for(const s of streams)s.end();server.closeAllConnections();server.close();await browser.close();}
