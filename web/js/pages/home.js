import { readPeriod, resolvePeriod, decoratePeriod, savePeriod, periodControl, periodLabel, periodProduct, inPeriod } from '../lib/period.js?v=20261022-regressions-1';
import { bindQuickSearch } from '../lib/quick-search.js?v=20261023-header-icons-2';
import { refreshTimes } from '../lib/time.js';
// Home `/` (design/mockups-v2 *-home-*.png): unified search with an item
// type-ahead, three portals, and one "今日市场" stall with three tabs.
// Data: /api/v1/market?view=list (rows, as_of) and /api/v1/sales/recent?limit=8,
// refreshed by committed market events with ETags.
import { t, addMessages } from '../lib/i18n.js';
import { I } from '../lib/icons.js';
import { esc, num, mobImg } from '../lib/format.js';
import { api, live, getJson } from '../lib/api.js?v=20261022-auto-watch-2';
import { setFreshness, tabsBlock, bindTabs } from '../lib/chrome.js?v=20261022-regressions-1';
import { skeletonRows, emptyState, errorState, bindRetry, hideBrokenImages } from '../lib/states.js';
import { byChange, byBusy, changeWare, busyWare, saleWare } from '../lib/rows.js?v=20261022-regressions-1';

addMessages({
  zh: {
    'home.title': '今天想买点什么？', 'home.lead': '查成交价、看哪个洞有货、找哪只怪会掉。',
    'home.collector':'下载采集器', 'home.portals': '快捷入口', 'home.p_prices': '价格表', 'home.p_prices_n': '{n} 件物品',
    'home.p_mobs': '图鉴', 'home.p_mobs_sub': '物品、怪物和地图', 'home.p_maps': '地图', 'home.p_maps_sub': '传送和路线', 'home.p_mobs_n': '物品 · 怪物 · 地图', 'home.p_maps_n': '{n} 张地图',
    'home.market': '市场概览', 'home.market_meta': '按当前时间统计',
    'home.tab_recent': '最近成交', 'home.tab_changes': '涨跌榜', 'home.tab_busy': '成交最多',
    'home.more_recent': '全部成交记录', 'home.more_changes': '完整涨跌榜', 'home.more_busy': '按成交量看价格表',
    'home.no_sales': '还没有成交记录。', 'home.no_changes': '所选时段没有可比较的涨跌。', 'home.no_busy': '所选时段没有成交。',
    'home.contributors':'采集贡献榜', 'home.foot': '采集器下载与使用说明', 'home.suggest': '物品建议',
  },
  en: {
    'home.title': 'What are you shopping for today?', 'home.lead': 'Check sale prices, find which room has stock, see which monster drops it.',
    'home.collector':'Download collector', 'home.portals': 'Shortcuts', 'home.p_prices': 'Prices', 'home.p_prices_n': '{n} items',
    'home.p_mobs': 'Catalogue', 'home.p_mobs_sub': 'Items, monsters & maps', 'home.p_maps': 'Maps', 'home.p_maps_sub': 'Portals & routes', 'home.p_mobs_n': 'Items · Monsters · Maps', 'home.p_maps_n': '{n} maps',
    'home.market': 'Market overview', 'home.market_meta': 'Relative to now',
    'home.tab_recent': 'Recent sales', 'home.tab_changes': 'Movers', 'home.tab_busy': 'Most sold',
    'home.more_recent': 'All recent sales', 'home.more_changes': 'All movers', 'home.more_busy': 'Price table by sales',
    'home.no_sales': 'No sales recorded yet.', 'home.no_changes': 'No comparable price changes in this period.', 'home.no_busy': 'No sales in this period.',
    'home.contributors':'Contributors', 'home.foot': 'Download collector & getting started', 'home.suggest': 'Item suggestions',
  },
});

