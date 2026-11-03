import { subscribeMarket } from './realtime.js?v=20261022-regressions-1';
// JSON client for /api/v1. Keeps the last ETag per URL and sends
// If-None-Match so unchanged data costs a 304 (plan v1 搂8.5: <100 KB/min idle).
// Responses the browser may keep (Cache-Control no-cache/max-age, not no-store)
// revalidate through the HTTP cache instead, which also serves the next visit.
const cache = new Map(); // url -> { etag, data, checkedAt, browser }
const browserCached = (res) => {
  const control = (res.headers.get('Cache-Control') || '').toLowerCase();
  return Boolean(res.headers.get('ETag')) && !control.includes('no-store') && /no-cache|max-age/.test(control);
};

// Public server-rendered snapshots can revalidate on the initial SSE event too.
export function seedJson(url, data, etag, checkedAt = Date.now()) {
  if (typeof etag === 'string') cache.set(url, { data, etag, checkedAt });
}

export class ApiError extends Error {
  constructor(status, url) {
    super(`${status} ${url}`);
    this.status = status;
  }
}

export async function getJson(url, { signal, maxAgeMs = 0, headers: extraHeaders = {} } = {}) {
  const personal=(String(url).includes('/api/v1/collector/')||String(url).includes('/api/v1/account'))||Boolean(extraHeaders.Authorization);
  const hit = personal?null:cache.get(url);
  if(signal?.aborted) throw signal.reason || new DOMException('Aborted','AbortError');
  if(hit && maxAgeMs>0 && Date.now()-hit.checkedAt<=maxAgeMs) return {data:hit.data,changed:false};
  const headers = { ...extraHeaders, Accept: 'application/json' };
  if (hit?.etag && !hit.browser) headers['If-None-Match'] = hit.etag;
  const res = await fetch(url, { headers, signal, credentials: 'same-origin', cache: 'no-cache' });
  if (res.status === 304 && hit) { hit.checkedAt=Date.now(); return { data: hit.data, changed: false }; }
  if (!res.ok) throw new ApiError(res.status, url);
  const etag = res.headers.get('ETag');
  // The browser answered its own revalidation from cache: same version, nothing to parse.
  if (hit?.browser && etag && etag === hit.etag) { hit.checkedAt=Date.now(); res.body?.cancel().catch(() => {}); return { data: hit.data, changed: false }; }
  const data = await res.json();
  if(!personal)cache.set(url, { etag, data, checkedAt:Date.now(), browser: browserCached(res) });
  return { data, changed: true };
}

export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new ApiError(res.status, url);
  return res.json();
}

// Initial snapshot, then committed-change events. Busy requests coalesce events
// into one trailing refresh; reconnect's initial event reconciles missed updates.
export function live(url,onData,{onError,notifyUnchanged=false,timeoutMs=10000,retryBaseMs=500,headers={}}={}) {
 let stopped=false,busy=false,pending=false,delivered=false,controller=null,retryTimer=null,failures=0,settle;
 const first=new Promise(resolve=>settle=resolve);
 const tick=async()=>{
  if(stopped)return;
  if(busy){pending=true;return;}
  clearTimeout(retryTimer);
  busy=true;controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(new DOMException('Request timed out','TimeoutError')),timeoutMs);
  try{
   const {data,changed}=await getJson(url,{signal:controller.signal,headers});
   if(!stopped&&(changed||!delivered||notifyUnchanged)){await onData(data);delivered=true;}
   failures=0;
  }catch(error){if(!stopped){
   delivered=false;onError?.(error);
   // Retry failed requests only; idle healthy pages never query on a timer.
   retryTimer=setTimeout(tick,Math.min(15000,retryBaseMs*2**Math.min(failures++,5)));
  }}
  finally{clearTimeout(deadline);busy=false;settle();if(pending&&!stopped){pending=false;tick();}}
 };
 const unsubscribe=subscribeMarket(tick);
 const onVisible=()=>{if(document.visibilityState==='visible')tick();};
 document.addEventListener('visibilitychange',onVisible);
 const cached=cache.get(url);
 if(cached && Date.now()-cached.checkedAt<=30000)queueMicrotask(()=>{
  if(!stopped&&!delivered){delivered=true;onData(cached.data);settle();}
 });
 tick();
 const stop=()=>{stopped=true;clearTimeout(retryTimer);controller?.abort();unsubscribe();document.removeEventListener('visibilitychange',onVisible);settle();};
 stop.first=first;return stop;
}
// Compatibility for older page modules. This alias does not start a timer.
export const poll=live;

// Endpoints the pages share. Keep in one place so a path change is one edit.
export const api = {
  list: (hours = '72') => `/api/v1/market?view=list${hours ? `&hours=${hours}` : ''}`,
  item: (id) => `/api/v1/item/${id}`,
  itemRecord: (id) => `/api/v1/items/${id}`,
  recentSales: (params = {}) => `/api/v1/sales/recent${qs(params)}`,
  dexCounts: () => '/api/v1/dex/counts',
  watchCatalog: () => '/api/v1/watchlist/catalog',
  watchListings: (params = {}) => `/api/v1/watchlist/listings${qs(params)}`,
  droppedItems: () => '/api/v1/dex/dropped-items',
};

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
