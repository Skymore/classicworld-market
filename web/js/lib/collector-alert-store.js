import {loadProfile,saveProfile,mergeHistory,tokenNamespace} from './deal-history.js?v=20261022-regressions-1';
import {subscribeMarket,subscribeCollector} from './realtime.js?v=20261022-regressions-1';
const KEY='cwm.collector.token';
export function createAlertsStore(onFind=()=>{}) {
 const now=()=>Date.now()/1000;let storage=null;try{storage=localStorage;}catch{}
 let initialToken=null;try{initialToken=storage?.getItem(KEY);}catch{}
 let token=initialToken,localCollector=false,collectorStatus=null,namespace=null,profile=null,historyView=false,revision=0;
 let hours=new URLSearchParams(location.search).get('hours')==='all'?'all':'72',deals=[],first=true,problem=null,checkedAt=null,busy=false,pending=false,stopped=false,storageOkay=true,historyLimit=24;
 let controller=null,retryTimer=null,historyExpiry=null,statusExpiry=null,failures=0;
 const seen=new Set(),listeners=new Set();let snapshot;
 const connected=()=>Boolean(token||localCollector);
 function emit(){snapshot={token,connected:connected(),collectorStatus,profile,historyView,hours,deals,first,problem,checkedAt,storageOkay,historyLimit};for(const fn of listeners)fn();}
 function persist(){if(namespace&&profile){storageOkay=saveProfile(storage,namespace,profile,now());clearTimeout(historyExpiry);if(profile.archive.length)historyExpiry=setTimeout(()=>{if(!stopped){profile.archive=mergeHistory(profile.archive,[],now());persist();emit();}},Math.max(1000,(profile.archive.at(-1).observed+86401-now())*1000));}}
 async function openProfile(legacy=null){const epoch=revision,key=token?await tokenNamespace(token):localCollector?'local-'+collectorStatus.collector_id:null;if(stopped||epoch!==revision||!key)return;namespace=key;profile=loadProfile(storage,key,now(),legacy);seen.clear();for(const row of profile.archive)seen.add(row.id);}
 async function refreshStatus(){if(!connected())return;const epoch=revision;try{const response=await fetch('/api/v1/collector/status',{headers:token?{Authorization:`Bearer ${token}`}:{},cache:'no-store',signal:AbortSignal.timeout(5000)});if(response.ok){const next=await response.json();if(!stopped&&epoch===revision){collectorStatus=next;emit();}}}catch{}}
 async function check(){if(stopped||!connected()||!profile)return;if(busy){pending=true;return;}clearTimeout(retryTimer);busy=true;const epoch=revision;controller=new AbortController();const deadline=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch('/api/v1/collector/alerts?hours='+hours,{headers:{Accept:'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},credentials:'same-origin',cache:'no-store',signal:controller.signal});if(response.status===401){problem='invalid';return;}if(response.status===429){problem='limited';return;}if(!response.ok){problem='failed';return;}const data=await response.json();if(stopped||epoch!==revision)return;deals=Array.isArray(data.opportunities)?data.opportunities:[];checkedAt=data.generated_at??now();problem=null;failures=0;
   if(data.collector_id&&!profile.archive.length){const legacy=loadProfile(storage,namespace,now(),data.collector_id);profile.archive=legacy.archive;if(!profile.remembered)profile.settings=legacy.settings;for(const row of profile.archive)seen.add(row.id);}
   const fresh=deals.filter(row=>!seen.has(row.id)&&now()-row.observed<=120&&row.observed<=now());for(const row of deals)seen.add(row.id);profile.archive=mergeHistory(profile.archive,deals,now());persist();if(!first&&profile.settings.enabled)for(const row of fresh.slice(0,5))onFind(row,{...profile.settings});first=false;void refreshStatus();
  }catch{if(epoch===revision&&!stopped)problem='failed';}finally{clearTimeout(deadline);busy=false;if(!stopped){emit();if(pending){pending=false;void check();}else if(problem==='failed'||problem==='limited')retryTimer=setTimeout(check,Math.min(15000,500*2**Math.min(failures++,5)));}}}
 async function setToken(next){revision++;controller?.abort();clearTimeout(retryTimer);clearTimeout(historyExpiry);token=next||null;localCollector=false;collectorStatus=null;namespace=null;profile=null;try{if(next)storage?.setItem(KEY,next);else storage?.removeItem(KEY);}catch{}problem=null;first=true;deals=[];historyView=false;seen.clear();if(next)await openProfile();if(!stopped){emit();if(connected())void check();}}
 const unsubscribe=subscribeMarket(()=>check());
 const stopStatus=subscribeCollector(next=>{if(localCollector&&next.collector_id===collectorStatus?.collector_id){collectorStatus=next;clearTimeout(statusExpiry);statusExpiry=setTimeout(()=>{if(!stopped&&collectorStatus?.connection_health){collectorStatus={...collectorStatus,connection_health:{state:'offline'}};emit();}},12000);emit();}});
 const visible=()=>{if(document.visibilityState==='visible')void check();};const stored=event=>{if(event.key===KEY&&event.newValue!==token)void setToken(event.newValue);};document.addEventListener('visibilitychange',visible);window.addEventListener('storage',stored);
 emit();
 const ready=(async()=>{if(token)await openProfile();else if(['localhost','127.0.0.1'].includes(location.hostname)&&!['8766','8765'].includes(location.port)){try{const response=await fetch('/api/v1/collector/status',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(response.ok&&!stopped){collectorStatus=await response.json();localCollector=collectorStatus.local_collector===true;if(localCollector)await openProfile(collectorStatus.collector_id);}}catch{}}if(!stopped){emit();if(connected())void check();}})();
 return {ready,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>snapshot,setToken,
  view(history){historyView=history;historyLimit=24;if(profile){profile.archive=mergeHistory(profile.archive,[],now());persist();}emit();},more(){historyLimit+=24;emit();},
  setHours(next){if(next===hours)return;hours=next==='all'?'all':'72';const url=new URL(location.href);if(hours==='all')url.searchParams.set('hours','all');else url.searchParams.delete('hours');history.replaceState(history.state,'',url);first=true;controller?.abort();revision++;emit();void check();},
  setting(key,value){if(profile&&['enabled','page','desktop'].includes(key)){profile={...profile,settings:{...profile.settings,[key]:value}};persist();emit();}},
  dispose(){stopped=true;revision++;clearTimeout(retryTimer);clearTimeout(historyExpiry);clearTimeout(statusExpiry);unsubscribe();stopStatus();controller?.abort();document.removeEventListener('visibilitychange',visible);window.removeEventListener('storage',stored);listeners.clear();}
 };
}
