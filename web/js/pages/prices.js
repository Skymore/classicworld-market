import { readPeriod, resolvePeriod, decoratePeriod, savePeriod, periodControl, periodProduct, inPeriod } from '../lib/period.js?v=20261022-regressions-1';
import { itemNames } from '../lib/names.js';
import { compileSearch, searchText } from '../lib/search.js';
import {spark} from '../lib/spark.js?v=20261022-regressions-1';
import {priceFilterTokens,clearPriceFilter} from '../lib/price-filters.js?v=20261022-regressions-1';
// Price table `/prices` (design/mockups-v2 *-prices-*.png, *-filter-*.png).
// Tabs 全部 / 涨跌榜 / 最近成交 (`?tab=`). 全部: search, category buttons
// with counts, sort, filter panel; phone = 48 px rows, wider screens = the
// sortable table with the item drawer. Every filter lives in the query string.
// Data: /api/v1/market?view=list refreshed on committed-change events (ETag), /api/v1/sales/recent
// for the sales tab, /api/v1/dex/dropped-items for the monster-drop switch.
import { t, addMessages, itemName, lang } from '../lib/i18n.js';
import { I } from '../lib/icons.js';
import { esc, meso, num, ago, chg, slot, fullTime } from '../lib/format.js';
import { api, live, getJson } from '../lib/api.js?v=20261022-auto-watch-2';
import { priceUnit } from '../lib/market-source.js?v=20261022-external-1';
import { setFreshness } from '../lib/chrome.js?v=20261022-regressions-1';
import { skeletonRows, emptyState, errorState, bindRetry, hideBrokenImages } from '../lib/states.js';
import { byChange, saleWare, itemHref } from '../lib/rows.js?v=20261022-regressions-1';
import { watchIds, toggleWatch } from '../lib/watch-ids.js';
import { trapFocus } from '../lib/dialog.js';

let salesCode;
const loadSales=()=>salesCode||(salesCode=import('./sales.js?v=20261022-regressions-1').catch(error=>{salesCode=null;throw error;}));

addMessages({
  zh: {
    'prices.title': '价格表', 'prices.tab_all': '全部', 'prices.tab_changes': '涨跌榜', 'prices.tab_sales': '成交',
    'prices.meta_phone': '{n} / {total} 件', 'prices.meta_wide': '显示 {n} / {total} 件 · {quotes} 条报价',
    'prices.clear_filters':'清除筛选', 'prices.clear_everything':'清空搜索和筛选', 'prices.remove_filter':'移除：{label}',
    'prices.search': '搜索物品', 'prices.search_wide': '在价格表中搜索', 'prices.cats': '分类', 'prices.cat_all': '全部',
    'prices.col_item': '物品', 'prices.col_price': '成交价', 'prices.col_change': '区间涨跌', 'prices.col_low': '最低报价',
    'prices.col_sales': '区间成交笔数', 'prices.col_trend': '7 日走势', 'prices.col_last': '最近成交', 'prices.col_watch': '关注',
    'prices.sort': '排序：{label}', 'prices.sort_menu': '排序方式',
    'sort.sales': '成交笔数', 'sort.price': '成交价', 'sort.change': '区间涨跌', 'sort.low': '最低报价', 'sort.name': '名称', 'sort.recent':'最新报价优先', 'prices.col_quote_time':'最近采集',
    'sort.sales_short': '成交量', 'sort.wide': '按{label}',
    'prices.filter': '筛选', 'prices.filter_n': '筛选（已设 {n} 项）', 'prices.watch_only': '只看关注',
    'prices.star': '关注 {name}', 'prices.no_rows': '没有符合条件的物品。', 'prices.no_changes': '所选时段没有可比较的涨跌。',
    'prices.no_sales': '还没有成交记录。', 'prices.more_sales': '查看全部成交记录',
    'filter.job': '职业', 'filter.job_note': '只影响装备', 'filter.job_all': '全部', 'filter.level': '需求等级',
    'filter.min': '最低', 'filter.max': '最高', 'filter.min_label': '最低等级', 'filter.max_label': '最高等级', 'filter.no_max': '不限',
    'filter.level_note': '设了等级范围后，没有等级要求的物品（材料、药水）不会显示。', 'filter.show': '显示',
    'filter.few': '成交很少的物品', 'filter.few_sub': '成交记录不到 5 笔',
    'filter.cash': '商城物品', 'filter.cash_sub': '用点券买的物品',
    'filter.sold': '只看有成交记录的物品', 'filter.sold_sub': '没见过玩家成交的不显示',
    'filter.drop': '只看怪物掉落的物品', 'filter.drop_sub': '图鉴里有掉落来源',
    'filter.reset': '重置', 'filter.apply': '显示 {n} 件',
  },
  en: {
    'prices.title': 'Price table', 'prices.tab_all': 'All', 'prices.tab_changes': 'Movers', 'prices.tab_sales': 'Sales',
    'prices.meta_phone': '{n} / {total} items', 'prices.meta_wide': '{n} of {total} items · {quotes} offers',
    'prices.clear_filters':'Clear filters', 'prices.clear_everything':'Clear search and filters', 'prices.remove_filter':'Remove: {label}',
    'prices.search': 'Search items', 'prices.search_wide': 'Search the price table', 'prices.cats': 'Categories', 'prices.cat_all': 'All',
    'prices.col_item': 'Item', 'prices.col_price': 'Typical sale', 'prices.col_change': 'Period change', 'prices.col_low': 'Lowest ask',
    'prices.col_sales': 'Sales in period', 'prices.col_trend': '7-day trend', 'prices.col_last': 'Last sale', 'prices.col_watch': 'Watch',
    'prices.sort': 'Sort: {label}', 'prices.sort_menu': 'Sort by',
    'sort.sales': 'Sales', 'sort.price': 'Typical sale', 'sort.change': 'Period change', 'sort.low': 'Lowest ask', 'sort.name': 'Name', 'sort.recent':'Latest offers first', 'prices.col_quote_time':'Last observed',
    'sort.sales_short': 'Sales', 'sort.wide': 'By {label}',
    'prices.filter': 'Filter', 'prices.filter_n': 'Filter ({n} set)', 'prices.watch_only': 'Watched only',
    'prices.star': 'Watch {name}', 'prices.no_rows': 'No items match these filters.', 'prices.no_changes': 'No comparable price changes in this period.',
    'prices.no_sales': 'No sales recorded yet.', 'prices.more_sales': 'All recent sales',
    'filter.job': 'Job', 'filter.job_note': 'equipment only', 'filter.job_all': 'All', 'filter.level': 'Required level',
    'filter.min': 'Min', 'filter.max': 'Max', 'filter.min_label': 'Minimum level', 'filter.max_label': 'Maximum level', 'filter.no_max': 'any',
    'filter.level_note': 'With a level range set, items without a level requirement (materials, potions) are hidden.', 'filter.show': 'Show',
    'filter.few': 'Items with few sales', 'filter.few_sub': 'fewer than 5 recorded sales',
    'filter.cash': 'Cash shop items', 'filter.cash_sub': 'bought with NX',
    'filter.sold': 'Only items with sales', 'filter.sold_sub': 'hide items never seen sold',
    'filter.drop': 'Only monster drops', 'filter.drop_sub': 'the dex lists a dropping monster',
    'filter.reset': 'Reset', 'filter.apply': 'Show {n} items',
  },
});

