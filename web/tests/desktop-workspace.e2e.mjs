import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('../../desktop_ui',import.meta.url)));
const out=path.resolve(root,'../market_data/desktop-workspace-review');await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{const file=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url));if(!file.startsWith(root+path.sep)){res.writeHead(404);res.end();return;}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:880,height:740}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const state={version:'0.6.14',phase:'idle',mode:'scan',message:'',capture:'connected',upload:'ready',updates:'ready',windows:[{id:1,title:'MapleStory'}],selected:1,theme:'dark',activities:[],run_shops:0,run_items:0};
  const data={linked:true,public_id:'synthetic',nickname:'测试玩家',records:[{kind:'watch',key:'1002000',version:1,value:{position:0,cap:1000,notify:true,buyLimit:2,groups:[{id:'one',name:'测试条件',cap:1000,notify:true,buy:true,reminder:{minUpgrades:0}}]}}],simulation:{enabled:false,mode:'simulate',recent:[],checked:0,spent:0,units:0}};
  window.testData=data;window.calls=[];
  window.pywebview={api:{ready:async()=>state,command:async()=>state,workspace:async(action,value)=>{
   window.calls.push({action,value});
   if(action==='catalog')return {items:[{item_id:1002000,name_zh:'测试帽子'},{item_id:2000000,name_zh:'红药水'}]};
   if(action==='save'){for(const op of value.operations){const old=data.records.find(r=>r.kind===op.kind&&r.key===op.key);if(old){old.value=op.value;old.version++;}else data.records.push({...op,version:1});}}
   if(action==='logout'){data.linked=false;delete data.public_id;data.records=[];data.simulation.enabled=false;}
   if(action==='start')data.simulation.enabled=true;if(action==='stop')data.simulation.enabled=false;
   if(action==='login')return {opened:true};return structuredClone(data);
  }}};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.getByRole('button',{name:'开始扫描',exact:true}).waitFor();
 assert(await page.locator('.desktop-main').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'scan dashboard must fit without scrolling');
 await page.getByRole('navigation',{name:'功能'}).getByRole('button',{name:'关注与扫货'}).click();
 await page.getByRole('button',{name:'测试帽子'}).click();
 await page.getByText('更多条件',{exact:true}).click();
 assert.equal(await page.getByLabel('可升级次数至少').inputValue(),'0');
 await page.getByLabel('可升级次数至多').fill('5');
 await page.getByRole('button',{name:'保存条件',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.testData.records[0].value.groups[0].reminder.maxUpgrades),5);
 await page.getByRole('button',{name:'删除',exact:true}).click();
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 assert.equal(await page.getByLabel('条件组名称').count(),1);
 await page.getByRole('button',{name:'删除',exact:true}).click();
 await page.getByRole('button',{name:'保存条件',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.testData.records[0].value.groups.length),0);
 await page.getByRole('button',{name:'添加条件组'}).click();
 await page.getByLabel('最高单价',{exact:true}).fill('2000');
 await page.getByLabel('加入扫货',{exact:true}).check();
 await page.getByRole('button',{name:'保存条件',exact:true}).click();
 await page.getByRole('button',{name:'开始新一轮模拟'}).click();
 await page.getByRole('button',{name:'停止模拟'}).waitFor();
 await page.getByRole('button',{name:'停止模拟'}).click();
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='start').length),1);
 assert(await page.locator('.workspace-scroll').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'no horizontal overflow');
 await page.screenshot({path:path.join(out,'native-watch.png')});
 await page.getByRole('navigation',{name:'功能'}).getByRole('button',{name:'账号',exact:true}).click();
 await page.getByRole('button',{name:'退出本机账号'}).click();
 await page.getByRole('button',{name:'登录 / 注册'}).click();
 await page.getByText('请在浏览器完成登录并关联此扫描器，完成后这里会自动更新。').waitFor();
 assert.deepEqual(errors,[]);console.log('Desktop workspace: fixed size, native rules/upgrade-zero/delete/undo/save/simulate/account passed');
}finally{await browser.close();server.close();}
