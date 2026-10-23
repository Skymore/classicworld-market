export const HISTORY_SECONDS=86400, HISTORY_LIMIT=200;
const fields=['id','item_id','name','shop','sell','buy','bundle_cost','bundle','stock','fast_sell','normal_sell','margin','normal_margin','observed','shops','listing_count','listed_quantity','q1','basis','pricing_version'];
export function cleanDeal(row,now){
 if(!row||typeof row.id!=='string'||!row.id||row.id.length>300||!Number.isSafeInteger(row.item_id)||row.item_id<1000000||row.item_id>5999999||!Number.isFinite(row.observed)||row.observed>now+5||now-row.observed>HISTORY_SECONDS)return null;
 const result={};for(const key of fields){const value=row[key];if(typeof value==='string')result[key]=value.slice(0,2000);else if(typeof value==='number'&&Number.isFinite(value))result[key]=value;}
 if(row.location&&Number.isInteger(row.location.channel)&&Number.isInteger(row.location.room))result.location={channel:row.location.channel,room:row.location.room};
 return result;
}
export function mergeHistory(previous,incoming,now){
 const entries=new Map();
 for(const row of [...(Array.isArray(previous)?previous:[]),...(Array.isArray(incoming)?incoming:[])]){const clean=cleanDeal(row,now);if(clean&&(!entries.has(clean.id)||clean.observed>entries.get(clean.id).observed))entries.set(clean.id,clean);}
 return [...entries.values()].sort((a,b)=>b.observed-a.observed).slice(0,HISTORY_LIMIT);
}
const read=(storage,key,fallback)=>{try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;}};
export const profileKey=namespace=>'market.deals.v2:'+namespace;
const bool=(value,fallback)=>typeof value==='boolean'?value:fallback;
export function loadProfile(storage,namespace,now,legacyNamespace=null){
 const saved=read(storage,profileKey(namespace),null);
 const legacy=legacyNamespace?read(storage,'market.alertArchive:'+legacyNamespace,[]):[];
 return {remembered:saved!=null,archive:mergeHistory(legacy,saved?.archive,now),settings:{enabled:bool(saved?.settings?.enabled,bool(legacyNamespace?read(storage,'market.alertsEnabled:'+legacyNamespace,true):true,true)),page:bool(saved?.settings?.page,bool(legacyNamespace?read(storage,'market.pageAlertsEnabled:'+legacyNamespace,true):true,true)),desktop:bool(saved?.settings?.desktop,true)}};
}
export function saveProfile(storage,namespace,profile,now){
 try{storage.setItem(profileKey(namespace),JSON.stringify({archive:mergeHistory(profile.archive,[],now),settings:{enabled:profile.settings.enabled===true,page:profile.settings.page===true,desktop:profile.settings.desktop===true}}));return true;}catch{return false;}
}
export async function tokenNamespace(token){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
 return 'token-'+[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
