import { readPeriod, savePeriod } from '../lib/period.js?v=20261022-regressions-1';
import { priceUnit } from '../lib/market-source.js?v=20261022-external-1';
import { itemNames } from '../lib/names.js';
// /sales: every item's recent sales, newest first (plan v1 §5.4). Rows are
// the mockup's recent-sale rows (`ware two` / `ware one`) with the sale row's
// evidence label and quantity. Category is a server filter; evidence kind,
// watchlist and time range filter the loaded rows. Filters live in the URL.
//
// Relative ages and time ranges use the real current time.
import { api, getJson, live } from '../lib/api.js?v=20261022-auto-watch-2';
import { t, addMessages, itemName, lang } from '../lib/i18n.js';
import { esc, meso, ago, loc, fullTime } from '../lib/format.js';
import { I } from '../lib/icons.js';
import { setFreshness } from '../lib/chrome.js?v=20261022-regressions-1';
import { readList, LIST_KEY } from '../lib/watchlist-core.js';
import { ensureListsCss, icon, emptyState, filterPanel, hideBroken } from './watch.js?v=20261023-watch-cap-1';
export { ensureListsCss };

const PAGE_SIZE = 50;
// Server category names (`/api/v1/sales/recent?category=`) and their labels.
const CATS = [['', 'lists.cat.all'], ['装备', 'lists.cat.equip'], ['消耗品', 'lists.cat.use'], ['其他', 'lists.cat.etc'], ['商城物品', 'lists.cat.cash']];
const KINDS = ['', 'drop', 'sold_out', 'found_sold'];
const RANGES = { 24: 24, 72: 72, all: null };
// Stop chasing pages when filters hide every row: one screen is enough proof.
const MAX_EMPTY_PAGES = 6;

addMessages({
  zh: {
    'sales.title': '成交', 'sales.meta': '显示 {n} 条 · 新的在前',
    'sales.note': '时间是发现时间，不是实际成交时间。发现已售 = 第一次看到时已经卖完；看到卖光 / 看到卖出 = 两次访问之间库存变成 0 / 变少。',
    'sales.empty': '冒险家，换个筛选试试。', 'sales.end': '没有更早的成交了', 'sales.range_end': '时间范围内没有更多成交',
    'sales.more': '加载更多', 'sales.kind': '证据类型', 'sales.kind_all': '全部', 'sales.range': '时间范围',
    'sales.range_24': '24 小时', 'sales.range_72': '72 小时', 'sales.range_all': '全部', 'sales.range_note': '按当前时间往前计算，具体时间使用你的浏览器时区。',
  },
  en: {
    'sales.title': 'Sales', 'sales.meta': '{n} shown · newest first',
    'sales.note': 'Times are when a sale was found, not when it happened. Found sold = already sold out on first sight; seen sold out / seen sold = stock went to 0 / dropped between two visits.',
    'sales.empty': 'No sales match these filters.', 'sales.end': 'No older sales', 'sales.range_end': 'No more sales in this time range',
    'sales.more': 'Load more', 'sales.kind': 'Evidence', 'sales.kind_all': 'All', 'sales.range': 'Time range',
    'sales.range_24': '24 h', 'sales.range_72': '72 h', 'sales.range_all': 'All', 'sales.range_note': 'Counted back from now. Dates use your browser timezone.',
  },
});

function filtersFromUrl() {
  const q = new URLSearchParams(location.search);
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    category: pick(q.get('cat') || '', CATS.map(([c]) => c), ''),
    kind: pick(q.get('kind') || '', KINDS, ''),
    range: pick(q.get('range') || readPeriod(), Object.keys(RANGES), '72'),
    watchOnly: q.get('watch') === '1',
  };
}

function filtersToUrl(f) {
  const url = new URL(location.href);
  const set = (key, value) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  set('cat', f.category);
  set('kind', f.kind);
  set('range', f.range === '72' ? '' : f.range);
  set('watch', f.watchOnly ? '1' : '');
  history.replaceState(history.state, '', url);
}

