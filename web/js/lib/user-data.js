// A storage facade: guest keys stay untouched; account caches and pending writes
// are namespaced by a server-confirmed public account ID. Credentials stay in cookies.
const PREFS=['lang','theme','market.offerSort','watch.offerSort','market.hours'];
const KEYS=['watchlist','watchlist_settings',...PREFS];
const itemPref=key=>/^item\.(offerFilters|showExpired)\.[1-5]\d{6}$/.test(key);
const preference=key=>PREFS.includes(key)||itemPref(key);
const managed=key=>KEYS.includes(key)||itemPref(key);
const PREFIX='cwm.user-data.v1.';
const SIGNAL='cwm.account-signal.v1';
const ACTIVE_PREFERENCES='cwm.preferences.account.v1';
const browser=typeof window!=='undefined'&&typeof document!=='undefined'&&typeof location!=='undefined';
const native=()=>globalThis.localStorage;
const parse=(raw,fallback)=>{try{return JSON.parse(raw)??fallback;}catch{return fallback;}};
const read=(key)=>{try{return native().getItem(key);}catch{return null;}};
const write=(key,value)=>{native().setItem(key,value);};
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const recordKey=r=>`${r.kind}:${r.key}`;
let owner=null,profile=null,context=null,epoch=0,identityBusy=null,busy=false,timer=null,poll=null,status='guest',persistent=true;
let listeners=new Set();
const notify=()=>{for(const fn of listeners)fn(getSyncState());if(browser)window.dispatchEvent(new CustomEvent('user-sync',{detail:getSyncState()}));};
const guestIds=()=>{const value=parse(read('watchlist'),[]);return Array.isArray(value)?value:[];};
export function getSyncState(){return{status,signed_in:!!owner,pending:Object.keys(context?.pending||{}).length,conflicts:Object.keys(context?.conflicts||{}).length,guestWatches:guestIds().length};}
export function subscribeSync(fn){listeners.add(fn);fn(getSyncState());return()=>listeners.delete(fn);}
function persist(){if(context&&owner)try{write(PREFIX+owner,JSON.stringify(context));persistent=true;}catch{persistent=false;}}
function valuesFrom(records){
 const values={},watches=[];const settings={};
 for(const r of records){if(r.value==null)continue;if(r.kind==='pref'&&preference(r.key))values[r.key]=String(r.value);
  if(r.kind==='watch'){const id=Number(r.key);if(!Number.isSafeInteger(id))continue;watches.push({id,position:r.value.position});settings[id]={cap:r.value.cap??null,notify:r.value.notify!==false,...(r.value.reminder?{reminder:r.value.reminder}:{})};}}
 watches.sort((a,b)=>a.position-b.position||a.id-b.id);values.watchlist=JSON.stringify(watches.map(w=>w.id));values.watchlist_settings=JSON.stringify(settings);return values;
}
function recordsFrom(values){
 const raw=parse(values.watchlist,[]),ids=[...new Set((Array.isArray(raw)?raw:[]).map(Number).filter(id=>Number.isSafeInteger(id)&&id>=1000000&&id<=5999999))];
 const settings=parse(values.watchlist_settings,{})||{};
 const records=ids.map((id,position)=>({kind:'watch',key:String(id),value:{cap:Number.isFinite(settings[id]?.cap)?settings[id].cap:null,notify:settings[id]?.notify!==false,position,...(settings[id]?.reminder?{reminder:settings[id].reminder}:{})}}));
 for(const key of Object.keys(values))if(preference(key)&&values[key]!=null)records.push({kind:'pref',key,value:values[key]});return records;
}
function queue(){
 if(!owner||!context)return;
 const desired=new Map(recordsFrom(context.values).map(r=>[recordKey(r),r]));
 const base=new Map(context.records.map(r=>[recordKey(r),r]));
 for(const key of new Set([...desired.keys(),...base.keys(),...Object.keys(context.pending)])){
  const previous=base.get(key),next=desired.get(key)||{kind:previous?.kind||context.pending[key].kind,key:previous?.key||context.pending[key].key,value:null};
  if(same(previous?.value,next.value))delete context.pending[key];
  else context.pending[key]={...next,version:context.pending[key]?.version??previous?.version??0};
 }
 const pending=Object.keys(context.pending).length;
 persist();status=Object.keys(context.conflicts).length?'conflict':pending?(persistent?'pending':'memory_only'):'synced';notify();
 if(pending)schedule();else clearTimeout(timer);
}
export const userStorage={
 getItem(key){
  if(owner&&context){if(key==='market.period-manual.v1')return context.values['market.hours']?'1':null;if(managed(key))return context.values[key]??null;}
  return read(key);
 },
 setItem(key,value){
  if(owner&&context&&(managed(key)||key==='market.period-manual.v1')){
   if(key==='market.period-manual.v1')return;
   if(key==='watchlist'&&parse(value,[]).length>100)throw new Error('watch_limit');
   if(context.values[key]===String(value))return;
   context.values[key]=String(value);queue();return;
  }
  write(key,String(value));
 },
 removeItem(key){if(owner&&context&&(managed(key)||key==='market.period-manual.v1')){if(!(key in context.values))return;delete context.values[key];queue();return;}native().removeItem(key);}
};
function changed(){
 if(!browser)return;
 window.dispatchEvent(new StorageEvent('storage',{key:'watchlist'}));
 document.dispatchEvent(new CustomEvent('watchchange',{detail:{count:parse(userStorage.getItem('watchlist'),[]).length}}));
 window.dispatchEvent(new CustomEvent('user-preferences'));
}
async function request(path,body,csrf=profile?.csrf){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal});
  const data=await response.json();if(!response.ok){const e=new Error(data.error||'unavailable');e.status=response.status;throw e;}return data;
 }finally{clearTimeout(timeout);}
}
function schedule(delay=400){clearTimeout(timer);if(owner)timer=setTimeout(()=>flush().catch(()=>{}),delay);}
function reconcile(records,accepted=[],save=true){
 const incoming=new Map(records.map(r=>[recordKey(r),r]));
 for(const sent of accepted){const key=recordKey(sent),pending=context.pending[key];
  if(pending&&same(pending.value,sent.value))delete context.pending[key];
  else if(pending&&incoming.has(key))pending.version=incoming.get(key).version;
 }
 for(const [key,pending] of Object.entries(context.pending)){
  const remote=incoming.get(key);
  if(same(remote?.value,pending.value)){delete context.pending[key];continue;}
  if((remote?.version??0)!==pending.version){context.conflicts[key]=pending;delete context.pending[key];}
 }
 context.records=records;
 const overlay=new Map(records.map(r=>[recordKey(r),r]));for(const r of Object.values(context.pending))overlay.set(recordKey(r),r);
 context.values=valuesFrom([...overlay.values()]);if(save)persist();
 status=Object.keys(context.conflicts).length?'conflict':Object.keys(context.pending).length?'pending':'synced';changed();notify();
}
export async function flush(){
 if(!owner||!context||busy)return;
 const mine=epoch,account=owner,csrf=profile?.csrf;
 // Delete first when replacing a full list, and keep batches below the API cap.
 const operations=Object.values(context.pending).sort((a,b)=>Number(b.value==null)-Number(a.value==null)).slice(0,120);
 busy=true;
 try{
  const result=await request('/api/v1/account/data',operations.length?{operations}:null,csrf);
  if(mine!==epoch||owner!==account)return;
  reconcile(result.records||[],operations);
 }catch(e){
  if(mine!==epoch)return;
  if(e.status===401||e.status===403){status='login_required';notify();await refreshIdentity();return;}
  if(e.status===409&&e.message==='sync_conflict'){
   const result=await request('/api/v1/account/data',null,csrf);if(mine===epoch)reconcile(result.records||[]);
  }else{status=e.message==='watch_limit'?'watch_limit':persistent?'offline':'memory_only';notify();}
 }finally{if(mine===epoch){busy=false;if(owner&&Object.keys(context?.pending||{}).length&&status!=='watch_limit'&&status!=='login_required')schedule(status==='offline'?15000:600);}}
}
export async function adoptAccount(next,{broadcast=false}={}){
 const account=next?.signed_in&&next.mode!=='collector'&&typeof next.public_id==='string'?next.public_id:null;
 profile=next;
 // Let the blocking bootstrap read the active account's cached theme before
 // modules or the network load. This is a public ID, never a credential.
 try{if(account)write(ACTIVE_PREFERENCES,account);else native().removeItem(ACTIVE_PREFERENCES);}catch{}
 if(account===owner){if(account)await flush();return;}
 epoch++;busy=false;clearTimeout(timer);owner=account;context=null;
 if(owner){
  const stored=parse(read(PREFIX+owner),{});
  context={records:Array.isArray(stored.records)?stored.records:[],values:stored.values||{},pending:stored.pending||{},conflicts:stored.conflicts||{}};
  status='pending';await flush();
 }else status='guest';
 if(broadcast)try{write(SIGNAL,JSON.stringify({at:Date.now(),nonce:Math.random()}));}catch{}
 changed();notify();
}
export async function refreshIdentity(){
 if(identityBusy)return identityBusy;
 const mine=epoch;
 identityBusy=(async()=>{
  try{const next=await request('/api/v1/account');if(mine!==epoch)return profile;await adoptAccount(next);if(browser)window.dispatchEvent(new CustomEvent('account-changed',{detail:next}));return next;}
  catch{status=owner?'offline':'guest';notify();return null;}
 })().finally(()=>{identityBusy=null;});return identityBusy;
}
export async function importGuest(){
 if(!owner)throw new Error('login_required');
 const keys=[...KEYS];try{for(let i=0;i<native().length;i++){const key=native().key(i);if(itemPref(key))keys.push(key);}}catch{}
 const values=Object.fromEntries(keys.map(key=>[key,read(key)]));
 const operations=recordsFrom(values).map(r=>({...r,version:0}));if(!operations.length)return;
 const mine=epoch;
 for(let i=0;i<operations.length;i+=120){
  const result=await request('/api/v1/account/data/import',{operations:operations.slice(i,i+120)});
  if(mine!==epoch)return;reconcile(result.records||[]);
 }
 try{write(PREFIX+owner+'.imported','1');}catch{}
}
export function guestImportAvailable(){return !!owner&&!read(PREFIX+owner+'.imported')&&guestIds().length>0;}
export function retryConflicts(){
 if(!owner)return;
 const base=new Map(context.records.map(r=>[recordKey(r),r]));
 for(const [key,r]of Object.entries(context.conflicts))context.pending[key]={...r,version:base.get(key)?.version??0};
 context.conflicts={};const overlay=new Map(context.records.map(r=>[recordKey(r),r]));for(const r of Object.values(context.pending))overlay.set(recordKey(r),r);
 context.values=valuesFrom([...overlay.values()]);persist();status='pending';changed();notify();schedule();
}
export async function beforeSignOut(){if(owner)await flush();}
export const ready=browser?refreshIdentity():Promise.resolve(null);
if(browser){
 poll=setInterval(()=>{if(document.visibilityState==='visible')refreshIdentity();},30000);poll.unref?.();
 window.addEventListener('online',()=>refreshIdentity());
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshIdentity();});
 window.addEventListener('storage',e=>{
  if(e.key===SIGNAL){epoch++;owner=null;context=null;clearTimeout(timer);changed();if(identityBusy)identityBusy.finally(()=>refreshIdentity());else refreshIdentity();}
  else if(owner&&e.key===PREFIX+owner&&e.newValue){
   // Merge unsent operations from both tabs before rebuilding the view. Reading
   // the current value avoids replaying an older queued storage event.
   const next=parse(read(PREFIX+owner),null);
   if(next&&context){context={...next,pending:{...context.pending,...next.pending},conflicts:{...context.conflicts,...next.conflicts}};reconcile(next.records||[],[],false);schedule();}
  }
 });
}
