// One event connection per page; no data polling timer.
const subscribers=new Set();const collectors=new Set();let stream=null;
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
export function subscribeMarket(callback){
 subscribers.add(callback);
 if(!stream && typeof EventSource!=='undefined'){
  stream=new EventSource('/api/v1/events');
  stream.addEventListener('collector',event=>{try{const data=JSON.parse(event.data);for(const fn of [...collectors])fn(data);}catch{}});
  stream.addEventListener('market',()=>{for(const fn of [...subscribers])fn();});
  stream.onerror=()=>state('reconnecting');
  stream.onopen=()=>state('connected');
 }
 return ()=>{subscribers.delete(callback);if(!subscribers.size){stream?.close();stream=null;}};
}

export function subscribeCollector(callback){collectors.add(callback);const unsubscribe=subscribeMarket(()=>{});return ()=>{collectors.delete(callback);unsubscribe();};}