export async function mount(main, { embedded = false } = {}) {
  await ensureListsCss();
  const filters = filtersFromUrl();
  let stopped=false,headReady=false;
  const state = {
    rows: [], ids: new Set(), nextBefore: null, done: false, loading: false, asOf: null,
    gen: 0, emptyPages: 0, watched: new Set(readList(localStorage)),
  };
  main.innerHTML = `<div class="lwrap ${embedded ? 'sales-embedded' : ''}">${frame()}</div>`;
  const page = main.querySelector('.lpage');
  const list = page.querySelector('[data-list]');
  const foot = page.querySelector('[data-foot]');
  const meta = page.querySelector('[data-meta]');
  const panel = filterPanel(page, panelBody, onPanel);
  hideBroken(page);

  const cutoff = () => (RANGES[filters.range] == null ? null : Date.now()/1000 - RANGES[filters.range] * 3600);
  const visible = (s) => (!filters.kind || s.kind === filters.kind)
    && (!filters.watchOnly || state.watched.has(s.item_id))
    && (!filters.category || s.category === filters.category)
    && (cutoff() == null || s.time >= cutoff());
  const pastRange = () => cutoff() != null && state.rows.length && state.rows.at(-1).time < cutoff();

  function frame() {
    const cats = CATS.map(([c, key]) => `<button type="button" class="cat ${c === filters.category ? 'on' : ''}" role="tab" aria-selected="${c === filters.category}" data-cat="${esc(c)}">${esc(t(key))}</button>`).join('');
    return `<section class="stall lpage sales-page">
      <div class="lhead">${embedded ? '' : `<div class="stall-bar"><h1>${esc(t('sales.title'))}</h1><span class="bar-meta" data-meta></span></div>`}
        <div class="ltools"><div class="cats" role="tablist" aria-label="${esc(t('lists.categories'))}">${cats}</div><span class="sp"></span>
          <button type="button" class="toggle lwide ${filters.watchOnly ? 'on' : ''}" aria-pressed="${filters.watchOnly}" data-watch-only><i></i>${esc(t('lists.watch_only'))}</button>
          <button type="button" class="sortbtn" aria-label="${lang==='en'?'Filter sales':'筛选成交记录'}" data-filter aria-expanded="false" aria-haspopup="dialog">${I.funnel}<span class="lwide">${esc(t('lists.filter'))}</span><b class="fcount" data-fcount hidden></b></button>
          <div id="filter-root"></div></div></div>
      <div class="llist" data-list>${emptyState(t('common.loading'), 0, false)}</div>
      <div class="lfoot" data-foot></div>
      <p class="sale-note">${esc(t('sales.note'))}</p></section>`;
  }

  function panelBody() {
    const chip = (group, value, label, on) => `<button type="button" class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-chip="${group}" data-value="${esc(value)}">${esc(label)}</button>`;
    const kinds = KINDS.map((k) => chip('kind', k, k ? t('evidence.' + k) : t('sales.kind_all'), filters.kind === k)).join('');
    const ranges = Object.keys(RANGES).map((r) => chip('range', r, t('sales.range_' + r), filters.range === r)).join('');
    return `<div class="fsec"><h4>${esc(t('sales.kind'))}</h4><div class="chips">${kinds}</div></div>
      <div class="fsec"><h4>${esc(t('sales.range'))}<small>${esc(t('sales.range_note'))}</small></h4><div class="chips">${ranges}</div></div>
      <div class="fsec lnarrow"><h4>${esc(t('lists.show'))}</h4><button type="button" class="toggle sw ${filters.watchOnly ? 'on' : ''}" aria-pressed="${filters.watchOnly}" data-watch-only><i></i><span><b>${esc(t('lists.watch_only'))}</b><small>${esc(t('lists.watch_only_sub'))}</small></span></button></div>`;
  }

  function onPanel(e) {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      filters[chip.dataset.chip] = chip.dataset.value;
      if(chip.dataset.chip==='range' && ['72','all'].includes(chip.dataset.value))savePeriod(chip.dataset.value);
      return applyFilters();
    }
    if (e.target.closest('[data-reset]')) {
      Object.assign(filters, { kind: '', range: '72', watchOnly: false });
      savePeriod('72');
      return applyFilters();
    }
    return undefined;
  }

  // Phone: name over evidence + location; price over time (+ quantity when
  // known). Desktop lays the same spans out as one row (lists.css).
  function row(s) {
    const where = s.location ? loc(s.location.channel, s.location.room, s.location) : loc(null);
    const qty = s.quantity != null ? `<span class="sq">×${Number(s.quantity)}</span>` : '';
    return `<a class="ware srow" href="/item/${Number(s.item_id)}" data-item-row data-id="${esc(s.id)}">${icon(s.icon_url)}
      <span class="w-main"><span class="ware-name">${itemNames(s)}</span>
        <span class="w-sub"><span class="evi ${esc(s.kind)}">${esc(t('evidence.' + s.kind))}</span>${where}</span></span>
      <span class="s-right"><span class="ware-price">${meso(s.sale_unit_price)}${priceUnit(s)}${qty}</span><time class="sa" data-t="${s.time}" data-relative-time="${s.time}" title="${esc(fullTime(s.time))}">${esc(ago(s.time))}</time></span></a>`;
  }

  // Header counters, filter badge, the end-of-list line and the load button.
  function decorate() {
    const shown = list.querySelectorAll('[data-item-row]').length;
    if(meta) meta.textContent = t('sales.meta', { n: shown });
    const active = (filters.kind ? 1 : 0) + (filters.range !== '72' ? 1 : 0) + (filters.watchOnly ? 1 : 0);
    for (const b of page.querySelectorAll('[data-fcount]')) { b.hidden = !active; b.textContent = active || ''; }
    for (const b of page.querySelectorAll('[data-watch-only]')) { b.classList.toggle('on', filters.watchOnly); b.setAttribute('aria-pressed', String(filters.watchOnly)); }
    panel.setCount(t('lists.show_n', { n: shown }));
    if (state.done || pastRange()) {
      foot.innerHTML = state.rows.length ? `<p class="lend">${esc(t(state.done ? 'sales.end' : 'sales.range_end'))}</p>` : '';
    } else if (!state.loading) {
      foot.innerHTML = `<button type="button" class="more" data-more>${esc(t('sales.more'))} ${I.chev}</button>`;
    }
  }

  function render() {
    const html = state.rows.filter(visible).map(row).join('');
    list.innerHTML = html || (state.loading ? emptyState(t('common.loading'), 0, false) : emptyState(t('sales.empty'), 2));
    decorate();
  }

  function applyFilters() {
    filtersToUrl(filters);
    panel.refresh();
    render();
    pump();
  }

  function append(sales) {
    const fresh = sales.filter((s) => !state.ids.has(s.id));
    for (const s of fresh) state.ids.add(s.id);
    state.rows.push(...fresh);
    return fresh;
  }

  function setPage(data) {
    state.rows = [];
    state.ids.clear();
    append(data.sales);
    state.nextBefore = data.next_before;
    state.done = data.next_before == null;
  }

  // Track upload freshness separately from the real clock used by row ages.
  function advanceClock(sales, asOf) {
    const newest = sales.reduce((m, s) => Math.max(m, s.time), Math.max(state.asOf ?? 0, asOf ?? 0));
    if (!newest || newest === state.asOf) return false;
    state.asOf = newest;
    setFreshness(state.asOf);
    return true;
  }

  async function loadPage() {
    const gen = state.gen;
    state.loading = true;
    decorate();
    try {
      const params = { limit: PAGE_SIZE, category: filters.category || null, before: state.nextBefore };
      const { data } = await getJson(api.recentSales(params));
      if (gen !== state.gen) return;
      const before = list.querySelectorAll('[data-item-row]').length;
      advanceClock(data.sales, data.as_of);
      let fresh;
      if (state.rows.length) fresh = append(data.sales);
      else { setPage(data); fresh = state.rows; }
      state.nextBefore = data.next_before;
      state.done = data.next_before == null;
      // Append only the new page's rows; the rows above stay as they are.
      const added = fresh.filter(visible);
      if (before) list.insertAdjacentHTML('beforeend', added.map(row).join(''));
      state.emptyPages = added.length ? 0 : state.emptyPages + 1;
    } catch (e) {
      if (gen === state.gen) foot.innerHTML = `<p class="lend" role="alert">${esc(t('common.error'))}</p>`;
      state.done = true;
      console.warn(e);
    } finally {
      if (gen === state.gen) state.loading = false;
    }
    if (gen === state.gen && !list.querySelector('[data-item-row]')) render(); else decorate();
  }

  const nearBottom = () => foot.getBoundingClientRect().top < innerHeight + 800;
  async function pump() {
    if(!headReady || stopped) return;
    while (!stopped && !state.loading && !state.done && !pastRange() && state.emptyPages < MAX_EMPTY_PAGES && (nearBottom() || !list.querySelector('[data-item-row]'))) {
      await loadPage();
    }
  }

  // Prepend sales newer than the top row without touching the rows below.
  function onHead(data) {
    const moved = advanceClock(data.sales, data.as_of);
    if (!state.rows.length && !filters.category) {
      setPage(data);
      render();
      return;
    }
    if (!state.rows.length) return;
    const top = state.rows[0].time;
    const overlap = data.sales.some((s) => state.ids.has(s.id)) || (data.sales.at(-1)?.time ?? -Infinity) <= top;
    if (!overlap && !filters.category) {
      // More than a page arrived since the last check: start over.
      state.gen += 1;
      setPage(data);
      render();
      return;
    }
    const fresh = data.sales.filter((s) => !state.ids.has(s.id) && s.time >= top && (!filters.category || s.category === filters.category));
    for (const s of fresh) state.ids.add(s.id);
    state.rows.unshift(...fresh);
    if (moved && cutoff() != null) return render(); // the window slid: some rows leave it
    const shown = fresh.filter(visible);
    if (shown.length && list.querySelector('[data-item-row]')) list.insertAdjacentHTML('afterbegin', shown.map(row).join(''));
    else if (shown.length) render();
    if (moved) for (const el of list.querySelectorAll('time[data-t]')) el.textContent = ago(Number(el.dataset.t));
    decorate();
  }

  function setCategory(category) {
    if (category === filters.category) return;
    filters.category = category;
    for (const b of page.querySelectorAll('[data-cat]')) {
      const on = b.dataset.cat === category;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    filtersToUrl(filters);
    state.gen += 1;
    Object.assign(state, { rows: [], nextBefore: null, done: false, loading: false, emptyPages: 0 });
    state.ids.clear();
    render();
    pump();
  }

  page.addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) return setCategory(cat.dataset.cat);
    if (e.target.closest('[data-watch-only]')) {
      filters.watchOnly = !filters.watchOnly;
      return applyFilters();
    }
    if (e.target.closest('[data-more]')) {
      state.emptyPages = 0;
      return loadPage().then(pump);
    }
    return undefined;
  });
  const onStorage = (e) => {
    if (e.key !== LIST_KEY) return;
    state.watched = new Set(readList(localStorage));
    if (filters.watchOnly) render();
  };
  addEventListener('storage', onStorage);
  const observer = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) pump(); }, { rootMargin: '800px 0px' });
  observer.observe(foot);

  // Load older rows after the head arrives without blocking navigation cleanup.
  const stopPoll = live(api.recentSales({ limit: PAGE_SIZE }), onHead, {
    onError: (e) => {
      console.warn(e);
      if (!state.rows.length) list.innerHTML = `<p class="lend" role="alert">${esc(t('common.error'))}</p>`;
    },
  });
  stopPoll.first.then(()=>{if(stopped)return;headReady=true;pump();});

  const ageTimer=setInterval(render,30000);
  return () => {
    stopped=true;
    clearInterval(ageTimer);
    state.gen += 1;
    stopPoll();
    observer.disconnect();
    panel.close();
    removeEventListener('storage', onStorage);
  };
}
