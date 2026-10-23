import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../js/lib/quote-order.js',import.meta.url),'utf8');
const {compareQuotes,quoteTime,sortWatchQuotes}=await import('data:text/javascript,'+encodeURIComponent(code));
test('latest observed wins over lower price; equal times tie by price; unknown times last',()=>{
 const values=[{key:'old-cheap',observed:1,price:1},{key:'new',observed:5,price:20},{key:'tie-cheap',observed:5,price:10},{key:'unknown',observed:null,price:0}];
 assert.deepEqual(values.toSorted((a,b)=>compareQuotes(a,b,true)).map(v=>v.key),['tie-cheap','new','old-cheap','unknown']);
 assert.equal(values.toSorted((a,b)=>compareQuotes(a,b,false))[0].key,'unknown');
 assert.equal(quoteTime(NaN),null);assert.equal(quoteTime(0),null);
});
test('watch offers switch between observed time and unit price without changing the input',()=>{
 const rows=[{id:'old',observed:10,unit_price:1},{id:'new-expensive',observed:30,unit_price:9},{id:'new-cheap',observed:30,unit_price:5},{id:'unknown',observed:null,unit_price:2}];
 assert.deepEqual(sortWatchQuotes(rows,'recent').map(r=>r.id),['new-cheap','new-expensive','old','unknown']);
 assert.deepEqual(sortWatchQuotes(rows,'price').map(r=>r.id),['old','unknown','new-cheap','new-expensive']);
 assert.equal(rows[0].id,'old');
});
