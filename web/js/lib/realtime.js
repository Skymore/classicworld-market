// One event connection per page; no data polling timer.
// Market events reach subscribers merged: at most one delivery every 3 s, none
// while the page is hidden (one catch-up once it is shown again). A delivery is
// {ids:[…]} when every merged event named its changed items, otherwise {}.
const subscribers=new Set();const collectors=new Set();let stream=null;
const MARKET_GAP_MS=3000,MAX_IDS=200;
let pending=null,lastDelivery=-Infinity,timer=null;
function state(value){
 document.documentElement.dataset.liveConnection=value;
 const en=document.documentElement.lang==='en';
 const label=value==='connected'?(en?'Live connection: updates arrive after upload':'实时连接：上传后自动更新'):(en?'Live connection interrupted; reconnecting':'实时连接中断，正在重连');
 for(const prefs of document.querySelectorAll('.dhead .prefs,.ptop .prefs')){
  let badge=prefs.querySelector('[data-live-status]');
  if(!badge){badge=document.createElement('span');badge.dataset.liveStatus='';badge.className='live-status';badge.textContent='●';prefs.prepend(badge);}
  badge.title=label;badge.setAttribute('aria-label',label);badge.dataset.state=value;
 }
 document.dispatchEvent(new CustomEvent('market-stream',{detail:value}));
}
// {"ids":[…]} names the changed items; anything else means "revalidate everything".
export function marketChange(data){
 try{const value=JSON.parse(data);if(Array.isArray(value?.ids)&&value.ids.length<=MAX_IDS&&value.ids.every(Number.isInteger))return {ids:value.ids};}catch{}
 return {};
}
export function mergeMarketChanges(a,b){
 if(!a)return b;
 if(!a.ids||!b.ids)return {};
 const ids=[...new Set([...a.ids,...b.ids])];
 return ids.length>MAX_IDS?{}:{ids};
}
const hidden=()=>typeof document!=='undefined'&&document.visibilityState==='hidden';
function schedule(){
 if(!pending||timer||hidden())return;
 timer=setTimeout(deliver,Math.max(0,lastDelivery+MARKET_GAP_MS-Date.now()));
}
function deliver(){
 timer=null;
 if(!pending||hidden())return;
 const change=pending;pending=null;lastDelivery=Date.now();
 for(const fn of [...subscribers])fn(change);
}
function received(change){pending=mergeMarketChanges(pending,change);schedule();}
if(typeof document!=='undefined')document.addEventListener('visibilitychange',schedule);
export function subscribeMarket(callback){
 subscribers.add(callback);
 if(!stream && typeof EventSource!=='undefined'){
  stream=new EventSource('/api/v1/events');
  stream.addEventListener('collector',event=>{try{const data=JSON.parse(event.data);for(const fn of [...collectors])fn(data);}catch{}});
  stream.addEventListener('market',event=>received(marketChange(event.data)));
  stream.onerror=()=>state('reconnecting');
  stream.onopen=()=>state('connected');
 }
 return ()=>{subscribers.delete(callback);if(!subscribers.size){stream?.close();stream=null;clearTimeout(timer);timer=null;pending=null;}};
}

export function subscribeCollector(callback){collectors.add(callback);const unsubscribe=subscribeMarket(()=>{});return ()=>{collectors.delete(callback);unsubscribe();};}
