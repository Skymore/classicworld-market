import { userStorage as localStorage } from './user-data.js';
import { lang } from './i18n.js';
// Korean through globalThis.cwmKorean (i18n.js); tests load this file with only `lang`.
const pick=(zh,en)=>lang==='en'?en:lang==='ko'?(globalThis.cwmKorean?.(zh,en)??en):zh;
import {getJson} from './api.js?v=20261022-regressions-1';
const HINT_KEY='market.period-hint.v1', MANUAL_KEY='market.period-manual.v1';
let memoryHint=null;
function stored(key) {try{return localStorage.getItem(key);}catch{return null;}}
function manualPeriod() {
  const params=new URLSearchParams(location.search), q=params.get('hours');
  if((q==='72'||q==='all') && params.get('auto_period')!=='1')return q;
  const saved=stored('market.hours');
  if(saved==='all' || (saved==='72' && stored(MANUAL_KEY)==='1'))return saved;
  return null;
}
function cachedHint() {
  try {const hint=memoryHint || JSON.parse(stored(HINT_KEY));return hint && Date.now()-hint.checkedAt<60000 && ['72','all'].includes(hint.default_hours)?hint:null;}catch{return null;}
}
export function readPeriod() {return manualPeriod() || cachedHint()?.default_hours || '72';}
export async function resolvePeriod() {
  const manual=manualPeriod();if(manual)return manual;
  const cached=cachedHint();if(cached)return cached.default_hours;
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),2000);
  try {
    const {data}=await getJson('/api/v1/market/period-default',{signal:controller.signal,maxAgeMs:60000});
    if(!['72','all'].includes(data.default_hours))return '72';
    memoryHint={...data,checkedAt:Date.now()};
    try{localStorage.setItem(HINT_KEY,JSON.stringify(memoryHint));}catch{}
    return data.default_hours;
  }catch{return '72';}finally{clearTimeout(timeout);}
}
export function automaticPeriod() {return !manualPeriod();}
export function savePeriod(value) {
  if(value==='auto') {
    try{localStorage.removeItem('market.hours');localStorage.removeItem(MANUAL_KEY);}catch{}
    const url=new URL(location.href);url.searchParams.delete('hours');url.searchParams.delete('auto_period');
    history.replaceState(history.state,'',url);return readPeriod();
  }
  const hours=value==='all'?'all':'72';
  try{localStorage.setItem('market.hours',hours);localStorage.setItem(MANUAL_KEY,'1');}catch{}
  const url=new URL(location.href);url.searchParams.set('hours',hours);url.searchParams.delete('auto_period');
  history.replaceState(history.state,'',url);return hours;
}
export function decoratePeriod(select,hours) {
  if(!select)return;
  const auto=automaticPeriod(), hint=cachedHint();
  let autoOption=select.querySelector('option[value="auto"]');
  if(!autoOption){autoOption=document.createElement('option');autoOption.value='auto';select.prepend(autoOption);}
  const suggested=hint?.default_hours;
  autoOption.textContent=suggested?pick(`自动（${suggested==='all'?pick('全部','all'):pick('近 72 小时','72 h')}）`,`Auto (${suggested==='all'?'all':'72 h'})`):pick('自动','Auto');
  select.value=auto?'auto':hours;
  const all=select.querySelector('option[value="all"]');
  if(all)all.textContent=pick('全部','All');
  const recent=select.querySelector('option[value="72"]');
  if(recent)recent.textContent=pick('近 72 小时','72 h');
  select.title=auto && hours==='all' && hint?pick(`近72小时仅 ${hint.recent_priced_items} 件物品有成交价，不足 ${hint.threshold} 件；默认显示全部历史，可手动切回72h。`,`Only ${hint.recent_priced_items} items have sales in 72h (below ${hint.threshold}). Showing all history; you can select 72h manually.`):pick('统计范围','Statistics period');
}
export function periodControl(hours) {
  const auto=automaticPeriod(), all=pick('全部','All'), suggested=cachedHint()?.default_hours;
  const autoLabel=suggested?pick(`自动（${suggested==='all'?pick('全部','all'):pick('近 72 小时','72 h')}）`,`Auto (${suggested==='all'?'all':'72 h'})`):pick('自动','Auto');
  return `<label class="period-control period-inline"><span class="sr">${pick('统计范围','Statistics period')}</span><select data-period aria-label="${pick('统计范围','Statistics period')}"><option value="auto" ${auto?'selected':''}>${autoLabel}</option><option value="72" ${!auto&&hours==='72'?'selected':''}>${pick('近 72 小时','72 h')}</option><option value="all" ${!auto&&hours==='all'?'selected':''}>${all}</option></select></label>`;
}
export function periodLabel(hours) { return hours==='all' ? pick('全部记录','All records') : pick('近 72 小时','Last 72 hours'); }
export function periodProduct(row) {
  if(!Object.hasOwn(row,'sales_window')) return row;
  return {...row,typical:row.typical_window,typical_low:row.typical_window_low,typical_high:row.typical_window_high,
    low_data:row.sales_window<5,typical_basis:'window'};
}
export function inPeriod(time,hours,now=Date.now()/1000) { return hours==='all'||time>=now-72*3600; }
