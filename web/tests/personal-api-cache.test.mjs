import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=(await readFile(new URL('../js/lib/api.js',import.meta.url),'utf8')).replace(/^import .*?;\r?\n/,'const subscribeMarket=()=>()=>{};\n');
const {getJson}=await import('data:text/javascript,'+encodeURIComponent(code));
test('personal responses do not reuse another identity cache or ETag and tokens stay in headers',async()=>{
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({collector:options.headers.Authorization}),{headers:{ETag:'"same"','Content-Type':'application/json'}});};
 try{
  const url='/api/v1/collector/watch-listings?ids=1072128';
  const a=await getJson(url,{headers:{Authorization:'Bearer synthetic-a'},maxAgeMs:60000});
  const b=await getJson(url,{headers:{Authorization:'Bearer synthetic-b'},maxAgeMs:60000});
  assert.notEqual(a.data.collector,b.data.collector);assert.equal(requests.length,2);
  assert.ok(requests.every(r=>!r.url.includes('synthetic')&&!r.options.headers['If-None-Match']));
  const local='http://127.0.0.1:8780/api/v1/collector/status';
  await getJson(local,{maxAgeMs:60000});await getJson(local,{maxAgeMs:60000});
  assert.equal(requests.length,4,'cross-origin bridge responses must not be cached either');
 }finally{globalThis.fetch=original;}
});
