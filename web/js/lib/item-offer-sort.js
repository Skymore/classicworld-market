import { compareQuotes } from './quote-order.js?v=20261023-item-sort-2';

// Retain the original group and room labels when rows move into a global
// chronological list. A realtime section replacement gets its own fresh state.
const sections=new WeakMap();
export function applyOfferSort(stall,mode){
 const section=stall.querySelector('.where-well');if(!section)return;
 const select=section.querySelector('[data-offer-sort]');if(select)select.value=mode;
 let saved=sections.get(section);
 if(!saved){
  const groups=[...section.querySelectorAll('.cgroup')].map(el=>({el,key:el.dataset.chKey,
   rows:[...(el.querySelector('.cg-list')?.children||[])].filter(row=>row.matches('.listing-offer,.lrow')).map(row=>({el:row,room:row.querySelector('.lroom')?.textContent||''}))}));
  const flat=document.createElement('div');flat.className='recent-offers';flat.hidden=true;
  if(groups[0])section.insertBefore(flat,groups[0].el);else section.append(flat);
  saved={groups,flat};sections.set(section,saved);
 }
 // Keep compatibility with already-cached HTML from before common quote
 // metadata was added to non-equipment rows.
 const entry=row=>{
  const shown=row.querySelector('.lp')?.textContent.trim().replaceAll(',','')||'';
  const match=shown.match(/^([\d.]+)\s*([KMB])?$/i);
  const legacyPrice=match?Number(match[1])*({K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]||1):Infinity;
  return {observed:Number(row.dataset.observed||row.querySelector('[data-relative-time]')?.dataset.relativeTime)||null,
   price:row.hasAttribute('data-unit-price')?Number(row.dataset.unitPrice):legacyPrice,
   key:row.dataset.quote||row.dataset.offer||row.querySelector('.lshop')?.textContent};
 };
 // If markup changes again, preserve the original visible offers rather than
 // hiding populated groups behind an empty chronological list.
 const latest=mode==='recent'&&saved.groups.some(group=>group.rows.length);
 if(mode==='recent'&&!latest&&select)select.value='price';
 const groups=saved.groups.map(group=>{
  group.rows.sort((a,b)=>compareQuotes(entry(a.el),entry(b.el),latest));
  const list=group.el.querySelector('.cg-list');
  for(const row of group.rows){
   list.append(row.el);
   const room=row.el.querySelector('.lroom');if(room)room.textContent=row.room;
  }
  const fresh=group.rows.filter(row=>!row.el.classList.contains('stale'));
  return {...group,observed:Math.max(0,...group.rows.map(row=>entry(row.el).observed||0)),
   price:Math.min(...(fresh.length?fresh:group.rows).map(row=>entry(row.el).price))};
 });
 groups.sort((a,b)=>!latest&&((a.key==='unknown')!==(b.key==='unknown'))?(a.key==='unknown'?1:-1):compareQuotes(a,b,latest));
 const before=section.querySelector(':scope > [data-more]');
 groups.forEach((group,index)=>{
  section.insertBefore(group.el,before);group.el.hidden=latest;
  group.el.classList.toggle('xp',index>=6);group.el.classList.toggle('xd',index>=8);
 });
 saved.flat.hidden=!latest;
 section.classList.toggle('recent-order',latest);
 const legend=section.querySelector('.legend');if(legend)legend.hidden=latest;
 for(const more of section.querySelectorAll(':scope > [data-more]'))more.hidden=latest;
 if(latest){
  const en=document.documentElement.lang==='en';
  const rows=groups.flatMap(group=>group.rows.map(row=>({...row,channel:group.key})));
  rows.sort((a,b)=>compareQuotes(entry(a.el),entry(b.el),true));
  for(const row of rows){
   const room=row.el.querySelector('.lroom');
   if(room)room.textContent=(row.channel==='unknown'?(en?'Channel ?':'频道未知'):'CH '+row.channel)+' · '+row.room;
   saved.flat.append(row.el);
  }
 }
}
