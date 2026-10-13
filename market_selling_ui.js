'use strict';
const I18n=window.MarketI18n??{language:'zh',locale:'zh-CN',t:x=>String(x??''),apply(){},name:r=>r.name_zh??r.name??String(r.item_id)};
if(!window.MarketI18n){const note=document.createElement('p');note.className='source';note.setAttribute('role','alert');note.textContent='语言切换暂不可用，页面以中文显示。请刷新网页。 / Language switching is unavailable; showing Chinese. Please refresh.';document.querySelector('main').prepend(note)}
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storageKey = 'classicworld.personal-shop.inventory.v1';
let market = null, bag = [];
try { const saved=JSON.parse(localStorage.getItem(storageKey)||'[]'); if(Array.isArray(saved)) bag=saved.filter(r=>r&&Number.isSafeInteger(r.item_id)&&typeof r.world==='string'); }
catch { $('sellingError').textContent=I18n.t('保存的背包无法读取，请重新登记。'); }
const key = row => `${row.world}:${row.item_id}`;
function save(){try{localStorage.setItem(storageKey,JSON.stringify(bag));}catch{$('sellingError').textContent=I18n.t('浏览器未能保存背包，请导出计划留存。');}}
function itemFor(row){return market?.items.find(p=>key(p)===key(row));}
function proposal(row){
  const item=itemFor(row), price=item?.[row.strategy];
  if(!item)return {reason:I18n.t('暂无市场数据')};
  if(!item.automatic_pricing_supported)return {reason:I18n.t('装备需逐件核对属性')};
  if(item.shops<3||!Number.isFinite(price)||price<=0)return {reason:I18n.t('报价样本不足')};
  if(!Number.isFinite(row.minimum_unit_price)||row.minimum_unit_price<=0)return {reason:I18n.t('请填底价')};
  if(!['quantity','reserve','bundle','groups'].every(k=>Number.isSafeInteger(row[k])&&row[k]>=(['bundle','groups'].includes(k)?1:0)))return {reason:I18n.t('数量设置无效')};
  if(row.bundle*row.groups>row.quantity-row.reserve)return {reason:I18n.t('超过可出售数量')};
  // Proposal only; executor must independently validate with Decimal/backend.
  const pricePerBundle=Math.ceil(Math.max(price,row.minimum_unit_price)*row.bundle);
  if(!Number.isSafeInteger(pricePerBundle)||pricePerBundle>2147483647)return {reason:I18n.t('组价超出计划上限')};
  return {bundle_price:pricePerBundle,requires_inventory_confirmation:true,requires_price_confirmation:item.screen_validation_required,execution_ready:false};
}
function render(){
  $('bagRows').innerHTML=bag.map((r,i)=>{const p=proposal(r),item=itemFor(r);return `<tr data-index="${i}"><td><input type="checkbox" data-field="selected" ${r.selected?'checked':''} aria-label="出售 ${esc(item?I18n.name(item):r.item_id)}"></td><td>${esc(item?I18n.name(item):r.item_id)}<br><small>${esc(r.world)} · ${r.item_id}</small><br><input type="number" min="0" step="1" data-field="quantity" value="${esc(r.quantity)}" aria-label="背包数量"></td><td><input type="number" min="0" step="1" data-field="reserve" value="${esc(r.reserve)}" aria-label="保留数量"></td><td><input type="number" min="1" step="1" data-field="bundle" value="${esc(r.bundle)}" aria-label="每组数量"><br><input type="number" min="1" step="1" data-field="groups" value="${esc(r.groups)}" aria-label="出售组数"></td><td><select data-field="strategy" aria-label="定价策略">${[['fast','快卖'],['normal','正常'],['median','中位数']].map(([v,t])=>`<option value="${v}" ${r.strategy===v?'selected':''}>${t}</option>`).join('')}</select></td><td><input type="number" min="0.01" step="any" data-field="minimum_unit_price" value="${esc(r.minimum_unit_price??'')}" aria-label="最低单价"></td><td>${p.reason?`<span class="selling-error">${esc(p.reason)}</span>`:p.bundle_price.toLocaleString(I18n.locale)+' 金币'}<br><small>${item?.shops||0} 个报价摊位</small></td><td><button data-remove="${i}" aria-label="移除物品">移除</button></td></tr>`;}).join('')||'<tr><td colspan="8">先登记背包中实际拥有的物品，再应用出售预设。</td></tr>';I18n.apply($('bagRows'));
}
$('addInventory').addEventListener('submit',e=>{e.preventDefault();const value=$('itemSearch').value;const matches=market?.items.filter(p=>value===`${I18n.name(p)} · ${p.item_id} · ${p.world}`||value===String(p.item_id))||[];const quantity=Number($('itemQuantity').value);if(matches.length!==1||!Number.isSafeInteger(quantity)||quantity<1){$('sellingError').textContent=I18n.t('请选择唯一的市场物品并填写有效数量。');return;}const p=matches[0],old=bag.find(r=>key(r)===key(p));if(old)old.quantity=quantity;else bag.push({world:p.world,item_id:p.item_id,quantity,reserve:0,bundle:1,groups:1,strategy:'normal',minimum_unit_price:null,selected:false,source:'player_maintained'});$('sellingError').textContent='';save();render();});
$('bagRows').addEventListener('change',e=>{const field=e.target.dataset.field;if(!field)return;const row=bag[Number(e.target.closest('tr').dataset.index)];row[field]=field==='selected'?e.target.checked:field==='strategy'?e.target.value:e.target.value===''?null:Number(e.target.value);save();render();});
$('bagRows').addEventListener('click',e=>{if(e.target.dataset.remove!==undefined){bag.splice(Number(e.target.dataset.remove),1);save();render();}});
$('applyPreset').addEventListener('click',()=>{const preset=market?.presets.find(p=>p.id===$('preset').value);if(!preset)return;const ids=new Set(preset.items.map(key));bag.forEach(r=>r.selected=ids.has(key(r)));save();render();});
$('exportPlan').addEventListener('click',()=>{if(!market)return;const selected=bag.filter(r=>r.selected);if(!selected.length){$('sellingError').textContent=I18n.t('请先选择要出售的背包物品。');return;}const plan={version:1,created_at:Date.now()/1000,shop_type:'personal',execution_ready:false,market_observed_at:market.generated_at,inventory_source:'player_maintained',items:selected.map(r=>({...r,proposal:proposal(r)})),venue_candidates:market.venues.slice(0,10),coordinate_policy:'entrance_then_reachable_platform; live vacancy confirmation required'};const url=URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='personal-shop-plan.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
async function refresh(){try{const response=await fetch('/api/v1/selling');if(!response.ok)throw new Error(`HTTP ${response.status}`);market=await response.json();$('marketItems').innerHTML=market.items.map(p=>`<option value="${esc(`${I18n.name(p)} · ${p.item_id} · ${p.world}`)}"></option>`).join('');const preset=$('preset').value;$('preset').innerHTML=market.presets.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');if(market.presets.some(p=>p.id===preset))$('preset').value=preset;$('venueBasis').textContent=market.venue_basis;$('venueList').innerHTML=market.venues.slice(0,10).map(v=>`<li>${esc(v.world)} · ${v.channel}频道 / ${v.room}洞<br><small>${v.shops} 个近期摊位 · 空位待确认</small></li>`).join('')||'<li>近期位置样本不足，暂不推荐频道或洞号。</li>';$('sellingStatus').textContent=`市场数据更新于 ${new Date(market.generated_at*1000).toLocaleString(I18n.locale)} · 背包数量由玩家维护`;render();I18n.apply();}catch(error){$('sellingStatus').textContent=`市场数据暂不可用（${error.message}）；已保存的背包仍可保留。`;render();I18n.apply();}}
window.addEventListener('market-languagechange',()=>{render();refresh()});
refresh();
