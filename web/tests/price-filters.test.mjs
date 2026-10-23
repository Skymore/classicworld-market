import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
const load=async path=>import('data:text/javascript,'+encodeURIComponent((await readFile(new URL(path,import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'')));
const {priceFilterTokens,clearPriceFilter}=await load('../js/lib/price-filters.js');
const {spark}=await load('../js/lib/spark.js');
const {periodProduct}=await load('../js/lib/period.js');
const base={q:'鹰弩',cat:'equip',job:'all',lmin:null,lmax:null,few:true,cash:true,sold:false,drop:false,watch:false,sort:'price',dir:'asc',tab:'changes'};
test('active tokens describe hidden conditions without repeating visible search/category',()=>{
  assert.deepEqual(priceFilterTokens(base),[]);
  const selected={...base,job:'bowman',lmin:25,lmax:30,few:false,drop:true};
  assert.deepEqual(priceFilterTokens(selected,false,false).map(t=>t.label),['弓箭手','等级 25–30','至少 5 笔']);
  assert.equal(priceFilterTokens(selected,true,true).at(-1).label,'Monster drops');
});
test('clearing one condition preserves unrelated filters and sorting',()=>{
  const selected={...base,job:'bowman',lmin:25,lmax:30};
  const cleared=clearPriceFilter(selected,'level');
  assert.equal(cleared.lmin,null);assert.equal(cleared.lmax,null);assert.equal(cleared.job,'bowman');
  assert.equal(cleared.q,'鹰弩');assert.equal(cleared.sort,'price');assert.equal(selected.lmin,25);
  assert.equal(clearPriceFilter(selected,'all').q,'鹰弩');
  assert.equal(clearPriceFilter(selected,'everything').q,'');
  assert.equal(clearPriceFilter(selected,'everything').cat,'all');
});
test('few-sales classification uses the same five-sale threshold as item details',()=>{
  for(const count of [0,1,3,4])assert.equal(periodProduct({sales_window:count}).low_data,true);
  assert.equal(periodProduct({sales_window:5}).low_data,false);
  const row={typical:200,low_data:false};assert.equal(periodProduct(row),row);
});
test('mini chart does not connect across missing days',()=>{
  const result=spark([10,20,null,30,40]);
  const path=result.match(/<path d="([^"]+)"/)[1];
  assert.equal((path.match(/M/g)||[]).length,2);
  assert.equal((path.match(/L/g)||[]).length,2);
  assert.equal(spark([null,null]),'');assert.equal(spark([null,10]),'');
  assert.ok(!spark([0,0,0]).includes('NaN'));
});
