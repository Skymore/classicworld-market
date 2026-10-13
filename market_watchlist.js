/* Personal item watches, independent of bargain pricing and equipment filters. */
(() => {
  'use strict';
  const validWatch = item => item && Number.isSafeInteger(item.item_id) && item.item_id>=1000000 && item.item_id<=5999999;
  function notifications(listings,watches,seen,started,now) {
    const selected=new Map(watches.filter(validWatch).map(w=>[w.item_id,w]));
    const fresh=[];
    for(const row of listings) {
      const watch=selected.get(row?.item_id);
      if(!watch||typeof row.id!=='string'||!Number.isFinite(row.unit_price)||row.unit_price<0||!Number.isFinite(row.stock)||row.stock<=0)continue;
      if(watch.max_price!=null&&row.unit_price>watch.max_price)continue;
      if(!Number.isFinite(row.observed)||row.observed>now)continue;
      if(!seen.has(row.id)&&row.observed>=Math.max(started,watch.added_at||0)&&now-row.observed<=120)fresh.push(row);
      seen.set(row.id,now);
    }
    for(const [id,at] of seen)if(now-at>48*3600)seen.delete(id);
    while(seen.size>2000)seen.delete(seen.keys().next().value);
    return fresh;
  }
  const core={validWatch,notifications};
  if(typeof document==='undefined'){globalThis.WatchlistCore=core;return;}
  const panel=document.getElementById('watchPanel');
  if(!panel)return;
  const i18n=window.MarketI18n??{t:x=>String(x??''),apply(){},locale:'zh-CN',name:r=>r.name_zh??String(r.item_id)};
  const $=id=>document.getElementById(id);
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=x=>Number(x).toLocaleString(i18n.locale,{maximumFractionDigits:2});
  const observed=x=>new Date(x*1000).toLocaleString(i18n.locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const key='market.specialWatches.v1',seenKey='market.specialWatchSeen.v1';
  function read(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}}
  function save(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{$('watchStatus').textContent=i18n.t('浏览器无法保存关注列表，请检查存储设置。')}}
  let watches=read(key,[]);if(!Array.isArray(watches))watches=[];
  watches=watches.filter(validWatch).slice(0,100).map(w=>({...w,max_price:Number.isFinite(w.max_price)&&w.max_price>=0?w.max_price:null}));
  const savedSeen=read(seenKey,[]),seen=new Map(Array.isArray(savedSeen)?savedSeen.filter(r=>Array.isArray(r)&&typeof r[0]==='string'&&Number.isFinite(r[1])):[]);
  const started=Date.now()/1000;
  let candidates=[],presets=[],quotes=[],loading=false,pending=false,searchToken=0,searchTimer=null;
  $('watchEnabled').checked=read('market.specialWatchEnabled',true)!==false;
  $('watchEnabled').onchange=()=>save('market.specialWatchEnabled',$('watchEnabled').checked);
  function selectedIDs(){return watches.map(w=>w.item_id).sort((a,b)=>a-b).join(',')}
  function locationText(loc){if(!loc)return i18n.t('位置待识别');return i18n.t(`${loc.channel}频道 · ${loc.room===0?'自由市场入口':loc.room+'洞'}`)}
  function renderItems(force=false){
    if(!force&&$('watchItems').contains(document.activeElement))return;
    $('watchItems').innerHTML=watches.map(w=>`<article class="watch-item"><div><b data-no-i18n>${esc(i18n.name(w))}</b><small data-no-i18n>${esc(i18n.language==='en'?w.name_zh:w.name_en)} · ${w.item_id}${w.level!=null?` · Lv. ${w.level}`:''}</small></div><label>最高单价 <input type="number" min="0" step="any" data-watch-price="${w.item_id}" value="${w.max_price??''}" placeholder="不限" aria-label="最高接受单价"></label><button type="button" data-watch-remove="${w.item_id}">取消关注</button></article>`).join('')||'<p class="muted">还没有特别关注的商品。可搜索添加，或使用弓弩预设。</p>';
    const selected=$('watchMatchItem').value;$('watchMatchItem').innerHTML='<option value="">全部关注商品</option>'+watches.map(w=>`<option value="${w.item_id}" data-no-i18n>${esc(i18n.name(w))}</option>`).join('');if(watches.some(w=>String(w.item_id)===selected))$('watchMatchItem').value=selected;
    i18n.apply(panel);
  }
  function matching(){const selected=new Map(watches.map(w=>[w.item_id,w]));return quotes.filter(r=>selected.has(r.item_id)&&(selected.get(r.item_id).max_price==null||r.unit_price<=selected.get(r.item_id).max_price)).filter(r=>!$('watchMatchItem').value||String(r.item_id)===$('watchMatchItem').value).sort((a,b)=>$('watchSort').value==='low'?a.unit_price-b.unit_price||b.observed-a.observed:b.observed-a.observed)}
  function renderQuotes(){
    const rows=matching();
    $('watchSummary').textContent=i18n.t('关注商品')+` ${watches.length} · `+i18n.t('符合条件的在售观察')+` ${rows.length}`;
    $('watchMatches').innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>商品</th><th>摊位 / 位置</th><th>单位价</th><th>整组价 / 数量</th><th>库存</th><th>装备实际属性</th><th>观察时间</th></tr></thead><tbody>${rows.slice(0,50).map(r=>{const w=watches.find(w=>w.item_id===r.item_id);return `<tr><td><button class="name" data-no-i18n data-watch-open="${r.item_id}">${esc(i18n.name(w))}</button></td><td><span data-no-i18n>${esc(r.shop)}</span><small>${esc(locationText(r.location))}</small></td><td class="price">${number(r.unit_price)}</td><td>${number(r.price)} / ${number(r.bundle)}</td><td>${number(r.stock)}</td><td>${r.equipment?.stats?.length?r.equipment.stats.map(s=>`${esc(i18n.t(s.label))} +${number(s.value)}`).join(' · '):'—'}${r.equipment?.enhancements!=null?`<small>${i18n.t('强化')} +${r.equipment.enhancements} · ${i18n.t('剩余强化')} ${r.equipment.remaining_upgrades??'—'}</small>`:''}</td><td>${observed(r.observed)}</td></tr>`}).join('')}</tbody></table></div>`:'<p class="muted">暂无符合关注条件的在售观察；继续采集或等待共享市场更新。</p>';
    i18n.apply($('watchMatches'));
  }
  function toast(rows){
    if(!$('watchEnabled').checked||!rows.length)return;
    const unique=[...new Map(rows.map(r=>[r.id,r])).values()];
    $('watchToast').innerHTML=`<b>★ ${i18n.t('发现特别关注商品')} (${unique.length})</b>${unique.slice(0,5).map(r=>{const w=watches.find(w=>w.item_id===r.item_id);return `<p><button class="name" data-no-i18n data-watch-open="${r.item_id}">${esc(i18n.name(w))}</button> · ${number(r.unit_price)} / ${i18n.t('件')}<small data-no-i18n>${esc(r.shop)}</small><small>${esc(locationText(r.location))} · ${observed(r.observed)}</small></p>`}).join('')}<button type="button" id="dismissWatch">知道了</button> <a href="/alerts#watchPanel">查看特别关注</a>`;
    $('watchToast').hidden=false;$('dismissWatch').onclick=()=>$('watchToast').hidden=true;i18n.apply($('watchToast'));
  }
  function consume(rows){
    if(!Array.isArray(rows))return;
    const fresh=notifications(rows,watches,seen,started,Date.now()/1000);
    save(seenKey,[...seen]);toast(fresh);
    const current=new Map(quotes.map(r=>[r.listing_key,r]));
    rows.forEach(r=>{if(watches.some(w=>w.item_id===r.item_id)&&(!current.has(r.listing_key)||r.observed>=current.get(r.listing_key).observed))current.set(r.listing_key,r)});
    quotes=[...current.values()];renderQuotes();
  }
  function changed(){save(key,watches);renderItems(true);renderQuotes();window.dispatchEvent(new Event('market-watchlistchange'));refresh()}
  function add(item){if(!validWatch(item)||watches.some(w=>w.item_id===item.item_id))return;if(watches.length>=100){$('watchStatus').textContent=i18n.t('最多关注100种商品。');return}watches.push({item_id:item.item_id,name_zh:item.name_zh,name_en:item.name_en,level:item.level,icon_url:item.icon_url,max_price:null,added_at:Date.now()/1000});changed()}
  function remove(id){watches=watches.filter(w=>w.item_id!==id);changed()}
  async function refresh(){
    if(!watches.length){quotes=[];renderQuotes();return}
    if(loading){pending=true;return}loading=true;
    const ids=selectedIDs();
    try{
      const response=await fetch('/api/v1/watchlist/listings?ids='+encodeURIComponent(ids));
      if(!response.ok)throw Error(response.status);
      const packet=await response.json();if(ids!==selectedIDs()){pending=true;return}
      const newer=quotes.filter(r=>r.observed>packet.generated_at);
      quotes=packet.listings;consume(newer.concat(packet.listings));renderItems();
      $('watchStatus').textContent=i18n.t(packet.truncated?'报价较多，当前显示最近200条观察。':'报价按最新摊位快照更新；请到摊位核对库存与价格。');
    }catch{$('watchStatus').textContent=i18n.t('特别关注暂无法更新，保留上次报价。')}
    finally{loading=false;if(pending){pending=false;refresh()}}
  }
  async function search(query=''){
    const token=++searchToken;
    try{const response=await fetch('/api/v1/watchlist/catalog?q='+encodeURIComponent(query));if(!response.ok)throw Error(response.status);const result=await response.json();if(token!==searchToken)return;candidates=result.items;presets=result.presets;$('watchCandidates').innerHTML=candidates.map(w=>`<option value="${esc(`${i18n.name(w)} · ${w.item_id}`)}"></option>`).join('');$('watchArcherPreset').disabled=!presets[0]?.items?.length;}
    catch{$('watchStatus').textContent=i18n.t('图鉴搜索暂不可用，可从商品列表添加关注。')}
  }
  $('watchSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>search($('watchSearch').value.split(' · ')[0]),250)};
  $('watchAddForm').onsubmit=e=>{e.preventDefault();const value=$('watchSearch').value;const matched=candidates.filter(w=>value===`${i18n.name(w)} · ${w.item_id}`||value===String(w.item_id));if(matched.length!==1){$('watchStatus').textContent=i18n.t('请从搜索建议中选择具体商品。');return}add(matched[0]);$('watchSearch').value=''};
  $('watchArcherPreset').onclick=()=>{for(const item of presets[0]?.items??[])add(item)};
  $('watchItems').onclick=e=>{const id=e.target.closest('[data-watch-remove]')?.dataset.watchRemove;if(id)remove(Number(id))};
  $('watchItems').onchange=e=>{const id=e.target.dataset.watchPrice;if(!id)return;const w=watches.find(w=>w.item_id===Number(id));const value=e.target.value.trim();if(value!==''&&(!Number.isFinite(Number(value))||Number(value)<0))return;w.max_price=value===''?null:Number(value);changed()};
  function openItem(e){const id=e.target.closest('[data-watch-open]')?.dataset.watchOpen;if(id)window.dispatchEvent(new CustomEvent('market-openitem',{detail:Number(id)}))}
  $('watchMatchItem').onchange=renderQuotes;$('watchSort').onchange=renderQuotes;
  $('watchMatches').onclick=openItem;$('watchToast').onclick=openItem;
  window.MarketWatchlist={has:id=>watches.some(w=>w.item_id===id),toggle:item=>watches.some(w=>w.item_id===item.item_id)?remove(item.item_id):add(item),consume};
  window.addEventListener('market-languagechange',()=>{renderItems();renderQuotes();search($('watchSearch').value.split(' · ')[0]);i18n.apply(panel)});
  renderItems();renderQuotes();search();refresh();setInterval(refresh,15000);
})();
