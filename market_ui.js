let data=null,category='全部',page=0,detailToken=0,currentItemId=null;const pageSize=30,$=id=>document.getElementById(id);
const I18n=window.MarketI18n??{language:'zh',locale:'zh-CN',t:x=>String(x??''),apply(){},name:r=>r.name_zh??r.name??String(r.item_id)};
if(!window.MarketI18n){const note=document.createElement('p');note.className='source';note.setAttribute('role','alert');note.textContent='语言切换暂不可用，行情以中文显示。请刷新网页。 / Language switching is unavailable; showing Chinese. Please refresh.';document.querySelector('main').prepend(note)}
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=x=>x==null?'—':Number(x).toLocaleString(I18n.locale,{maximumFractionDigits:2});
const date=x=>new Date(x*1000).toLocaleString(I18n.locale,{timeZone:'America/Chicago',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const windowQuery=()=>encodeURIComponent($('quoteWindow').value);
const windowLabel=()=>data?.hours==null?'全部':'近'+data.hours+'h';
const safeUrl=x=>{try{let u=new URL(x);return u.protocol==='https:'?u.href:''}catch{return ''}};
function icon(r){let u=safeUrl(r.icon_url);return `<span class="icon">${u?`<img loading="lazy" referrerpolicy="no-referrer" src="${esc(u)}" alt="${esc(I18n.name(r))} ${I18n.t('图标')}">`:'?'}</span>`}
document.addEventListener('error',e=>{if(e.target.tagName==='IMG')e.target.classList.add('failed')},true);
function locationText(x){return I18n.t(x?`${x.channel}频道 · ${x.room===0?'自由市场入口':x.room+'洞'}${x.validation==='capture_layout_pending_live_check'?'（待实测核对）':''}`:'位置待识别')}
function equipmentText(e){if(!e||e.status==='unsupported')return '<small>此格式暂未解析</small>';return `<div class="equip-stats">${e.stats.map(s=>`<span>${esc(s.label)} <b>+${num(s.value)}</b></span>`).join('')}${e.enhancements!=null?`<span>强化 <b>+${e.enhancements}</b></span>`:''}<span>剩余强化 <b>${e.remaining_upgrades??'未解析'}</b></span></div>${(e.unknown_fields||[]).length?`<small>${e.unknown_fields.length} 个扩展字段未解析</small>`:''}`}
function matchesJob(r){let j=$('job').value,v=r.jobs||[];return category!=='装备'||!j||(r.category==='装备'&&(j==='未知'?!v.length:(v.includes(j)||(j!=='通用'&&v.includes('通用')))))}
function meta(r){return `<small data-no-i18n>${esc(I18n.language==='en'?r.name_zh:r.name_en)} · ${r.item_id}</small>`}
function render(){if(!data)return;['job','minLevel','maxLevel'].forEach(id=>{$(id).hidden=category!=='装备';$(id).disabled=category!=='装备'});let q=$('search').value.trim().toLowerCase(),min=$('minLevel').value,max=$('maxLevel').value;
let products=data.products.filter(r=>(category==='全部'||r.category===category)&&matchesJob(r)&&(!$('subtype').value||r.subcategory===$('subtype').value)&&(!q||[r.name_zh,r.name_en,r.item_id].join(' ').toLowerCase().includes(q))&&(category!=='装备'||min===''||(r.level!=null&&r.level>=Number(min)))&&(category!=='装备'||max===''||(r.level!=null&&r.level<=Number(max)))&&(!$('inStock').checked||r.listings>0));
products.sort((a,b)=>{switch($('sort').value){case 'low':return(a.low??Infinity)-(b.low??Infinity);case 'shops':return b.shops-a.shops;case 'level':return(a.level??Infinity)-(b.level??Infinity);case 'name':return I18n.name(a).localeCompare(I18n.name(b),I18n.locale);default:return b.last_seen-a.last_seen}});
page=Math.min(page,Math.max(0,Math.ceil(products.length/pageSize)-1));let slice=products.slice(page*pageSize,(page+1)*pageSize);
$('rows').innerHTML=slice.map(r=>`<tr><td><div class="product">${icon(r)}<div><button class="name" data-no-i18n data-item="${r.item_id}">${esc(I18n.name(r))}</button>${meta(r)}<button class="watch-toggle" data-watch-toggle="${r.item_id}" aria-pressed="${!!window.MarketWatchlist?.has(r.item_id)}">${window.MarketWatchlist?.has(r.item_id)?'★ 已关注':'☆ 特别关注'}</button>${r.category==='装备'?`<small>${r.variant_count??r.variants?.length??0} 个在售装备记录 · 区间仅供参考</small>`:''}</div></div></td><td>${r.category==='装备'?`Lv. ${r.level??'?'}`:'—'}<small>${esc(r.subcategory)}${r.jobs?.length?` · ${esc(r.jobs.map(I18n.t).join(" / "))}`:""}</small></td><td><span class="price">${num(r.low)}</span><small>${r.listings?windowLabel()+'单位报价':'暂无有效报价'}</small></td><td>${num(r.median)}<small>最高 ${num(r.high)}</small></td><td><span class="price">快卖 ${num(r.recommendation?.fast_price)}</span><small>正常卖 ${num(r.recommendation?.normal_price)}</small><small>${esc(r.recommendation?.label||'待统计')}</small><button class="name" data-item="${r.item_id}">查看依据</button></td><td>${r.shops}<small>${r.listings} 条挂单</small></td><td>${num(r.sold_out_median)}<small>${r.sold_out_count} 条售罄记录</small></td><td>${date(r.last_seen)}<small>美中时间</small></td></tr>`).join('')||'<tr><td colspan="8" class="empty">暂无匹配商品。调整筛选，或手动打开更多摊位。</td></tr>';
$('resultCount').textContent=products.length;$('pageInfo').textContent=`第 ${page+1} / ${Math.max(1,Math.ceil(products.length/pageSize))} 页 · 每页 ${pageSize} 件商品`;$('prev').disabled=page===0;$('next').disabled=(page+1)*pageSize>=products.length;
document.querySelectorAll('[data-window-label]').forEach(el=>el.textContent=windowLabel());$('metricItems').textContent=data.products.length;$('metricQuotes').textContent=num(data.products.reduce((n,r)=>n+r.listings,0));$('metricShops').textContent=data.active_shops;$('metricSales').textContent=data.products.reduce((n,r)=>n+r.sold_out_count,0);
$('status').textContent=I18n.t(data.connection_health?.message||'正在检测连接状态…');$('status').style.color=data.connection_health?.state==='ready'?'#23705c':'#947032';if(!data.shared)$('status').textContent+=' · '+(data.connection_health?.location?locationText(data.connection_health.location):(data.capture?.fresh&&data.capture.sessions?.length===1?locationText(data.capture.sessions[0].location):I18n.t('位置待识别')));$('updated').textContent=`更新 ${date(data.generated_at)} · ${pushConnected?"实时推送":"每2秒检查更新"}`;
$('coverage').textContent=`已保留 ${data.manual_visits} 次手动访问、${data.manual_observations} 条商品观察。另有 ${data.experimental_visits} 次旧主动实验，已排除统计。`;if(data.shared){const sellingLink=document.querySelector('a[href="/selling"]');if(sellingLink)sellingLink.hidden=true;$('coverage').textContent=`共享观察 ${data.manual_visits} 次 · ${data.dedup_note}`;if(data.public_read){$('coverage').textContent='公开市场 · 采集端使用独立随机 ID · '+data.dedup_note}else if(!$('sharedLogout')){let b=document.createElement('button');b.id='sharedLogout';b.textContent='退出登录';b.onclick=async()=>{await fetch('/api/v1/logout',{method:'POST'});location.replace('/')};document.querySelector('header').appendChild(b)}}$('errors').textContent=data.health?.errors.length?' · 数据处理异常，请查看日志':'';
I18n.apply();
}
function subtypes(){let old=$('subtype').value,values=[...new Set(data.products.filter(r=>category==='全部'||r.category===category).map(r=>r.subcategory))].sort();$('subtype').innerHTML='<option value="">全部部位 / 子分类</option>'+values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if(values.includes(old))$('subtype').value=old;I18n.apply($('subtype'))}
let loading=false,pendingLoad=false,eventStream=null,pushConnected=false;const alertStart=Date.now()/1000,seenDeals=new Map();
function dealName(deal){const item=data?.products.find(p=>p.item_id===deal.item_id);return item?I18n.name(item):deal.name}
function cleanAlertCopy(text){return String(text||'').replace(/[，,]非保证利润[。.]?/g,'').replace(/[；;]参考卖价不能保证成交[。.]?/g,'。')}
let alertNamespace='';
function readAlertStorage(key,fallback){try{return JSON.parse(localStorage.getItem(alertNamespace?key+':'+alertNamespace:key))??fallback}catch{return fallback}}
function writeAlertStorage(key,value){try{localStorage.setItem(alertNamespace?key+':'+alertNamespace:key,JSON.stringify(value))}catch{}}
let alertArchive=readAlertStorage('market.alertArchive',[]);
$('alertsEnabled').checked=readAlertStorage('market.alertsEnabled',true);
$('pageAlertsEnabled').checked=readAlertStorage('market.pageAlertsEnabled',true);
$('alertsEnabled').onchange=()=>writeAlertStorage('market.alertsEnabled',$('alertsEnabled').checked);
$('pageAlertsEnabled').onchange=()=>writeAlertStorage('market.pageAlertsEnabled',$('pageAlertsEnabled').checked);
$('alertView').onchange=()=>renderOpportunities();
function renderOpportunities(){
 if(data.shared&&!data.personal_alerts){$('opportunities').innerHTML='<p>个人低价提醒请运行新版采集器，启动后会自动打开本机提醒页。只对你新采集到的商品提醒，使用共享报价作比较。</p>';I18n.apply($('opportunities'));return}
 const now=Date.now(),alerts=(data.opportunities||[]).filter(a=>now/1000-a.observed<=120);
 const merged=new Map(readAlertStorage('market.alertArchive',alertArchive).map(a=>[a.id,a]));
 alerts.forEach(a=>merged.set(a.id,a));
 alertArchive=[...merged.values()].filter(a=>now/1000-a.observed<86400).sort((a,b)=>b.observed-a.observed).slice(0,200);
 writeAlertStorage('market.alertArchive',alertArchive);
 const shown=$('alertView').value==='live'?alerts:alertArchive;
 $('alertSummary').textContent=`当前 ${alerts.length} 条 · 最近记录 ${alertArchive.length} 条（此浏览器保留24小时，最多200条）`;
 $('opportunities').innerHTML=shown.map(a=>`<div class="deal"><b>${esc(dealName(a))}</b> · ${esc(a.shop)} · ${esc(locationText(a.location))}<p class="${now/1000-a.observed>120?'stale':'source'}">${date(a.observed)} · ${now/1000-a.observed>120?'历史发现，请重新开摊确认库存和价格':'最近发现'}</p><p>买价 ${num(a.buy)}/件（每组 ${num(a.bundle_cost)}，${num(a.bundle)}件） · Q1 ${num(a.q1)} · ${a.pricing_version===2?`快卖 ${num(a.fast_sell)} / 正常卖 ${num(a.normal_sell)} · <span class="deal-returns">扣费后收益率：快卖 +${num(a.margin)}% / 正常卖 +${num(a.normal_margin)}%</span><small>每件价差：快卖 +${num(a.profit)} / 正常卖 +${num(a.normal_profit)}</small>`:`旧版参考卖价 ${num(a.sell)} · 收益率 +${num(a.margin)}%<small>价差 +${num(a.profit)}/件</small>`}</p><small>${a.shops}个报价摊位 · ${num(a.listing_count)}条在售挂单 · 库存合计 ${num(a.listed_quantity)}。${esc(I18n.t(cleanAlertCopy(a.basis)))}</small><button data-deal-item="${a.item_id}">查看商品依据</button></div>`).join('')||'<p>暂无符合条件的商品。保持网页打开，继续手动逛摊即可。</p>';
 I18n.apply();
 if(!$('alertsEnabled').checked)return;
 const seen=readAlertStorage('market.alertSeen',{});
 const fresh=alerts.filter(a=>a.observed>=alertStart&&now-(seen[a.id]||0)>1800000);
 if(!fresh.length)return;
 fresh.forEach(a=>seen[a.id]=now);
 writeAlertStorage('market.alertSeen',Object.fromEntries(Object.entries(seen).filter(([,t])=>now-t<1800000)));
 const a=fresh[0];
 if($('pageAlertsEnabled').checked){
  const rows=fresh.map(deal=>{
   const product=data.products.find(p=>p.item_id===deal.item_id)||{name_zh:deal.name};
   return `<tr><td><div class="toast-product">${icon(product)}<button class="name" data-toast-item="${deal.item_id}">${esc(dealName(deal))}</button></div></td><td class="toast-shop">${esc(deal.shop)}<small>${esc(locationText(deal.location))}</small></td><td>${num(deal.buy)}<small>每组 ${num(deal.bundle_cost)} / ${num(deal.bundle)}件</small></td><td>快卖 ${num(deal.fast_sell)}<small>正常卖 ${num(deal.normal_sell)}</small></td><td class="toast-profit"><span class="deal-returns">快卖 +${num(deal.margin)}%</span><span class="deal-returns">正常卖 +${num(deal.normal_margin)}%</span><small>价差 +${num(deal.profit)} / +${num(deal.normal_profit)} 每件</small></td><td>Q1 ${num(deal.q1)}<small>${num(deal.shops)} 个在售摊位</small></td></tr>`
  }).join('');
  $('dealToast').innerHTML=`<b>发现 ${fresh.length} 件低价商品</b><div class="toast-table-wrap"><table aria-label="低价商品提醒"><thead><tr><th>商品</th><th>商店名 / 位置</th><th>买价 / 件</th><th>参考卖价 / 件</th><th>扣3%后收益率</th><th>比较依据</th></tr></thead><tbody>${rows}</tbody></table></div><div class="toast-actions"><button id="viewDealDetails" class="toast-primary">查看详情</button><a class="toast-secondary" href="/alerts">全部提醒</a><button id="dismissDeal" class="toast-dismiss">知道了</button></div>`;
  I18n.apply($('dealToast'));
  $('dealToast').hidden=false;
  $('dismissDeal').onclick=()=>$('dealToast').hidden=true;
  $('viewDealDetails').onclick=()=>{$('dealToast').hidden=true;showItem(a.item_id)};
  $('dealToast').onclick=e=>{const button=e.target.closest('[data-toast-item]');if(button){$('dealToast').hidden=true;showItem(Number(button.dataset.toastItem))}};
 }

}
$('opportunities').onclick=e=>{let b=e.target.closest('[data-deal-item]');if(b)showItem(Number(b.dataset.dealItem))};
function connectRealtime(){
 if(!data?.realtime||eventStream||!('EventSource' in window))return;
 eventStream=new EventSource('/api/v1/events');
 eventStream.onopen=()=>{pushConnected=true;render()};
 eventStream.addEventListener('market',()=>load());
 eventStream.addEventListener('deals',event=>{if(!data||data.shared)return;try{const packet=JSON.parse(event.data);window.MarketWatchlist?.consume(packet.watch_listings);const deals=packet.windows[$('quoteWindow').value]||[];data.opportunities=[...deals,...(data.opportunities||[]).filter(old=>!deals.some(fresh=>fresh.id===old.id))];renderOpportunities()}catch(error){console.warn('Deal update failed',error)}});
 eventStream.onerror=()=>{pushConnected=false;render()};
}
async function load(){if(loading){pendingLoad=true;return}loading=true;try{let response=await fetch('/api/v1/market?summary=1&hours='+windowQuery());if(response.status===401){location.replace('/');return}if(!response.ok)throw Error(response.status);data=await response.json();const namespace=data.alert_namespace||'';if(namespace!==alertNamespace){alertNamespace=namespace;alertArchive=readAlertStorage('market.alertArchive',[]);$('alertsEnabled').checked=readAlertStorage('market.alertsEnabled',true);$('pageAlertsEnabled').checked=readAlertStorage('market.pageAlertsEnabled',true)}connectRealtime();subtypes();render();renderOpportunities()}catch(e){$('status').textContent=I18n.t('本地服务暂未连接；正在等待恢复')}finally{loading=false;if(pendingLoad){pendingLoad=false;setTimeout(load,0)}}}
function kv(pairs){return '<div class="kv">'+pairs.map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v??'未提供')}</b></div>`).join('')+'</div>'}
function job(mask){if(mask==null)return '未提供';if(mask===0)return '全职业';if(mask===-1)return '初心者';return [[1,'战士'],[2,'魔法师'],[4,'弓箭手'],[8,'飞侠'],[16,'海盗']].filter(([b])=>mask&b).map(([,s])=>s).join(' / ')||`职业代码 ${mask}`}
const statLabels={incSTR:'力量',incDEX:'敏捷',incINT:'智力',incLUK:'运气',incPAD:'物理攻击',incMAD:'魔法攻击',incPDD:'物理防御',incMDD:'魔法防御',incACC:'命中',incEVA:'回避',incMHP:'HP',incMMP:'MP',incSpeed:'移动速度',incJump:'跳跃',tuc:'基础升级次数',attackSpeed:'攻击速度代码',success:'成功率（%）'};
function chart(history){let groups=new Map();history.filter(r=>!r.experimental&&r.stock>0&&r.unit_price!=null).forEach(r=>{let k=r.time;groups.set(k,Math.min(groups.get(k)??Infinity,r.unit_price))});let pts=[...groups].sort((a,b)=>a[0]-b[0]);if(pts.length<2)return '<p class="muted">至少两次有效报价观察后显示趋势。每个时间点取当次观察的最低价。</p>';let lo=Math.min(...pts.map(p=>p[1])),hi=Math.max(...pts.map(p=>p[1])),t0=pts[0][0],t1=pts.at(-1)[0];let points=pts.map(([t,p])=>`${20+(t-t0)/(t1-t0||1)*620},${90-(p-lo)/(hi-lo||1)*65}`).join(' ');return `<svg class="plot" viewBox="0 0 660 115" role="img" aria-label="观察报价趋势"><path d="M20 95H640" stroke="#dbe6d9"/><polyline points="${points}" fill="none" stroke="#34866b" stroke-width="2.5"/><text x="20" y="12">最高 ${num(hi)}</text><text x="20" y="110">最低 ${num(lo)}</text></svg><div class="plot-labels"><span>${date(t0)}</span><span>${date(t1)}</span></div>`}
async function showItem(id){currentItemId=id;let r=data.products.find(r=>r.item_id===id);if(!r)return;let token=++detailToken;let history=[];$('detailBody').textContent=I18n.t('正在读取本地图鉴…');if(!$('detail').open)$('detail').showModal();let cat=null;try{let [response,market]=await Promise.all([fetch('/api/v1/items/'+id),fetch('/api/v1/market?item_id='+id+'&hours='+windowQuery())]);if(response.ok)cat=await response.json();if(!market.ok)throw Error(market.status);let detail=await market.json();r=detail.products[0]||r;history=detail.history.filter(x=>!x.experimental)}catch{if(token===detailToken)$('detailBody').textContent=I18n.t('详情加载失败，请重新打开。');return}if(token!==detailToken)return;
let ref=cat?.mapledex_reference,rd=ref?.data||{},req=cat?.requirements||{};let base=cat?.base_stats||[];
let quotes=[...r.quotes].sort((a,b)=>a.unit_price-b.unit_price);
$('detailBody').innerHTML=`<div class="detail-title">${icon(r)}<div><h2 data-no-i18n>${esc(I18n.name(r))}</h2><p data-no-i18n>${esc(I18n.language==='en'?r.name_zh:r.name_en)} · ID ${id}</p><span class="tag">${esc(I18n.t(r.category))} / ${esc(I18n.t(r.subcategory))}${r.jobs?.length?` · ${esc(r.jobs.map(I18n.t).join(" / "))}`:""}</span> ${r.category==='装备'?`<span class="tag">Lv. ${r.level??'?'}</span>`:''}</div></div>
<div class="detail-prices"><div class="panel"><span>最低摆摊报价 / 件</span><strong>${num(r.low)}</strong></div><div class="panel"><span>摆摊中位价 / 件</span><strong>${num(r.median)}</strong></div><div class="panel"><span>售罄价 / 件</span><strong>${num(r.sold_out_median)}</strong></div></div>
<div class="panel"><h3>建议售价 / 件：快卖 ${num(r.recommendation?.fast_price)} · 正常卖 ${num(r.recommendation?.normal_price)}</h3><p>${esc(I18n.t(r.recommendation?.label))} · ${esc(I18n.t(r.recommendation?.confidence))}</p><ul>${(r.recommendation?.basis||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
<div class="panel"><h3>报价观察趋势</h3>${chart(history)}<p class="source">各次访问的观察值，并非全市场同一时刻最低价。${r.category==='装备'?'包含不同属性装备，仅供粗略参考。':''}</p></div>
<div class="detail-grid"><div class="panel"><h3>图鉴基础信息 · DVG 快照</h3>${cat?kv([['需求等级',cat.level],['部位',cat.category],['力量要求',req.str],['敏捷要求',req.dex],['智力要求',req.int],['运气要求',req.luk],['可交易',cat.tradeable==null?'未提供':cat.tradeable?'是':'否'],['商城物品',cat.cash?'是':'否'],['NPC 参考价',cat.npc_price]]):'<p>本地图鉴暂无此物品。</p>'}${base.length?'<h3 style="margin-top:20px">基础属性</h3>'+kv(base.map(s=>[s.label,s.value])):'<p class="muted">此来源未提供额外基础属性。</p>'}<p>${esc(cat?.description_zh||'').replace(/\\n/g,'<br>')}</p><p class="source">${esc(cat?.source_version||'来源缺失')} ${safeUrl(cat?.name_source)?`<a href="${esc(safeUrl(cat.name_source))}" target="_blank" rel="noreferrer">查看来源 ↗</a>`:''}</p></div>
<div class="panel"><h3>另一版本参考 · Mapledex CoT2</h3>${ref?kv([['职业限制',job(rd.reqJob)],['需求等级',rd.reqLevel],['装备类型',rd.slot],...Object.entries(statLabels).filter(([k])=>rd[k]!=null).map(([k,l])=>[l,rd[k]])]):'<p class="muted">暂无对应参考。</p>'}<p class="source">${esc(ref?.version||'')}。此栏单独保留旧测试版本数据，不与左侧拼成同一套属性。</p><h3 style="margin-top:24px">摊位装备实际属性</h3><p>${r.category==='装备'?'下方每条报价展示包内属性与剩余强化次数。已解析字段直接展示，未识别的扩展字段单独标注。图鉴基础值不用于填充缺失属性。':'普通物品报价按每组数量折算为单位价格。'}</p></div></div>
<div class="panel"><h3>当前摊位报价 <span class="muted" id="quoteCount"></span></h3><label><input type="checkbox" id="showUnknownLocation"> 显示位置待识别</label><p class="source" id="quoteHiddenCount"></p><div class="listing-scroll"><table><thead><tr><th>摊位 / 位置</th><th>单位价</th><th>整组价 / 数量</th><th>库存</th>${r.category==='装备'?'<th>装备实际属性</th>':''}<th>观察时间</th></tr></thead><tbody id="quoteRows"></tbody></table></div></div>
<div class="panel"><h3>售罄记录</h3><p class="source">售罄价为售罄记录的单位价中位数；采用此前摆摊价，实际成交数量未知。</p><div class="listing-scroll"><table><thead><tr><th>摊位</th><th>售罄单价</th><th>发现售光时间</th></tr></thead><tbody>${r.sales.map(x=>`<tr><td>${esc(x.shop)}<small>${esc(locationText(x.location))}</small></td><td>${num(x.sale_unit_price)}</td><td>${date(x.time)}</td></tr>`).join('')||'<tr><td colspan="3">暂无售罄记录。</td></tr>'}</tbody></table></div></div>
${r.category==='装备'?`<details class="panel"><summary>历史装备属性 · ${history.length} 条观察</summary><div class="listing-scroll"><table><thead><tr><th>摊位 / 时间</th><th>单位价</th><th>装备实际属性</th></tr></thead><tbody>${[...history].reverse().map(x=>`<tr><td>${esc(x.shop)}<small>${date(x.time)} · ${esc(locationText(x.location))}</small></td><td>${num(x.unit_price)}</td><td>${equipmentText(x.equipment)}</td></tr>`).join('')}</tbody></table></div></details>`:''}
<details class="panel"><summary>原始依据 · ${history.length} 条商品观察（点击展开）</summary><p class="source">${data.shared?'下方为共享的结构化观察；网络原文仅保存在采集者本机。':'完整原始文件保存在本机；下方列出观察记录和文件引用。'}</p><pre>${esc(JSON.stringify(history,null,2))}</pre></details>`;
function renderQuotes(){
 const visible=quotes.filter(x=>$('showUnknownLocation').checked||x.location!=null);
 $('quoteCount').textContent=`${visible.length} 条 · ${new Set(visible.map(x=>x.shop_key)).size} 个摊位`;
 const hidden=quotes.length-visible.length;
 $('quoteHiddenCount').textContent=hidden?`已隐藏 ${hidden} 条位置待识别报价；此筛选仅影响下方列表。`:'已显示全部符合条件的报价。';
 $('quoteRows').innerHTML=`${visible.map(x=>`<tr><td>${esc(x.shop)}<small>${esc(locationText(x.location))}</small></td><td class="price">${num(x.unit_price)}</td><td>${num(x.price)} / ${num(x.bundle)}</td><td>${num(x.stock)}</td>${r.category==='装备'?`<td>${equipmentText(x.equipment)}</td>`:''}<td>${date(x.time)}</td></tr>`).join('')||'<tr><td colspan="6">当前筛选下没有报价；可勾选“显示位置待识别”查看其他记录。</td></tr>'}`;I18n.apply($('detailBody'));
}
$('showUnknownLocation').onchange=renderQuotes;renderQuotes();I18n.apply($('detailBody'));

}
$('quoteWindow').onchange=()=>{page=0;load()};
$('rows').onclick=e=>{const watch=e.target.closest('[data-watch-toggle]');if(watch){const item=data.products.find(r=>r.item_id===Number(watch.dataset.watchToggle));if(item)window.MarketWatchlist?.toggle(item);return}let button=e.target.closest('[data-item]');if(button)showItem(Number(button.dataset.item))};$('close').onclick=()=>{detailToken++;$('detail').close()};document.querySelector('.categories').onclick=e=>{if(!e.target.dataset.cat)return;category=e.target.dataset.cat;page=0;$('subtype').value='';document.querySelectorAll('[data-cat]').forEach(b=>b.classList.toggle('selected',b.dataset.cat===category));subtypes();render()};['search','subtype','sort','minLevel','maxLevel','job','inStock'].forEach(id=>$(id).oninput=()=>{page=0;render()});$('prev').onclick=()=>{page--;render()};$('next').onclick=()=>{page++;render()};$('export').onclick=async()=>{if(!data)return;let full=await (await fetch('/api/v1/market?hours='+windowQuery())).json();let u=URL.createObjectURL(new Blob([JSON.stringify(full,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='maple-market.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};load();setInterval(()=>{if(!pushConnected)load()},2000);

window.addEventListener('market-languagechange',()=>{if(data){subtypes();render();renderOpportunities();if($('detail').open&&currentItemId!=null)showItem(currentItemId)}else I18n.apply()});

window.addEventListener('market-watchlistchange',()=>{if(data)render()});
window.addEventListener('market-openitem',event=>{if(data)showItem(event.detail)});