const TABS = ['all', 'changes', 'sales'];
// URL key -> API `category`. The brief's five buttons; the API's 装饰 items
// (2 in the dev data) appear under 全部 only.
const CATS = [['all', null], ['equip', '装备'], ['use', '消耗品'], ['etc', '其他'], ['cash', '商城物品']];
const CAT_OF = Object.fromEntries(CATS.filter(([, c]) => c).map(([k, c]) => [c, k]));
// One collator per language; the module outlives a language switch.
const collators = {};
const collator = () => (collators[lang] ||= new Intl.Collator(lang === 'zh' ? 'zh-CN' : 'en'));
// Natural direction per sort; nulls always sort last.
const SORTS = {
  recent: {dir:'desc',key:r=>typeof r.last_seen==='number'&&Number.isFinite(r.last_seen)&&r.last_seen>0?r.last_seen:null},
  sales: { dir: 'desc', key: (r) => r.sales_window },
  price: { dir: 'desc', key: (r) => r.typical },
  change: { dir: 'desc', key: (r) => r.change_window },
  low: { dir: 'asc', key: (r) => r.low },
  name: { dir: 'asc', key: (r) => itemName(r), text: true },
};
const JOBS = [['all', null], ['warrior', '战士'], ['magician', '魔法师'], ['bowman', '弓箭手'], ['thief', '飞侠'], ['pirate', '海盗']];
const LEVELS = [[0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 70]];
const FIRST_ROWS = 60;
const CHUNK_ROWS = 200;
const SALES_LIMIT = 50;
const phoneQuery = matchMedia('(max-width: 640px)');

/* ---------- URL state ---------- */

const intParam = (v) => (v != null && /^\d{1,3}$/.test(v) ? Number(v) : null);

function readState() {
  const p = new URLSearchParams(location.search);
  const rawTab = p.get('tab');
  const sort = SORTS[p.get('sort')] ? p.get('sort') : 'sales';
  const dir = p.get('dir') === 'asc' || p.get('dir') === 'desc' ? p.get('dir') : SORTS[sort].dir;
  const item = /^\d{7}$/.test(p.get('item') || '') ? Number(p.get('item')) : null;
  return {
    // `busy` is the home page's "成交最多" link: the full table by sales.
    tab: TABS.includes(rawTab) ? rawTab : 'all',
    q: (p.get('q') || '').slice(0, 100),
    cat: CATS.some(([k]) => k === p.get('cat')) ? p.get('cat') : 'all',
    sort,
    dir,
    job: JOBS.some(([k]) => k === p.get('job')) ? p.get('job') : 'all',
    lmin: intParam(p.get('lmin')),
    lmax: intParam(p.get('lmax')),
    few: p.get('few') !== '0',
    cash: p.get('cash') !== '0',
    sold: p.get('sold') === '1',
    drop: p.get('drop') === '1',
    watch: p.get('watch') === '1',
    item,
  };
}

function writeState(s) {
  const p = new URLSearchParams();
  if (s.tab !== 'all') p.set('tab', s.tab);
  if (s.q) p.set('q', s.q);
  if (s.cat !== 'all') p.set('cat', s.cat);
  if (s.sort !== 'sales') p.set('sort', s.sort);
  if (s.dir !== SORTS[s.sort].dir) p.set('dir', s.dir);
  if (s.job !== 'all') p.set('job', s.job);
  if (s.lmin != null) p.set('lmin', s.lmin);
  if (s.lmax != null) p.set('lmax', s.lmax);
  if (!s.few) p.set('few', '0');
  if (!s.cash) p.set('cash', '0');
  if (s.sold) p.set('sold', '1');
  if (s.drop) p.set('drop', '1');
  if (s.watch) p.set('watch', '1');
  if (s.item) p.set('item', s.item);
  // `lang` / `theme` stay if a shared link carried them.
  const old = new URLSearchParams(location.search);
  for (const keep of ['lang', 'theme', 'hours']) if (old.has(keep)) p.set(keep, old.get(keep));
  const query = p.toString();
  history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : ''));
}

