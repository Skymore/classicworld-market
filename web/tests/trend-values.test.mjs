import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const source=await readFile(new URL('../js/lib/trend.js',import.meta.url),'utf8');
const {trendValues,bindTrends}=await import('data:text/javascript,'+encodeURIComponent(source));
const bucket={start:Date.parse('2026-10-19T00:00:00Z')/1000,median:'12250.125',low:'0',high:'15000',count:'7'};
test('exact prices retain fractions and zero instead of K abbreviations',()=>{
  const result=trendValues(bucket,'en-US','America/Los_Angeles');
  assert.equal(result.median,'12,250.125');assert.equal(result.low,'0');
  assert.equal(result.high,'15,000');assert.equal(result.count,'7');
});
test('missing prices are not converted into zero',()=>{
  const result=trendValues({...bucket,median:undefined,low:'',high:'NaN',count:'0'},'zh-CN','Asia/Shanghai');
  assert.equal(result.median,'—');assert.equal(result.low,'—');assert.equal(result.high,'—');
  assert.equal(result.count,'0 · 无成交');
});
test('UTC bucket boundaries are displayed in the visitor timezone',()=>{
  const west=trendValues(bucket,'en-US','America/Los_Angeles').range;
  const east=trendValues(bucket,'en-US','Asia/Shanghai').range;
  assert.match(west,/Oct 18/);assert.match(west,/Oct 19/);assert.match(west,/05:00 PM/);
  assert.match(east,/Oct 19/);assert.match(east,/Oct 20/);assert.match(east,/08:00 AM/);
});
test('daily boundaries account for a DST transition',()=>{
  const range=trendValues({...bucket,start:Date.parse('2026-11-01T00:00:00Z')/1000},'en-US','America/Los_Angeles').range;
  assert.match(range,/PDT/);assert.match(range,/PST/);assert.match(range,/05:00 PM/);assert.match(range,/04:00 PM/);
});
test('hover, touch and keyboard selection update the same exact-value readout',t=>{
  const original=globalThis.document;
  const tooltip={setAttribute(){}};
  globalThis.document={documentElement:{lang:'en'},createElement:()=>tooltip};
  t.after(()=>{globalThis.document=original;});
  const events={},range={},values=['median','low','high','count'].map(key=>({dataset:{trendValue:key}}));
  const buttons=[{...bucket,median:'12345.125'},{...bucket,median:undefined,low:undefined,high:undefined,count:'0'}].map((dataset,index)=>({
    dataset:{...dataset,trendDay:String(index)},attrs:{},setAttribute(key,value){this.attrs[key]=value;},
    focus(){events.focusin({target:this});},closest(){return this;},
  }));
  const chart={dataset:{},prepend(){},querySelector:()=>range,querySelectorAll:selector=>selector==='[data-trend-day]'?buttons:selector==='[data-trend-value]'?values:[],addEventListener:(key,fn)=>{events[key]=fn;}};
  bindTrends({querySelectorAll:()=>[chart]});
  assert.equal(values[0].textContent,'12,345.125');
  events.pointerover({target:{closest:()=>({dataset:{trendHit:'1'}})}});
  assert.equal(tooltip.hidden,false);assert.match(tooltip.textContent,/No sales/);
  assert.equal(values[0].textContent,'—');assert.equal(values[3].textContent,'0 · No sales');
  events.click({target:buttons[0]});assert.equal(buttons[0].attrs['aria-pressed'],'true');
  let prevented=false;
  events.keydown({target:buttons[0],key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(buttons[1].attrs['aria-pressed'],'true');
  assert.equal(values[0].textContent,'—');assert.match(range.textContent,/2026/);
  events.pointerleave();assert.equal(tooltip.hidden,true);
});
