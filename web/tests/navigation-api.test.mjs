import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const signals=new Set();globalThis.__marketSignals=signals;
const source=(await readFile(new URL('../js/lib/api.js',import.meta.url),'utf8')).replace(/import \{ subscribeMarket \} from [^;]+;/,`const subscribeMarket=fn=>{globalThis.__marketSignals.add(fn);return ()=>globalThis.__marketSignals.delete(fn);};`);
const {getJson,poll,api}=await import('data:text/javascript,'+encodeURIComponent(source));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const response=(value=1)=>new Response(JSON.stringify({value}),{headers:{ETag:'"v1"'}});

test('navigation cache and request lifecycle',async t=>{
  const originalFetch=globalThis.fetch, originalDocument=globalThis.document, originalNow=Date.now;
  let now=100000;
  const listeners=new Set();
  globalThis.document={visibilityState:'visible',addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
  Date.now=()=>now;
  t.after(()=>{globalThis.fetch=originalFetch;globalThis.document=originalDocument;Date.now=originalNow;});

  await t.test('recent snapshot paints while network is pending; leaving aborts it',async()=>{
    globalThis.fetch=async()=>response();await getJson('/warm');
    let resolveFetch,signal;
    globalThis.fetch=(_,options)=>{signal=options.signal;return new Promise(resolve=>resolveFetch=resolve);};
    const values=[],stop=poll('/warm',data=>values.push(data.value));
    try {
      await turn();assert.deepEqual(values,[1]);await stop.first;
      stop();assert.equal(signal.aborted,true);assert.equal(listeners.size,0);
      resolveFetch(response(2));await turn();await turn();assert.deepEqual(values,[1]);
    } finally {stop();}
  });

  await t.test('304 revalidation does not paint the same cached snapshot twice',async()=>{
    globalThis.fetch=async()=>response();await getJson('/unchanged');
    globalThis.fetch=async(_,options)=>{assert.equal(options.headers['If-None-Match'],'"v1"');return new Response(null,{status:304});};
    const values=[],stop=poll('/unchanged',data=>values.push(data.value));
    try {await turn();await turn();assert.deepEqual(values,[1]);}finally{stop();}
  });

  await t.test('expired snapshots are not replayed as recently checked data',async()=>{
    globalThis.fetch=async()=>response();await getJson('/expired');now+=31001;
    let resolveFetch;globalThis.fetch=()=>new Promise(resolve=>resolveFetch=resolve);
    const values=[],stop=poll('/expired',data=>values.push(data.value));
    try {await turn();assert.deepEqual(values,[]);stop();await stop.first;resolveFetch(response());await turn();}finally{stop();}
  });

  await t.test('explicit short cache reuse avoids an unnecessary request',async()=>{
    let requests=0;globalThis.fetch=async()=>{requests++;return response();};
    await getJson('/short-cache');const answer=await getJson('/short-cache',{maxAgeMs:15000});
    assert.equal(requests,1);assert.equal(answer.changed,false);assert.equal(answer.data.value,1);
  });

  await t.test('visibility events do not start overlapping poll requests',async()=>{
    let requests=0,resolveFetch;globalThis.fetch=()=>{requests++;return new Promise(resolve=>resolveFetch=resolve);};
    const stop=poll('/busy',()=>{});
    try {for(const callback of [...listeners]){callback();callback();}assert.equal(requests,1);stop();resolveFetch(response());await turn();}finally{stop();}
  });

  await t.test('push subscription continues when the game puts the page in background',async()=>{
    document.visibilityState='hidden';let requests=0;
    globalThis.fetch=async(_,options)=>{requests++;assert.equal(options.cache,'no-cache');return response(8);};
    const values=[],stop=poll('/hidden-watch',data=>values.push(data.value),{background:true});
    try {await stop.first;assert.equal(requests,1);assert.deepEqual(values,[8]);}finally{stop();document.visibilityState='visible';}
  });

  await t.test('a timed out request releases the subscriber and the next event succeeds',async()=>{
    let requests=0,finish;const done=new Promise(resolve=>finish=resolve);
    globalThis.fetch=(_,options)=>{
      requests++;
      if(requests===1)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason)));
      return Promise.resolve(response(9));
    };
    const errors=[],stop=poll('/timeout-retry',()=>finish(),{timeoutMs:5,intervalMs:1,onError:e=>errors.push(e.name)});
    try {await stop.first;for(const notify of signals)notify();await done;assert.equal(requests,2);assert.deepEqual(errors,['TimeoutError']);}finally{stop();}
  });

  await t.test('item refresh may retry unchanged JSON after a failed HTML refresh',async()=>{
    globalThis.fetch=async()=>response();await getJson('/retry-unchanged');
    globalThis.fetch=async()=>new Response(null,{status:304});
    const values=[],stop=poll('/retry-unchanged',data=>values.push(data.value),{notifyUnchanged:true});
    try {await stop.first;await turn();assert.ok(values.length>=1);}finally{stop();}
  });

  await t.test('push updates hidden pages and coalesces events during a request',async()=>{
    document.visibilityState='hidden';let requests=0,resolveRequest;
    globalThis.fetch=()=>{requests++;return new Promise(resolve=>resolveRequest=resolve);};
    const values=[],stop=poll('/push-events',d=>values.push(d.value));
    try {
      for(const notify of signals){notify();notify();}
      assert.equal(requests,1);resolveRequest(response(1));await turn();await turn();
      assert.equal(requests,2);resolveRequest(response(2));await turn();await turn();
      assert.deepEqual(values,[1,2]);stop();assert.equal(signals.size,0);
    }finally{stop();document.visibilityState='visible';}
  });

  await t.test('home, prices and watch share the default 72h cache key',()=>{
    assert.equal(api.list(),api.list('72'));assert.notEqual(api.list(),api.list('all'));
  });
});