const levelActive = (s) => (s.lmin != null && s.lmin > 0) || s.lmax != null;
const panelFilterCount = (s, dropOk) => [s.job !== 'all', levelActive(s), !s.few, !s.cash, s.sold, s.drop && dropOk].filter(Boolean).length;

/* ---------- filtering and sorting ---------- */

function filterRows(products, s, ctx) {
  const matches = compileSearch(s.q);
  const job = JOBS.find(([k]) => k === s.job)[1];
  const levels = levelActive(s);
  const watched = s.watch ? new Set(watchIds()) : null;
  const dropped = s.drop ? ctx.dropped : null;
  return products.filter((r) => {
    if (!s.cash && r.category === '商城物品') return false;
    if (!s.few && r.low_data) return false;
    if (s.sold && r.last_sale_at == null) return false;
    if (dropped && !dropped.has(r.item_id)) return false;
    if (watched && !watched.has(r.item_id)) return false;
    // Job only narrows equipment; "通用" equipment fits every job.
    if (job && r.category === '装备' && !(r.jobs || []).some((j) => j === job || j === '通用')) return false;
    if (levels && !(r.level > 0 && r.level >= (s.lmin ?? 0) && (s.lmax == null || r.level <= s.lmax))) return false;
    if (!matches(ctx.search.get(r.item_id))) return false;
    return true;
  });
}

function sortRows(rows, sort, dir) {
  const { key, text } = SORTS[sort];
  const sign = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x != null && y == null) return -1;
    if (x == null && y != null) return 1;
    const primary = x == null ? 0 : (text ? collator().compare(x, y) : x - y) * sign;
    return primary || b.sales_10d - a.sales_10d || b.listings - a.listings || a.item_id - b.item_id;
  });
}

/* ---------- row markup ---------- */


const otherName = (r) => (lang === 'en' ? r.name_zh : r.name_en) || '';

function phoneRow(r,recent=false) {
  const observed=recent&&r.last_seen?`<small data-relative-time="${r.last_seen}" title="${esc(fullTime(r.last_seen))}">${esc(ago(r.last_seen))}</small>`:'';
  return `<a class="prow" href="${itemHref(r.item_id)}" data-item-row>${slot(r.icon_url, 28)}<span class="nm">${itemNames(r)}${observed}</span><span class="pr quote-value">${meso(r.typical)}${priceUnit(r)}${sampleBadge(r)}</span>${chg(r.change_window)}</a>`;
}

function sampleBadge(r) {
  if(r.typical==null || !r.low_data)return '';
  const count=Number(r.sales_window)||0;
  const label=lang==='en'?`Few sales · ${count}`:`样本少 · ${count}`;
  const note=lang==='en'?`Only ${count} observed sales in this period; prices may be unreliable.`:`所选时段仅观察到 ${count} 笔成交，参考性有限。`;
  return `<small class="sample-badge" title="${esc(note)}">${esc(label)}</small>`;
}

function starButton(r, watched) {
  const on = watched.has(r.item_id);
  return `<button type="button" class="star ${on ? 'on' : ''}" data-star="${r.item_id}" aria-pressed="${on}" aria-label="${esc(t('prices.star', { name: itemName(r) }))}">${on ? I.starSm : I.starO}</button>`;
}

function tableRow(r, watched, asOf,recent=false) {
  const range = r.typical_low != null && r.typical_high != null ? `<span class="rg">${meso(r.typical_low)} – ${meso(r.typical_high)}</span>` : '';
  const at=recent?r.last_seen:r.last_sale_at;
  const last = at != null ? `<span data-relative-time="${at}" title="${esc(fullTime(at))}">${esc(ago(at))}</span>` : '—';
  return `<tr data-open="${r.item_id}" data-item-row>
      <td class="star-c l">${starButton(r, watched)}</td>
      <td class="l"><a class="it" href="${itemHref(r.item_id)}">${slot(r.icon_url, 28)}<span><b>${esc(itemName(r))}</b><small>${esc(otherName(r))}</small></span></a></td>
      <td><span class="pr quote-value">${meso(r.typical)}${priceUnit(r)}${sampleBadge(r)}</span>${range}</td>
      <td>${chg(r.change_window)}</td><td>${meso(r.low)}</td><td>${r.sales_window}</td>
      <td class="c-spark">${spark(r.trend)}</td><td class="c-last">${last}</td></tr>`;
}

/* ---------- chunked rendering: first rows now, the rest when idle ---------- */

const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 120 }) : setTimeout(fn, 16));

function renderChunked(container, rows, html, { first = FIRST_ROWS } = {}) {
  container.cancel?.();
  let cancelled = false;
  container.cancel = () => { cancelled = true; };
  container.innerHTML = rows.slice(0, first).map(html).join('');
  let next = first;
  const step = () => {
    if (cancelled) return;
    const end = Math.min(rows.length, next + CHUNK_ROWS);
    container.insertAdjacentHTML('beforeend', rows.slice(next, end).map(html).join(''));
    next = end;
    if (next < rows.length) idle(step);
  };
  if (next < rows.length) idle(step);
}

/* ---------- markup; depends only on the URL state `s` ---------- */

const shownIf = (s, key) => (key === s.tab ? '' : 'hidden');
const arrow = (s, key) => (s.sort === key ? (s.dir === 'asc' ? '▲' : '▼') : '');

function tabsHtml(s) {
  return `<div class="tabs" role="tablist">${TABS.map((k) => `<button type="button" class="tab ${k === s.tab ? 'on' : ''}" role="tab" aria-selected="${k === s.tab}" tabindex="${k === s.tab ? 0 : -1}" data-tab="${k}">${esc(t(`prices.tab_${k}`))}</button>`).join('')}</div>`;
}

