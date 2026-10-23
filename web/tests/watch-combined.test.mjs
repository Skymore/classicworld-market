import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../js/lib/watchlist-core.js',import.meta.url),'utf8');
const {combinedNotifications}=await import('data:text/javascript,'+encodeURIComponent(code));
const state=()=>({shared:new Map(),personal:new Map(),delivered:new Map()});
const watches=[{item_id:1072128,max_price:100,added_at:90}];
const row=(observed)=>({id:'same-offer',item_id:1072128,unit_price:50,stock:1,observed});
test('a shared offer seen before page load still alerts on my own fresh visit',()=>{
 const seen=state();assert.equal(combinedNotifications([row(95)],watches,seen,100,105).length,0);
 assert.equal(combinedNotifications([row(110)],watches,seen,100,111,'personal','me').length,1);
 assert.equal(combinedNotifications([row(112)],watches,seen,100,113,'personal','me').length,0);
});
test('shared and own delivery of one update emits once, while shared new offers still alert',()=>{
 const seen=state();assert.equal(combinedNotifications([row(110)],watches,seen,100,111).length,1);
 assert.equal(combinedNotifications([row(110)],watches,seen,100,111,'personal','me').length,0);
 assert.equal(combinedNotifications([row(110)],watches,seen,100,125,'personal','another-connected-identity').length,0);
 assert.equal(combinedNotifications([{...row(115),id:'new-shared'}],watches,seen,100,116).length,1);
});
test('own visits outside cap, sold out, stale or without collector identity never alert',()=>{
 const seen=state();const invalid=[{...row(110),unit_price:101},{...row(110),stock:0},row(80)];
 assert.equal(combinedNotifications(invalid,watches,seen,100,220,'personal','me').length,0);
 assert.equal(combinedNotifications([row(110)],watches,seen,100,111,'personal','').length,0);
});
