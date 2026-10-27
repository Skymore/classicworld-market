import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const out=path.join(root,'market_data/desktop-workspace-review');await mkdir(out,{recursive:true});
const products=[{item_id:1002000,name_zh:'褐色皮帽',name_en:'Brown Skullcap',typical:12000},{item_id:1452003,name_zh:'战斗弓',name_en:'Battle Bow',typical:95000},{item_id:2000000,name_zh:'红药水',name_en:'Red Potion',typical:50}];
const records=products.map((i,n)=>({kind:'watch',key:String(i.item_id),version:1,value:{position:n,cap:10000,notify:true,buyLimit:2,groups:[{id:'one',name:'低价自用',cap:10000,notify:true,buy:true,reminder:{minUpgrades:0}}]}}));
const data={linked:true,public_id:'synthetic',nickname:'测试玩家',records,simulation:{enabled:false,mode:'simulate',recent:[],checked:0,spent:0,units:0}};
const state={version:'0.6.15',phase:'idle',mode:'scan',message:'',capture:'connected',upload:'ready',updates:'ready',windows:[{id:1,title:'MapleStory'}],selected:1,theme:'light',activities:[],run_shops:0,run_items:0};
const listings=products.map((p,n)=>({id:'offer-'+n,item_id:p.item_id,unit_price:1000,stock:5,bundle:1,observed:Date.now()/1000,shop:'测试店铺',location:{channel:3,room:2}}));
const calls=[],streams=new Set();let origin;
const json=(res,d)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(d));};
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');let input={};if(req.method==='POST'){let b='';for await(const c of req)b+=c;input=JSON.parse(b);}
 if(u.pathname==='/test/desktop'){
  const {action,value}=input;calls.push(input);
  if(action==='ready'||action==='command')return json(res,state);
  if(action==='page')return json(res,{url:origin+'/'+value.page+'?lang=zh&theme='+value.theme});
  if(action==='start')data.simulation.enabled=true;if(action==='stop')data.simulation.enabled=false;
  if(action==='logout'){data.linked=false;data.simulation.enabled=false;}
  if(action==='login')return json(res,{opened:true});
  if(action==='save')for(const op of value.operations){const old=records.find(r=>r.key===op.key&&r.kind===op.kind);if(old){old.value=op.value;old.version++;}else records.push({...op,version:1});}
  return json(res,data);
 }
 if(u.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(u.pathname==='/api/v1/account')return json(res,{signed_in:true,mode:'collector',sync_scope:'watch',linked:data.linked,public_id:data.linked?data.public_id:null,nickname:data.nickname,csrf:'fixture'});
 if(u.pathname==='/api/v1/account/data'){
  if(req.method==='POST'){
   assert.equal(input.account,data.public_id);assert.equal(req.headers['x-csrf-token'],'fixture');
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
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:880,height:740}}),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
 await page.addInitScript(()=>{if(location.pathname!=='/')return;const invoke=(action,value)=>fetch('/test/desktop',{method:'POST',body:JSON.stringify({action,value})}).then(r=>r.json());window.pywebview={api:{ready:()=>invoke('ready'),command:()=>invoke('command'),workspace:invoke}};});
 console.log('opening desktop');await page.goto(origin+'/');await page.getByRole('button',{name:'开始扫描',exact:true}).waitFor();
 assert(await page.locator('.desktop-main').evaluate(e=>e.scrollHeight<=e.clientHeight+1));
 const tabs=page.getByRole('navigation',{name:'功能'});
 await tabs.getByRole('button',{name:'关注',exact:true}).click();
 const watch=page.frameLocator('iframe[title="关注整页"]');
 console.log('waiting website watch');await watch.locator('.watch-page [data-card="1002000"]').waitFor();console.log('watch loaded');
 assert.equal(await watch.locator('.watch-page [data-card]').count(),3,'shared account watches loaded by the entire website page');
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
 await tabs.getByRole('button',{name:'价格表',exact:true}).click();
 const prices=page.frameLocator('iframe[title="价格表整页"]');
 await prices.locator('[data-item-row]:visible').first().waitFor();
 assert(await prices.locator('[data-item-row]').count()>=3,'entire price page renders its data rows');
 await page.screenshot({path:path.join(out,'website-prices.png')});
 await tabs.getByRole('button',{name:'扫货模拟',exact:true}).click();
 await page.getByRole('button',{name:'开始模拟'}).click();await page.getByRole('button',{name:'停止模拟'}).click();
 assert.equal(calls.filter(c=>c.action==='start').length,1);
 await tabs.getByRole('button',{name:'账号',exact:true}).click();await page.getByRole('button',{name:'退出本机账号'}).click();
 await page.getByRole('button',{name:'登录 / 注册'}).click();
 assert.deepEqual(errors,[]);console.log('PASS whole website watch/price pages, same-account sync, upgrade-zero, delete/undo, simulation, logout and fixed scan dashboard');
}catch(e){console.error(e);throw e;}finally{for(const s of streams)s.end();server.closeAllConnections();server.close();await browser.close();}