function sortMenu(s) {
  return `<div class="sortmenu" role="menu" aria-label="${esc(t('prices.sort_menu'))}" hidden>${Object.keys(SORTS).map((k) => `<button type="button" role="menuitemradio" aria-checked="${k === s.sort}" data-sort="${k}">${esc(t(`sort.${k}`))}<span class="dir" aria-hidden="true">${arrow(s, k)}</span></button>`).join('')}</div>`;
}

function filterButton(withText) {
  return `<button type="button" class="sortbtn fbtn" data-filter-btn aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(t('prices.filter'))}">${I.funnel}${withText ? `<span>${esc(t('prices.filter'))}</span>` : ''}<b class="fcount" hidden></b></button>`;
}


// Phone (mockup pricesPhone): the sticky block and the lists share one
// tabs-well, so a tab switch swaps toolbar and list together.
function phoneLayout(s) {
  const cols = `<div class="pp-cols" aria-hidden="true"><span></span><span>${esc(t('prices.col_item'))}</span><span>${esc(t('prices.col_price'))}</span><span>${esc(t('prices.col_change'))}</span></div>`;
  return `<div class="stall tabs-well pp">
    <div class="pp-sticky">
      <div class="stall-bar"><h1>${esc(t('prices.title'))}</h1><span class="bar-meta" data-meta></span></div>
      ${tabsHtml(s)}
      <div data-price-tools ${s.tab==='sales'?'hidden':''}><div class="pp-tools">
        <label class="finder sm">${I.search}<input type="search" data-q value="${esc(s.q)}" placeholder="${esc(t('prices.search'))}" aria-label="${esc(t('prices.search'))}" autocomplete="off"></label>
        <div class="cats-row"><div class="cats" role="group" aria-label="${esc(t('prices.cats'))}" data-cats></div>
          <span class="sortwrap"><button type="button" class="sortbtn" data-sort-btn aria-haspopup="menu" aria-expanded="false">${I.sort}<span data-sort-label></span></button>${sortMenu(s)}</span>
          ${filterButton(false)}</div></div><div class="active-price-filters" data-active-filters hidden></div>${cols}</div>
    </div>
    <div class="plist" data-pane="all" data-list="all" ${shownIf(s, 'all')}></div>
    <div class="plist" data-pane="changes" data-list="changes" ${shownIf(s, 'changes')}></div>
    <div class="plist sales-pane" data-pane="sales" ${shownIf(s, 'sales')}><div data-sales-host></div></div>
    <div id="prices-filter-root"></div></div>`;
}

function tableHead(s, sortable) {
  const th = (key, label, cls = '') => {
    if (!sortable || !key) return `<th class="${cls}">${label}</th>`;
    const on = s.sort === key;
    const aria = on ? `aria-sort="${s.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th class="${cls}" ${aria}><button type="button" class="th-sort ${on ? 'on' : ''}" data-sort-key="${key}">${label}<span class="dir" aria-hidden="true">${arrow(s, key)}</span></button></th>`;
  };
  return `<thead><tr><th class="l c-star"><span class="sr">${esc(t('prices.col_watch'))}</span></th>${th('name', esc(t('prices.col_item')), 'l')}${th('price', esc(t('prices.col_price')))}${th('change', esc(t('prices.col_change')))}${th('low', esc(t('prices.col_low')))}${th('sales', esc(t('prices.col_sales')))}${th(null, esc(t('prices.col_trend')), 'c-spark')}${th(s.sort==='recent'?'recent':null,esc(t(s.sort==='recent'?'prices.col_quote_time':'prices.col_last')),'c-last')}</tr></thead>`;
}

// Tablet and desktop (mockup pricesDesk).
function wideLayout(s) {
  const tools = `<div class="ptools">
      <label class="finder">${I.search}<input type="search" data-q value="${esc(s.q)}" placeholder="${esc(t('prices.search_wide'))}" aria-label="${esc(t('prices.search_wide'))}" autocomplete="off"></label>
      <div class="cats" role="group" aria-label="${esc(t('prices.cats'))}" data-cats></div><span class="sp"></span>
      <button type="button" class="toggle ${s.watch ? 'on' : ''}" data-watch-only aria-pressed="${s.watch}"><i></i>${esc(t('prices.watch_only'))}</button>
      <span class="sortwrap"><button type="button" class="sortbtn" data-sort-btn aria-haspopup="menu" aria-expanded="false">${I.sort}<span data-sort-label></span>${I.caret}</button>${sortMenu(s)}</span>
      ${filterButton(true)}<div id="prices-filter-root"></div></div>`;
  return `<section class="stall tabs-well prices-wide"><div class="stall-bar"><h1>${esc(t('prices.title'))}</h1><span class="bar-meta" data-meta></span></div>
    <div class="stall-body">${tabsHtml(s)}
      <div data-price-tools ${s.tab==='sales'?'hidden':''}>${tools}<div class="active-price-filters" data-active-filters hidden></div></div>
      <div class="pane list" role="tabpanel" data-pane="all" ${shownIf(s, 'all')}><table class="ptable" data-table="all">${tableHead(s, true)}<tbody data-list="all"></tbody></table><div data-empty="all"></div></div>
      <div class="pane list" role="tabpanel" data-pane="changes" ${shownIf(s, 'changes')}><table class="ptable">${tableHead(s, false)}<tbody data-list="changes"></tbody></table><div data-empty="changes"></div></div>
      <div class="pane list sales-pane" role="tabpanel" data-pane="sales" ${shownIf(s, 'sales')}><div data-sales-host></div></div>
    </div></section><div id="drawer-root"></div>`;
}

