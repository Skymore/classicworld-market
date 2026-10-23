import { subscribeMarket } from '../lib/realtime.js?v=20261022-regressions-1';
import { itemNames } from '../lib/names.js';
import { lang } from '../lib/i18n.js';
import { esc } from '../lib/format.js';
import { mergeBag } from '../lib/bag-transfer.js';

const storageKey = 'classicworld.personal-shop.inventory.v1';
const key = (r) => `${r.world}:${r.item_id}`;
export function propose(row, item) {
  if (!item) return { reason: ['暂无市场数据', 'No market data'] };
  if (!item.automatic_pricing_supported) return { reason: ['装备需逐件核对属性', 'Check equipment stats individually'] };
  const price = item[row.strategy];
  if (item.shops < 3 || !Number.isFinite(price) || price <= 0) return { reason: ['报价样本不足', 'Too few quotes'] };
  if (!Number.isFinite(row.minimum_unit_price) || row.minimum_unit_price <= 0) return { reason: ['请填底价', 'Set a minimum price'] };
  if (!['quantity','reserve','bundle','groups'].every((k) => Number.isSafeInteger(row[k]) && row[k] >= (['bundle','groups'].includes(k) ? 1 : 0))) return { reason: ['数量设置无效', 'Invalid quantities'] };
  if (row.bundle * row.groups > row.quantity - row.reserve) return { reason: ['超过可出售数量', 'Exceeds available quantity'] };
  const pricePerBundle = Math.ceil(Math.max(price, row.minimum_unit_price) * row.bundle);
  if (!Number.isSafeInteger(pricePerBundle) || pricePerBundle > 2147483647) return { reason: ['组价超出计划上限', 'Bundle price exceeds limit'] };
  return { bundle_price: pricePerBundle, requires_inventory_confirmation: true, requires_price_confirmation: item.screen_validation_required, execution_ready: false };
}

