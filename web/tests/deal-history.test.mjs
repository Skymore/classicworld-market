import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/lib/deal-history.js',import.meta.url),'utf8');
const {mergeHistory,loadProfile,saveProfile,profileKey,tokenNamespace}=await import('data:text/javascript,'+encodeURIComponent(source));
const now=1800000000;
const deal=(id,observed=now)=>({id,item_id:4010001,name:'Test ore',shop:'Test shop',buy:500,observed,location:{channel:4,room:1},token:'MUST_NOT_SAVE',body_hex:'MUST_NOT_SAVE'});
const storage=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),map};};
test('history drops expired, future and malformed records; keeps latest 200',()=>{
 const rows=Array.from({length:250},(_,i)=>deal('id'+i,now-i));
 rows.push(deal('expired',now-86401),deal('future',now+60),{id:'bad',observed:now,item_id:5});
 const result=mergeHistory([],rows,now);assert.equal(result.length,200);assert.equal(result[0].id,'id0');assert.equal(result.at(-1).id,'id199');
});
test('duplicate delivery preserves the original finding and contains no credentials or raw payload',()=>{
 const original=deal('same'),changed={...original,buy:100};
 const result=mergeHistory([original],[changed],now);
 assert.equal(result.length,1);assert.equal(result[0].buy,500);assert.equal(result[0].shop,'Test shop');assert.ok(!JSON.stringify(result).includes('MUST_NOT_SAVE'));
});
test('collector profiles and switches survive reload and never leak into another identity',()=>{
 const db=storage();const profile={archive:[deal('one')],settings:{enabled:false,page:false,desktop:true}};
 assert.equal(saveProfile(db,'collector-a',profile,now),true);
 const restored=loadProfile(db,'collector-a',now);assert.equal(restored.archive.length,1);assert.equal(restored.settings.enabled,false);assert.equal(restored.settings.page,false);
 assert.deepEqual(loadProfile(db,'collector-b',now).archive,[]);assert.equal(loadProfile(db,'collector-b',now).settings.enabled,true);
});
test('legacy per-identity history and separate switches are migrated without reading unscoped data',()=>{
 const db=storage();db.setItem('market.alertArchive:old-a',JSON.stringify([deal('legacy')]));db.setItem('market.alertsEnabled:old-a','false');db.setItem('market.pageAlertsEnabled:old-a','false');db.setItem('market.alertArchive',JSON.stringify([deal('wrong-person')]));
 const restored=loadProfile(db,'new-hash',now,'old-a');assert.deepEqual(restored.archive.map(d=>d.id),['legacy']);assert.equal(restored.settings.enabled,false);assert.equal(restored.settings.page,false);
});
test('blocked and corrupt storage falls back safely instead of breaking the page',()=>{
 const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 const profile=loadProfile(blocked,'a',now);assert.deepEqual(profile.archive,[]);assert.equal(saveProfile(blocked,'a',profile,now),false);
 const db=storage();db.setItem(profileKey('a'),'broken');assert.deepEqual(loadProfile(db,'a',now).archive,[]);
});
test('namespace hashes the token rather than persisting it in the storage key',async()=>{
 const token='synthetic-test-'+ 'a'.repeat(32);const key=await tokenNamespace(token);assert.ok(!key.includes(token));assert.equal(key.length,70);assert.equal(await tokenNamespace(token),key);
});