// Category buttons; counts follow the search and filters, not the category.
function catButtons(base, s) {
  const counts = { all: base.length };
  for (const r of base) {
    const k = CAT_OF[r.category];
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  return CATS.map(([k, c]) => {
    const on = s.cat === k;
    const label = k === 'all' ? t('prices.cat_all') : t(`cat.${c}`);
    return `<button type="button" class="cat ${on ? 'on' : ''}" data-cat="${k}" aria-pressed="${on}">${esc(label)}<small>${num(counts[k] || 0)}</small></button>`;
  }).join('');
}

// Toolbar labels and badges that change without a re-render.
function syncTools(main, s, dropOk, phone) {
  const tools=main.querySelector('[data-price-tools]');if(tools)tools.hidden=s.tab==='sales';
  const sortWrap=main.querySelector('[data-price-tools] .sortwrap');if(sortWrap)sortWrap.hidden=s.tab==='changes';
  const input=main.querySelector('[data-q]');if(input && input!==document.activeElement)input.value=s.q;
  const active=main.querySelector('[data-active-filters]');
  if(active) {
    const tokens=priceFilterTokens(s,lang==='en',dropOk);
    active.hidden=!tokens.length;
    const markup=tokens.map(({key,label})=>`<button type="button" data-remove-price-filter="${key}" aria-label="${esc(t('prices.remove_filter',{label}))}">${esc(label)} <span aria-hidden="true">×</span></button>`).join('')+(tokens.length?`<button type="button" class="clear-price-filters" data-clear-price-filters="all">${esc(t('prices.clear_filters'))}</button>`:'');
    if(active.innerHTML!==markup)active.innerHTML=markup;
  }
  const sortLabel = t(`sort.${s.sort}`);
  const label = main.querySelector('[data-sort-label]');
  if (label) label.textContent = (phone ? (s.sort === 'sales' ? t('sort.sales_short') : sortLabel) : t('sort.wide', { label: sortLabel }))+' '+arrow(s,s.sort);
  main.querySelector('[data-sort-btn]')?.setAttribute('aria-label', t('prices.sort', { label: sortLabel }));
  main.querySelectorAll('.sortmenu [data-sort]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.sort === s.sort));
    b.querySelector('.dir').textContent = arrow(s, b.dataset.sort);
  });
  const n = panelFilterCount(s, dropOk);
  const fbtn = main.querySelector('[data-filter-btn]');
  if (fbtn) {
    fbtn.classList.toggle('on', n > 0);
    fbtn.setAttribute('aria-label', n ? t('prices.filter_n', { n }) : t('prices.filter'));
    const badge = fbtn.querySelector('.fcount');
    badge.hidden = !n;
    badge.textContent = n || '';
  }
  const watchOnly = main.querySelector('[data-watch-only]');
  if (watchOnly) {
    watchOnly.classList.toggle('on', s.watch);
    watchOnly.setAttribute('aria-pressed', String(s.watch));
  }
}

/* ---------- filter panel (mockup filterPanel): phone bottom sheet, wider screens a popover ---------- */

function filterPanel(s, dropOk, phone) {
  const sw = (key, label, sub) => `<button type="button" class="toggle sw ${s[key] ? 'on' : ''}" aria-pressed="${s[key]}" data-sw="${key}" ${key === 'drop' && !dropOk ? 'hidden' : ''}><i></i><span><b>${esc(t(label))}</b><small>${esc(t(sub))}</small></span></button>`;
  return `<div class="fpanel" role="dialog" aria-modal="${phone}" aria-labelledby="fpanel-title">
    <div class="fhead"><h3 id="fpanel-title">${esc(t('prices.filter'))}</h3><button type="button" class="bar-btn" data-filter-close aria-label="${esc(t('common.close'))}">${I.close}</button></div>
    <div data-fbody>
    <div class="fsec"><h4>${esc(t('filter.job'))}<small>${esc(t('filter.job_note'))}</small></h4><div class="chips">${JOBS.map(([k, label]) => `<button type="button" class="chip" data-job="${k}" aria-pressed="false">${esc(k === 'all' ? t('filter.job_all') : t(`job.${label}`))}</button>`).join('')}</div></div>
    <div class="fsec"><h4>${esc(t('filter.level'))}</h4>
      <div class="lvrow"><label>${esc(t('filter.min'))}<input data-lmin inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="0" aria-label="${esc(t('filter.min_label'))}"></label><span aria-hidden="true">–</span>
        <label>${esc(t('filter.max'))}<input data-lmax inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="${esc(t('filter.no_max'))}" aria-label="${esc(t('filter.max_label'))}"></label></div>
      <div class="chips">${LEVELS.map(([lo, hi]) => `<button type="button" class="chip" data-lv="${lo}-${hi}" aria-pressed="false">${lo}–${hi}</button>`).join('')}</div>
      <p class="fnote">${esc(t('filter.level_note'))}</p></div>
    <div class="fsec"><h4>${esc(t('filter.show'))}</h4>${sw('few', 'filter.few', 'filter.few_sub')}${sw('cash', 'filter.cash', 'filter.cash_sub')}${sw('sold', 'filter.sold', 'filter.sold_sub')}${sw('drop', 'filter.drop', 'filter.drop_sub')}</div>
    </div>
    <div class="ffoot"><button type="button" class="btn" data-filter-reset>${esc(t('filter.reset'))}</button><button type="button" class="btn primary" data-filter-close data-apply></button></div></div>`;
}

// Update the open panel in place so the focused control keeps focus.
function syncPanel(panel, s, dropOk, shown) {
  const press = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  panel.querySelectorAll('[data-job]').forEach((b) => press(b, b.dataset.job === s.job));
  panel.querySelectorAll('[data-lv]').forEach((b) => press(b, b.dataset.lv === `${s.lmin}-${s.lmax}`));
  panel.querySelectorAll('[data-sw]').forEach((b) => {
    press(b, s[b.dataset.sw]);
    if (b.dataset.sw === 'drop') b.hidden = !dropOk;
  });
  panel.querySelector('[data-apply]').textContent = t('filter.apply', { n: num(shown ?? 0) });
}