export async function mount(root) {
  root.innerHTML=`<section class="stall"><div class="stall-bar"><h1>${lang==='en'?'Bag & shop':'背包／摆摊'}</h1></div><div class="selling-body"><p>${lang==='en'?'This unfinished feature is temporarily disabled. Your saved inventory has not been deleted.':'此功能尚未完成，已暂时停用。已保存的背包数据未删除。'}</p><a class="btn" href="/prices">${lang==='en'?'Back to prices':'返回价格表'}</a></div></section>`;
  return ()=>{};

  const s = (zh, en) => lang === 'en' ? en : zh;
  if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
    root.innerHTML=`<section class="stall"><div class="stall-bar"><h1>${s('背包与摆摊','Bag & shop')}</h1></div><div class="selling-body"><p>${s('背包和摆摊计划保存在你运行本机工具的浏览器中。请在那台电脑上打开本机工具。','Your inventory and shop plans are saved in the browser running the local tool. Open it on that computer.')}</p><p><a class="btn primary" href="http://localhost:8765/selling">${s('打开本机背包与摆摊','Open local bag & shop')}</a></p><p class="selling-note">${s('如果无法打开，请先启动本机市场服务。公网不会读取或公开你的私人背包。','If it does not open, start your local market service first. The public site does not read or publish your private inventory.')}</p></div></section>`;
    return ()=>{};
  }

  document.title = s('背包与摆摊 · 枫叶市集', 'Bag & shop · Maple Market');
  const name = (p) => lang === 'en' ? p.name_en || p.name || p.item_id : p.name_zh || p.name || p.item_id;
  const number = (n) => n.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN');
  let market = null, bag = [], stopped = false, readFailed = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(saved)) throw new Error('Invalid bag');
    bag = saved.filter((r) => r && Number.isSafeInteger(r.item_id) && typeof r.world === 'string');
  } catch { readFailed = true; }
  if(location.hostname!=='localhost' && !bag.length && !readFailed) {
    location.replace('http://localhost:8765/selling'); return ()=>{};
  }
  root.innerHTML = `
    <div class="selling-layout"><section class="stall">
      <div class="stall-bar"><h1>${s('背包与摆摊', 'Bag & shop')}</h1><span class="sp"></span><button class="btn" id="exportPlan">${s('导出摆摊计划','Export plan')}</button></div>
      <div class="selling-body">
        <p class="selling-intro">${s('选好要卖的，再定价。普通个人商店 · 保留自用数量 · 本机保存','Choose what to sell, then set prices. Personal shop · Keep a reserve · Saved locally')}</p>
        <div class="bag-summary" id="bagSummary"></div>
        <details class="bag-transfer"><summary>${s('备份／合并背包','Back up / merge inventory')}</summary>
          <p>${s('统一入口为 localhost:8765。不同地址的浏览器存储彼此独立；请在旧地址导出，再到统一入口导入。相同物品保留现有数量，不覆盖、不累加。','Use localhost:8765. Browser storage is separate for each address. Export at the old address and import at the standard address. Existing items keep their current quantities; duplicates are not added or overwritten.')}</p>
          <button class="btn" type="button" id="exportBag">${s('导出完整背包','Export full inventory')}</button>
          <label class="btn">${s('导入并合并','Import and merge')}<input id="importBag" type="file" accept="application/json,.json"></label>
          <a class="btn" href="http://localhost:8765/selling">${s('打开统一入口','Open standard address')}</a><p role="status" id="transferStatus"></p>
        </details>
        ${location.hostname!=='localhost'?`<p class="selling-error">${s('你正在旧地址查看背包。请先导出完整背包，再到统一入口导入；这里的数据不会自动迁移。','This is an old address. Export your full inventory, then import it at the standard address. Data is not moved automatically.')}</p>`:''}
        <p class="selling-status" id="sellingStatus" role="status">${s('正在读取本机市场报价…','Loading local market quotes…')}</p>
        <form class="bagform" id="addInventory">
          <div class="bag-picker"><label>${s('物品','Item')}<input id="itemSearch" type="search" placeholder="${s('输入名称或物品 ID，选择物品','Type a name or ID and select an item')}" required autocomplete="off"></label><div class="quick-search" id="bagSuggestions" role="region" aria-label="${s('物品搜索结果','Item search results')}" hidden></div></div>
          <label>${s('背包数量','Quantity')}<input id="itemQuantity" type="number" min="1" step="1" value="1" required></label>
          <button class="btn primary">${s('登记／更新','Add / update')}</button>
        </form>
        <div class="bag-controls"><label>${s('出售预设','Preset')}<select id="preset"></select></label><button class="btn" id="applyPreset">${s('选择背包中匹配的物品','Select matching bag items')}</button></div>
        <div class="selling-table-wrap"><table class="selling-table"><thead><tr>${[
          s('出售','Sell'),s('物品／数量','Item / quantity'),s('保留','Reserve'),s('每组／组数','Bundle / groups'),s('定价策略','Pricing'),s('底价／件','Min / unit'),s('计划组价','Bundle price'),s('操作','Actions'),
        ].map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody id="bagRows"></tbody></table></div>
        <p class="selling-error" id="sellingError" role="alert"></p>
        <p class="selling-note">${s('数量由你登记，尚未接入游戏背包同步。预设依据近期在售摊位覆盖度，不代表销量。装备需核对属性，底价由你填写。','Quantities are player-maintained; game inventory sync is not connected. Presets use recent shop coverage, not sales volume. Check equipment stats and set your own minimum price.')}</p>
      </div></section>
      <aside class="stall"><div class="stall-bar"><h2>${s('摆摊位置参考','Shop location')}</h2></div><div class="selling-body">
        <p class="selling-note">${s('按近期摊位活跃度排序，优先考察有人气的频道和洞号。','Ranked by recent shop activity to help choose channels and rooms.')}</p><ol class="selling-venues" id="venueList"></ol>
        <p class="selling-note">${s('这只是考察顺序，现场空位与可达坐标仍需确认。','These are scouting priorities. Check vacancy and reachable coordinates in game.')}</p>
        <h3>${s('清单与计划','Inventory & planning')}</h3><p class="selling-note">${s('维护背包、选择快卖／正常／中位数策略并导出计划。当前不会自动移动或上架。','Maintain your bag, choose fast / normal / median pricing, and export a plan. Movement and listing are not automated.')}</p>
      </div></aside></div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const error = (text) => { $('sellingError').textContent = text; };
  $('exportBag').addEventListener('click',()=>{
    const raw=localStorage.getItem(storageKey)||'[]';
    const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='market-inventory-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  $('importBag').addEventListener('change',async event=>{
    try {
      const file=event.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw new Error('Too large');
      if(readFailed)throw new Error('Existing inventory unreadable');
      const merged=mergeBag(bag,JSON.parse(await file.text()));
      localStorage.setItem(storageKey,JSON.stringify(merged.items));bag=merged.items;renderRows();
      $('transferStatus').textContent=s(`合并完成，保留 ${merged.skipped} 条现有记录。`,`Merged; kept ${merged.skipped} existing records.`);
    } catch { error(s('未导入：文件无效、原背包不可读或无法保存，原记录保持不变。','Import failed: invalid file, unreadable inventory or storage unavailable. Existing records are unchanged.')); }
    event.target.value='';
  });
  if (readFailed) error(s('保存的背包无法读取，原记录未覆盖。','Saved bag could not be read; the original record has not been overwritten.'));
  function save() {
    if (readFailed) { error(s('请先备份浏览器中原有背包记录。','Back up the original bag record before saving.')); return false; }
    try { localStorage.setItem(storageKey, JSON.stringify(bag)); return true; }
    catch { error(s('无法保存，请导出计划留存。','Could not save. Export a plan to keep a copy.')); return false; }
  }
  const itemFor = (r) => market?.items.find((p) => key(p) === key(r));
  function renderRows() {
    $('bagSummary').innerHTML = `<span><b>${bag.length}</b>${s('种物品','item types')}</span><span><b>${number(bag.reduce((n,r) => n + (Number(r.quantity)||0),0))}</b>${s('件物品','items')}</span><span><b>${bag.filter((r) => r.selected).length}</b>${s('种待出售','selected')}</span>`;
    $('bagRows').innerHTML = bag.map((r,i) => {
      const item = itemFor(r), p = propose(r,item), title = item ? name(item) : r.item_id;
      const input = (field,min,label) => `<input type="number" min="${min}" step="${field === 'minimum_unit_price' ? 'any' : '1'}" data-field="${field}" value="${esc(r[field] ?? '')}" aria-label="${esc(label)}">`;
      return `<tr data-index="${i}"><td><input type="checkbox" data-field="selected" ${r.selected ? 'checked' : ''} aria-label="${s('出售','Sell')} ${esc(title)}"></td>
      <td>${itemNames(item || {item_id:r.item_id})}<small>${esc(r.world)} · ${r.item_id}</small>${input('quantity',0,s('背包数量','Bag quantity'))}</td>
      <td>${input('reserve',0,s('保留数量','Reserve quantity'))}</td><td><div class="pair">${input('bundle',1,s('每组数量','Items per bundle'))}${input('groups',1,s('出售组数','Groups to sell'))}</div></td>
      <td><select data-field="strategy" aria-label="${s('定价策略','Pricing strategy')}">${[['fast',s('快卖','Fast')],['normal',s('正常','Normal')],['median',s('中位数','Median')]].map(([v,t]) => `<option value="${v}" ${r.strategy === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td>${input('minimum_unit_price',0.01,s('最低单价','Minimum unit price'))}</td><td>${p.reason ? `<span class="selling-error">${esc(s(...p.reason))}</span>` : `${number(p.bundle_price)} ${s('金币','mesos')}`}<small>${item?.shops || 0} ${s('个报价摊位','quoting shops')}</small></td>
      <td><button class="btn" data-remove="${i}">${s('移除','Remove')}</button></td></tr>`;
    }).join('') || `<tr><td colspan="8">${s('登记背包中实际拥有的物品，开始准备摆摊清单。','Add items you own to start your shop plan.')}</td></tr>`;
  }
  let bagResultLimit = 40;
  const searchInput = $('itemSearch'), searchResults = $('bagSuggestions');
  const bagPicker=searchInput.closest('.bag-picker');
  searchInput.setAttribute('aria-controls','bagSuggestions');
  searchInput.setAttribute('aria-expanded','false');
  function showBagResults(reset = true) {
    if(reset) bagResultLimit=40;
    const query=searchInput.value.trim().toLowerCase();
    const matches=(market?.items || []).filter(p => `${p.name || ''} ${p.name_zh || ''} ${p.name_en || ''} ${p.item_id}`.toLowerCase().includes(query));
    searchResults.innerHTML=matches.slice(0,bagResultLimit).map(p => `<button type="button" class="quick-row" data-bag-pick="${esc(key(p))}"><span class="quick-names">${itemNames(p)}<small>${p.item_id} · ${esc(p.world)}</small></span></button>`).join('')
      + (matches.length > bagResultLimit ? `<button type="button" class="quick-more" data-bag-more>${s('显示更多商品','Show more items')} (${bagResultLimit} / ${matches.length})</button>` : '')
      || `<p class="quick-note">${market ? s('没有匹配的市场商品。','No matching market items.') : s('正在加载商品…','Loading items…')}</p>`;
    searchResults.hidden=false; searchInput.setAttribute('aria-expanded','true');
  }
  function closeBagResults() { searchResults.hidden=true; searchInput.setAttribute('aria-expanded','false'); }
  searchInput.addEventListener('input',event => { if(!event.isComposing) showBagResults(); });
  searchInput.addEventListener('compositionend',() => showBagResults());
  searchInput.addEventListener('focus',() => showBagResults());
  searchInput.addEventListener('keydown',event => { if(event.key==='Escape') { event.preventDefault(); closeBagResults(); } if(event.key==='ArrowDown' && !searchResults.hidden) { event.preventDefault(); searchResults.querySelector('button')?.focus(); } });
  searchResults.addEventListener('click',event => {
    if(event.target.closest('[data-bag-more]')) { bagResultLimit+=40; showBagResults(false); return; }
    const pick=event.target.closest('[data-bag-pick]');
    const item=pick && market.items.find(p => key(p)===pick.dataset.bagPick);
    if(item) { searchInput.value=`${name(item)} · ${item.item_id} · ${item.world}`; closeBagResults(); $('itemQuantity').focus(); }
  });
  const closeBagOutside=event => { if(!bagPicker.contains(event.target)) closeBagResults(); };
  document.addEventListener('pointerdown',closeBagOutside);
  document.addEventListener('click',closeBagOutside);
  bagPicker.addEventListener('focusout',() => setTimeout(() => { if(!bagPicker.contains(document.activeElement)) closeBagResults(); },0));
  $('addInventory').addEventListener('submit', (event) => {
    event.preventDefault();
    if (readFailed) return;
    const value = $('itemSearch').value.trim(), quantity = Number($('itemQuantity').value);
    const matches = market?.items.filter((p) => value === `${name(p)} · ${p.item_id} · ${p.world}` || value === String(p.item_id)) || [];
    if (matches.length !== 1 || !Number.isSafeInteger(quantity) || quantity < 1) { error(s('请选择唯一物品并填写有效数量。','Select a unique item and enter a valid quantity.')); return; }
    const p = matches[0], old = bag.find((r) => key(r) === key(p));
    if (old) old.quantity = quantity;
    else bag.push({world:p.world,item_id:p.item_id,quantity,reserve:0,bundle:1,groups:1,strategy:'normal',minimum_unit_price:null,selected:false,source:'player_maintained'});
    error(''); save(); renderRows();
  });
  $('bagRows').addEventListener('change', (event) => {
    const field = event.target.dataset.field;
    if (!['selected','quantity','reserve','bundle','groups','strategy','minimum_unit_price'].includes(field) || readFailed) return;
    const r = bag[Number(event.target.closest('tr').dataset.index)];
    r[field] = field === 'selected' ? event.target.checked : field === 'strategy' ? event.target.value : event.target.value === '' ? null : Number(event.target.value);
    save(); renderRows();
  });
  $('bagRows').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button || readFailed) return;
    bag.splice(Number(button.dataset.remove),1); save(); renderRows();
  });
  $('applyPreset').addEventListener('click', () => {
    const preset = market?.presets.find((p) => p.id === $('preset').value);
    if (!preset || readFailed) return;
    const ids = new Set(preset.items.map(key)); bag.forEach((r) => { r.selected = ids.has(key(r)); }); save(); renderRows();
  });
  $('exportPlan').addEventListener('click', () => {
    if (!market || !bag.some((r) => r.selected)) { error(s('请先选择要出售的背包物品。','Select bag items to sell first.')); return; }
    const plan = {version:1,created_at:Date.now()/1000,shop_type:'personal',execution_ready:false,market_observed_at:market.generated_at,inventory_source:'player_maintained',
      items:bag.filter((r) => r.selected).map((r) => { const p = propose(r,itemFor(r)); return {...r,proposal:p.reason ? {reason:s(...p.reason)} : p}; }),venue_candidates:market.venues.slice(0,10),coordinate_policy:'entrance_then_reachable_platform; live vacancy confirmation required'};
    const url = URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));
    const a = document.createElement('a'); a.href=url; a.download='personal-shop-plan.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  });
  renderRows();
  let refreshing = false;
  async function refresh() {
  if (stopped || refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/v1/selling');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    market = await response.json();
    if (stopped) return;
    if(document.activeElement===searchInput) showBagResults(false);
    const presetNames = {common:s('常见出售品','Popular items'),consumables:s('常用消耗品','Consumables'),materials:s('材料','Materials'),scrolls:s('卷轴','Scrolls')};
    const selectedPreset = $('preset').value;
    $('preset').innerHTML = market.presets.map((p) => `<option value="${esc(p.id)}">${esc(lang === 'zh' ? p.name : presetNames[p.id] || p.id)}</option>`).join('');
    if (market.presets.some((p) => p.id === selectedPreset)) $('preset').value = selectedPreset;
    $('venueList').innerHTML = market.venues.slice(0,10).map((v) => `<li>${esc(v.world)} · ${s(`${v.channel}频道／${v.room}洞`,`CH ${v.channel} / Room ${v.room}`)}<small>${v.shops} ${s('个近期摊位 · 空位待确认','recent shops · vacancy unconfirmed')}</small></li>`).join('') || `<li>${s('近期位置样本不足。','Not enough recent location samples.')}</li>`;
    $('sellingStatus').textContent = `${s('本机报价更新于','Local quotes updated')} ${new Date(market.generated_at*1000).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')}`;
    if (!$('bagRows').contains(document.activeElement)) renderRows();
  } catch {
    if (!stopped) $('sellingStatus').textContent = s('市场报价暂不可用；已保存的背包仍保留。','Market quotes unavailable; your saved bag is preserved.');
  } finally { refreshing = false; }
  }
  // The local repository warms up after a restart; recover without a reload.
  refresh();
  const unsubscribe = subscribeMarket(refresh);
  return () => { stopped = true; unsubscribe(); document.removeEventListener('pointerdown',closeBagOutside); document.removeEventListener('click',closeBagOutside); };
}