const ROWS = 8;
const TABS = ['recent', 'changes', 'busy'];
const MORE = { recent: ['home.more_recent', '/prices?tab=sales'], changes: ['home.more_changes', '/prices?tab=changes'], busy: ['home.more_busy', '/prices?tab=busy'] };
const wideQuery = matchMedia('(min-width: 641px)');
const desktopQuery = matchMedia('(min-width: 1101px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export async function mount(main) {
  let hours = await resolvePeriod();
  if(!main.isConnected)return ()=>{};
  let revision = 0;
  const state = { list: null, sales: null, listError: false, salesError: false };
  let stopList = null;
  let stopSales = null;

  main.innerHTML = `${hero()}<section class="stall tabs-well home-market">
      <div class="stall-bar"><h2>${esc(t('home.market'))}</h2>${periodControl(hours)}</div>
      ${tabsBlock(TABS, { recent: t('home.tab_recent'), changes: t('home.tab_changes'), busy: t('home.tab_busy') }, panes(), 'recent', 'list')}
    </section>
    <p class="foot home-foot"><img src="${mobImg(100100)}" alt="" width="32" height="32"><a href="/contributors">${esc(t('home.contributors'))}</a> · <a href="/web/download.html">${esc(t('home.foot'))}</a></p>`;
  const market = main.querySelector('.home-market');
  hideBrokenImages(main);
  bindTabs(market, panes());
  market.addEventListener('change',async event=>{ if(!event.target.matches('[data-period]')) return; const choice=event.target.value;const saved=savePeriod(choice);const next=choice==='auto'?await resolvePeriod():saved;if(event.target.value!==choice)return;hours=next;state.list=null;state.sales=null;start(); });
  bindRetry(market, () => { start(); });
  const typeahead = bindQuickSearch(main);

  // Every pane renders from the latest state; hidden panes are cleared and
  // refilled by bindTabs when shown.
  function panes() {
    return {
      recent: () => pane('recent'),
      changes: () => pane('changes'),
      busy: () => pane('busy'),
    };
  }
  function pane(key) {
    const wide = wideQuery.matches;
    const more = `<a class="more" href="${MORE[key][1]}&hours=${hours}">${esc(t(MORE[key][0]))} ${I.chev}</a>`;
    if (key === 'recent') {
      if (!state.sales) return state.salesError ? errorState() : skeletonRows(ROWS, 52);
      const asOf = state.list?.as_of ?? state.sales.generated_at;
      const sales = state.sales.sales.filter(s=>inPeriod(s.time,hours)).slice(0, ROWS);
      return (sales.length ? sales.map((s) => saleWare(s, wide, asOf)).join('') : emptyState(t('home.no_sales'), 0)) + more;
    }
    if (!state.list) return state.listError ? errorState() : skeletonRows(ROWS, wide ? 70 : 44);
    const products = state.list.products;
    if (key === 'changes') {
      const rows = byChange(products).slice(0, ROWS);
      return (rows.length ? rows.map((r) => changeWare(r, wide)).join('') : emptyState(t('home.no_changes'), 1)) + more;
    }
    const rows = byBusy(products).slice(0, ROWS);
    return (rows.length ? rows.map((r) => busyWare(r, wide)).join('') : emptyState(t('home.no_busy'), 2)) + more;
  }
  function render() {
    decoratePeriod(main.querySelector('[data-period]'),hours);
    for (const el of market.querySelectorAll(':scope > [data-pane]')) {
      el.innerHTML = el.hidden ? '' : pane(el.dataset.pane);
    }
    const count = main.querySelector('[data-count="prices"]');
    if (count && state.list) count.textContent = t('home.p_prices_n', { n: num(state.list.products.length) });
    if (state.dex) {
      main.querySelector('[data-count="mobs"]').textContent = t('home.p_mobs_n', { n: num(state.dex.mobs) });
      main.querySelector('[data-count="maps"]').textContent = t('home.p_maps_n', { n: num(state.dex.maps) });
    }
  }

  function start() {
    const generation=++revision;
    stopList?.();
    stopSales?.();
    state.listError = false;
    state.salesError = false;
    stopList = live(api.list(hours), (data) => {
      if(generation!==revision) return;
      state.list = {...data,products:data.products.map(periodProduct)};
      state.listError = false;
      setFreshness(data.as_of);
      render();
    }, { onError: () => { if (!state.list) { state.listError = true; render(); } } });
    stopSales = live(api.recentSales({ limit: ROWS }), (data) => {
      if(generation!==revision) return;
      state.sales = data;
      state.salesError = false;
      render();
    }, { onError: () => { if (!state.sales) { state.salesError = true; render(); } } });
    // Bestiary counts change only on import: one request, cached by ETag.
    // On failure the portals keep their description text.
    getJson(api.dexCounts(),{maxAgeMs:60000}).then(({ data }) => { if(generation!==revision)return;state.dex = data; render(); }).catch(() => {});
    render();
    return Promise.all([stopList.first, stopSales.first]);
  }

  const onLayout = () => render();
  wideQuery.addEventListener('change', onLayout);
  start();
  const ageTimer=setInterval(()=>refreshTimes(market),30000);
  return () => {
    clearInterval(ageTimer);
    revision++;
    stopList?.();
    stopSales?.();
    typeahead();
    wideQuery.removeEventListener('change', onLayout);
  };
}

function hero() {
  const finder = `<form class="finder" action="/search" method="get" role="search">${I.search}
      <input type="search" name="q" placeholder="${esc(t('search.placeholder'))}" aria-label="${esc(t('search.placeholder'))}"
        autocomplete="off" spellcheck="false">
      ${desktopQuery.matches ? '<kbd>/</kbd>' : ''}
      </form>`;
  const portals = `<nav class="portals" aria-label="${esc(t('home.portals'))}">
      <a class="portal" href="/prices"><span class="p-top">${I.tagSm}${esc(t('home.p_prices'))}</span><small data-count="prices">—</small></a>
      <a class="portal" href="/search?kind=item"><span class="p-top">${I.mob}${esc(t('home.p_mobs'))}</span><small data-count="mobs">${esc(t('home.p_mobs_sub'))}</small></a>
      <a class="portal" href="/search?kind=map"><span class="p-top">${I.map}${esc(t('home.p_maps'))}</span><small data-count="maps">${esc(t('home.p_maps_sub'))}</small></a></nav>`;
  const lead = `<div class="hero-lead"><h1>${esc(t('home.title'))}</h1><p>${esc(t('home.lead'))} <a href="/web/download.html">${esc(t('home.collector'))} ↗</a></p></div>`;
  const snail = `<img class="deco-snail" src="${mobImg(100100, reducedMotion.matches ? 'stand' : 'move')}" alt="">`;
  return `<section class="stall hero">${lead}${finder}${portals}${snail}</section>`;
}