function syncPanelInputs(panel, s) {
  panel.querySelector('[data-lmin]').value = s.lmin ?? '';
  panel.querySelector('[data-lmax]').value = s.lmax ?? '';
}

/* ---------- page ---------- */

export async function mount(main) {
  const s = readState();
  let hours=await resolvePeriod(), periodRevision=0;
  if(!main.isConnected)return ()=>{};
  const ctx = { list: null, byId: new Map(), search: new Map(), dropped: null, dropOk: false, sales: null, listError: false, salesError: false };
  let phone = phoneQuery.matches;
  let stopList = null;
  let stopSales = null;
  let salesHost = null, salesMountPromise = null, salesMountRevision = 0;
  let typing = null;
  if (new URLSearchParams(location.search).get('tab') === 'busy') { s.sort = 'sales'; s.dir = 'desc'; writeState(s); }

  hideBrokenImages(main);
  bindRetry(main, () => start());



  /* data -> screen */
  function renderMeta() {
    if(!main.querySelector('[data-period]')) {
      main.querySelector('.stall-bar')?.insertAdjacentHTML('beforeend',periodControl(hours));
    }
    const control=main.querySelector('.period-control');if(control) control.hidden=s.tab==='sales';
    decoratePeriod(main.querySelector('[data-period]'),hours);
    const meta = main.querySelector('[data-meta]');
    if (!meta || !ctx.list) return;
    meta.hidden=s.tab==='sales';
    const products = ctx.list.products;
    const visible=(s.tab==='changes'?ctx.movers:ctx.priceRows)||products;
    ctx.shown=visible.length;
    if (phone) {
      meta.textContent = t('prices.meta_phone', { n: num(visible.length),total:num(products.length) });
    } else {
      meta.textContent = t('prices.meta_wide', { n: num(visible.length),total:num(products.length), quotes: num(visible.reduce((sum, r) => sum + (r.listings || 0), 0)) });
    }
    meta.title = fullTime(ctx.list.as_of);
  }


  const panel = () => main.querySelector('#prices-filter-root .fpanel');
  const syncToolbar = () => {
    syncTools(main,s,ctx.dropOk,phone);
    const cats=main.querySelector('[data-cats]');
    if(cats && ctx.baseRows)cats.innerHTML=catButtons(s.tab==='changes'?byChange(ctx.baseRows):ctx.baseRows,s);
  };
  const syncFilter = () => { if (panel()) syncPanel(panel(), s, ctx.dropOk, ctx.shown); };
  const syncFilterInputs = () => { if (panel()) syncPanelInputs(panel(), s); };
  function layout() {
    phone = phoneQuery.matches;
    main.innerHTML = phone ? phoneLayout(s) : wideLayout(s);
    syncToolbar();
  }

  function renderAll({ chunked = true } = {}) {
    if (!ctx.list) {
      const box = main.querySelector('[data-list="all"]');
      if (ctx.listError) setStatus('all', errorState());
      else if (box && !box.children.length) setStatus('all', skeletonRows(phone ? 12 : 10, 48));
      if (s.tab === 'changes') setStatus('changes', ctx.listError ? errorState() : skeletonRows(12, 48));
      renderSales();
      return;
    }
    const base = filterRows(ctx.list.products, s, ctx);
    ctx.baseRows=base;
    const rows = sortRows(s.cat === 'all' ? base : base.filter((r) => CAT_OF[r.category] === s.cat), s.sort, s.dir);
    const movers=byChange(rows);
    ctx.priceRows=rows;ctx.movers=movers;
    ctx.shown = rows.length;
    renderMeta();
    const cats = main.querySelector('[data-cats]');
    if (cats) cats.innerHTML = catButtons(s.tab==='changes'?byChange(base):base, s);
    syncFilter();
    const watched = new Set(watchIds());
    const asOf = ctx.list.as_of;
    const rowHtml = phone ? (r)=>phoneRow(r,s.sort==='recent') : (r) => tableRow(r, watched, asOf,s.sort==='recent');
    const all = main.querySelector('[data-list="all"]');
    const changes = main.querySelector('[data-list="changes"]');
    if (rows.length) {
      clearStatus('all');
      if (chunked) renderChunked(all, rows, rowHtml);
      else renderChunked(all, rows, rowHtml, { first: rows.length });
    } else {
      all.cancel?.();
      all.innerHTML = '';
      setStatus('all', emptyState(t('prices.no_rows'), 3)+resetEmptyButton(), true);
    }
    if (movers.length) {
      clearStatus('changes');
      renderChunked(changes, movers, rowHtml, { first: chunked ? FIRST_ROWS : movers.length });
    } else {
      changes.innerHTML = '';
      setStatus('changes', emptyState(t('prices.no_changes'), 1)+resetEmptyButton(), true);
    }
    renderSales();
  }

  function resetEmptyButton() {
    return s.q || s.cat!=='all' || priceFilterTokens(s,lang==='en',ctx.dropOk).length
      ? `<div class="filter-empty-action"><button type="button" class="btn" data-clear-price-filters="everything">${esc(t('prices.clear_everything'))}</button></div>` : '';
  }

  // Loading / empty / error go next to the list: inside the phone list, below the table on wider screens.
  function setStatus(key, html, keepList = false) {
    const list = main.querySelector(`[data-list="${key}"]`);
    const slotEl = main.querySelector(`[data-empty="${key}"]`);
    if (!list) return;
    if (slotEl) {
      if (!keepList) list.innerHTML = '';
      slotEl.innerHTML = html;
    } else {
      list.cancel?.();
      list.innerHTML = html;
    }
  }
  function clearStatus(key) {
    const slotEl = main.querySelector(`[data-empty="${key}"]`);
    if (slotEl) slotEl.innerHTML = '';
  }

  function renderSales() { startSales(); }

  function startSales() {
    if(s.tab !== 'sales') return;
    const host=main.querySelector('[data-sales-host]');
    if(!host) return;
    if(host===salesHost && salesMountPromise) return salesMountPromise;
    stopSales?.();stopSales=null;
    salesHost=host;
    const revision=++salesMountRevision;
    salesMountPromise=loadSales().then(mod=>{
      if(revision!==salesMountRevision || !host.isConnected) return ()=>{};
      return mod.mount(host,{embedded:true});
    }).then(stop=>{
      if(revision!==salesMountRevision || !host.isConnected) stop(); else stopSales=stop;
    });
    return salesMountPromise;
  }

  function start() {
    const generation=++periodRevision;
    stopList?.();
    stopSales?.();
    stopSales = null;
    salesMountRevision++;salesHost=null;salesMountPromise=null;
    ctx.listError = false;
    ctx.salesError = false;
    let firstList = true;
    stopList = live(api.list(hours), (data) => {
      if(generation!==periodRevision) return;
      data={...data,products:data.products.map(periodProduct)};
      ctx.list = data;
      ctx.listError = false;
      ctx.byId = new Map(data.products.map((r) => [r.item_id, r]));
      ctx.search = new Map(data.products.map((r) => [r.item_id, searchText(r)]));
      setFreshness(data.as_of);
      // Later updates render in one pass so the scroll position holds.
      renderAll({ chunked: firstList });
      if (firstList) performance.mark('prices-first-rows');
      firstList = false;
      if (s.item) openItemPage(s.item);
    }, { onError: () => { if (!ctx.list) { ctx.listError = true; renderAll(); } } });
    renderAll();
    return Promise.all([stopList.first, startSales()]);
  }

  // The monster-drop switch needs R5-D's endpoint; hide it until that answers.
  getJson(api.droppedItems()).then(({ data }) => {
    if(!main.isConnected) return;
    ctx.dropped = new Set(data.item_ids || []);
    ctx.dropOk = true;
    syncToolbar();
    if (s.drop) renderAll({ chunked: false });
    else syncFilter();
  }).catch(() => { ctx.dropOk = false; });

  /* events */
  main.addEventListener('change',async event=>{if(!event.target.matches('[data-period]')) return;const choice=event.target.value;const saved=savePeriod(choice);const next=choice==='auto'?await resolvePeriod():saved;if(event.target.value!==choice)return;hours=next;ctx.list=null;ctx.sales=null;ctx.listError=false;ctx.salesError=false;stopSales?.();stopSales=null;start();});
  const rerender = () => { writeState(s); syncToolbar(); renderAll(); };

  function commitSearch() {
    const input=main.querySelector('[data-q]');
    if(!input || s.tab==='sales' || input.value.trim()===s.q)return;
    clearTimeout(typing);
    s.q=input.value.trim();
    rerender();
  }

  function selectTab(key, focus) {
    commitSearch();
    if (key === s.tab) return;
    s.tab = key;
    const control=main.querySelector('.period-control');if(control) control.hidden=key==='sales';
    writeState(s);
    for (const b of main.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === key;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const pane of main.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== key;
    closeFilter();
    closeSortMenu();
    syncToolbar();renderMeta();
    if(key!=='sales' && readPeriod()!==hours){hours=readPeriod();ctx.list=null;start();}
    if (key === 'sales') { startSales(); renderSales(); }
  }

  function onClick(e) {
    if(e.target.closest('[data-sales-host]')) return;
    if(e.target.closest('button'))commitSearch();
    const remove=e.target.closest('[data-remove-price-filter]');
    const reset=e.target.closest('[data-clear-price-filters]');
    if(remove || reset) {
      Object.assign(s,clearPriceFilter(s,remove?.dataset.removePriceFilter || reset.dataset.clearPriceFilters));
      syncFilterInputs();rerender();
      main.querySelector('[data-q]')?.focus();
      return;
    }
    if (!e.target.closest('.sortwrap')) closeSortMenu();
    const star = e.target.closest('[data-star]');
    if (star) {
      e.stopPropagation();
      const id = Number(star.dataset.star);
      const on = toggleWatch(id);
      for (const b of main.querySelectorAll(`[data-star="${id}"]`)) {
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        b.innerHTML = on ? I.starSm : I.starO;
      }
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) { selectTab(tab.dataset.tab); return; }
    const cat = e.target.closest('[data-cat]');
    if (cat) { s.cat = cat.dataset.cat; rerender(); return; }
    if (e.target.closest('[data-sort-btn]')) { toggleSortMenu(); return; }
    const sortItem = e.target.closest('[data-sort]');
    if (sortItem) { chooseSort(sortItem.dataset.sort); closeSortMenu(true); return; }
    const head = e.target.closest('[data-sort-key]');
    if (head) { chooseSort(head.dataset.sortKey); return; }
    if (e.target.closest('[data-watch-only]')) { s.watch = !s.watch; rerender(); return; }
    if (e.target.closest('[data-filter-btn]')) { panel() ? closeFilter(true) : openFilter(); return; }
    if (e.target.closest('[data-filter-close]')) { closeFilter(true); return; }
    if (e.target.closest('[data-filter-reset]')) { Object.assign(s, { job: 'all', lmin: null, lmax: null, few: true, cash: true, sold: false, drop: false }); syncFilterInputs(); rerender(); return; }
    const job = e.target.closest('[data-job]');
    if (job) { s.job = job.dataset.job; rerender(); return; }
    const lv = e.target.closest('[data-lv]');
    if (lv) {
      const [lo, hi] = lv.dataset.lv.split('-').map(Number);
      const same = s.lmin === lo && s.lmax === hi;
      s.lmin = same ? null : lo;
      s.lmax = same ? null : hi;
      syncFilterInputs();
      rerender();
      return;
    }
    const sw = e.target.closest('[data-sw]');
    if (sw) { s[sw.dataset.sw] = !s[sw.dataset.sw]; rerender(); return; }
    const row = e.target.closest('tr[data-open]');
    if (row && !e.target.closest('a')) openItemPage(Number(row.dataset.open), row);
  }

  function chooseSort(key) {
    if (s.sort === key && key!=='recent') s.dir = s.dir === 'asc' ? 'desc' : 'asc';
    else { s.sort = key; s.dir = SORTS[key].dir; }
    rerender();
    rebuildHead();
  }
  function rebuildHead() {
    const table = main.querySelector('[data-table="all"]');
    if (!table) return;
    const focusKey = document.activeElement?.dataset?.sortKey;
    table.querySelector('thead').outerHTML = tableHead(s, true);
    if (focusKey) table.querySelector(`[data-sort-key="${focusKey}"]`)?.focus();
  }

  function onInput(e) {
    if(e.target.closest('[data-sales-host]')) return;
    if (e.target.matches('[data-q]')) {
      clearTimeout(typing);
      typing = setTimeout(() => { s.q = e.target.value.trim(); rerender(); }, 120);
    } else if (e.target.matches('[data-lmin], [data-lmax]')) {
      clearTimeout(typing);
      typing = setTimeout(() => {
        const v = intParam(e.target.value.trim());
        s[e.target.matches('[data-lmin]') ? 'lmin' : 'lmax'] = v === 0 && e.target.matches('[data-lmin]') ? null : v;
        rerender();
      }, 200);
    }
  }

  function onKey(e) {
    if(e.target.closest?.('[data-sales-host]')) return;
    if (e.key === 'Escape') {
      if (panel()) { closeFilter(true); return; }
      if (!main.querySelector('.sortmenu')?.hidden) { closeSortMenu(true); return; }
    }
    if (e.key === 'Tab') {
      const sheet = phone && panel();
      if (sheet) trapFocus(sheet, e);
    }
    const tab = e.target.closest?.('[data-tab]');
    if (tab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const i = TABS.indexOf(tab.dataset.tab);
      selectTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
      return;
    }
    const menu = e.target.closest?.('.sortmenu');
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = [...menu.querySelectorAll('[data-sort]')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      return;
    }
    const row = e.target.closest?.('tr[data-open]');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openItemPage(Number(row.dataset.open), row);
    }
  }

  // Desktop popovers close on an outside click.
  function onDocClick(e) {
    if (!main.contains(e.target)) { closeSortMenu(); if (!phone) closeFilter(); }
    else if (!phone && panel() && !e.target.closest('.fpanel, [data-filter-btn]')) closeFilter();
  }

  /* sort menu */
  function toggleSortMenu() {
    const menu = main.querySelector('.sortmenu');
    if (!menu) return;
    if (!menu.hidden) { closeSortMenu(true); return; }
    menu.hidden = false;
    main.querySelector('[data-sort-btn]').setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-checked=true]') || menu.querySelector('[data-sort]')).focus();
  }
  function closeSortMenu(focusButton) {
    const menu = main.querySelector('.sortmenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const btn = main.querySelector('[data-sort-btn]');
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus();
  }


  function openFilter() {
    const root = main.querySelector('#prices-filter-root');
    if (!root) return;
    closeSortMenu();
    root.innerHTML = (phone ? '<div class="scrim" data-filter-close></div>' : '') + filterPanel(s, ctx.dropOk, phone);
    main.querySelector('[data-filter-btn]').setAttribute('aria-expanded', 'true');
    syncFilterInputs();
    syncFilter();
    root.querySelector('[data-filter-close]:not(.scrim)').focus();
  }
  function closeFilter(focusButton) {
    const root = main.querySelector('#prices-filter-root');
    if (!root || !root.innerHTML) return;
    root.innerHTML = '';
    const btn = main.querySelector('[data-filter-btn]');
    btn?.setAttribute('aria-expanded', 'false');
    if (focusButton) btn?.focus();
  }

  /* item drawer (tablet and desktop); `?item=` keeps it shareable */
  function openItemPage(id) {
    const url=new URL(itemHref(id),location.href);url.searchParams.set('hours',hours);
    if(lang==='en')url.searchParams.set('lang','en');
    location.assign(url.pathname+url.search);
  }

  /* lifecycle */
  const onLayout = () => {
    layout();
    renderAll({ chunked: false });
  };
  const onWatch = () => { if (s.watch) renderAll({ chunked: false }); };
  layout();
  main.addEventListener('click', onClick);
  const warmSales=event=>{if(event.target.closest('[data-tab=sales]'))loadSales().then(mod=>mod.ensureListsCss()).catch(()=>{});};
  main.addEventListener('pointerover',warmSales,{passive:true});
  main.addEventListener('pointerdown',warmSales,{passive:true});
  main.addEventListener('focusin',warmSales);
  main.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick);
  document.addEventListener('watchchange', onWatch);
  phoneQuery.addEventListener('change', onLayout);
  start();
  return () => {
    periodRevision++;
    salesMountRevision++;
    stopList?.();
    stopSales?.();
    clearTimeout(typing);
    main.querySelectorAll('[data-list]').forEach((el) => el.cancel?.());
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('watchchange', onWatch);
    phoneQuery.removeEventListener('change', onLayout);
  };
}

