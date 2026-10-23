import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../js/lib/period.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
let serial=0;
async function setup(t,{search='',saved={},failure=false,blocked=false}={}){
  const originals=Object.fromEntries(['localStorage','location','history','__periodGet'].map(key=>[key,globalThis[key]]));
  const store=new Map(Object.entries(saved));let calls=0;
  globalThis.location=new URL('https://mxd.ruit.me/prices'+search);
  globalThis.localStorage={getItem:key=>{if(blocked)throw Error('blocked');return store.get(key)??null;},setItem:(key,value)=>{if(blocked)throw Error('blocked');store.set(key,value);},removeItem:key=>store.delete(key)};
  globalThis.history={state:null,replaceState:(_state,_title,url)=>{globalThis.location=new URL(url);}};
  globalThis.__periodGet=async()=>{calls++;if(failure)throw Error('offline');return {data:{default_hours:'all',recent_priced_items:23,recent_sales:24,historical_priced_items:769,threshold:30}};};
  t.after(()=>{for(const [key,value]of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const mod=await import('data:text/javascript,'+encodeURIComponent("const lang='zh';const getJson=(...args)=>globalThis.__periodGet(...args);\n"+source+`\n// instance ${serial++}`));
  return {...mod,calls:()=>calls,store};
}
test('sparse recent data defaults to all and reuses its short cached decision',async t=>{
  const p=await setup(t);assert.equal(await p.resolvePeriod(),'all');assert.equal(p.readPeriod(),'all');
  assert.equal(p.automaticPeriod(),true);assert.equal(await p.resolvePeriod(),'all');assert.equal(p.calls(),1);
  assert.match(p.periodControl('all'),/自动 · 全部/);
});
test('an explicit 72-hour URL is never automatically overridden',async t=>{
  const p=await setup(t,{search:'?hours=72'});assert.equal(await p.resolvePeriod(),'72');assert.equal(p.calls(),0);
});
test('manual period survives navigation and clears the automatic label',async t=>{
  const p=await setup(t);await p.resolvePeriod();p.savePeriod('72');
  assert.equal(p.readPeriod(),'72');assert.equal(p.automaticPeriod(),false);
  assert.equal(globalThis.location.search,'?hours=72');
  globalThis.location=new URL('https://mxd.ruit.me/');assert.equal(await p.resolvePeriod(),'72');
  p.savePeriod('auto');assert.equal(await p.resolvePeriod(),'all');assert.equal(p.automaticPeriod(),true);
});
test('old default 72h storage is eligible for fallback; an existing all preference is retained',async t=>{
  const p=await setup(t,{saved:{'market.hours':'72'}});assert.equal(await p.resolvePeriod(),'all');
});
test('a manual all preference does not need the decision endpoint',async t=>{
  const p=await setup(t,{saved:{'market.hours':'all'}});assert.equal(await p.resolvePeriod(),'all');assert.equal(p.calls(),0);
});
test('blocked browser storage still allows an in-memory automatic decision',async t=>{
  const p=await setup(t,{blocked:true});assert.equal(await p.resolvePeriod(),'all');assert.equal(p.readPeriod(),'all');
});
test('decision request failure falls back to 72h without blocking the page',async t=>{
  const p=await setup(t,{failure:true});assert.equal(await p.resolvePeriod(),'72');
});
