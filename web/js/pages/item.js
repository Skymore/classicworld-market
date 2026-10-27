import { ready as userDataReady, userStorage as localStorage } from '../lib/user-data.js';
import { refreshTimes } from '../lib/time.js';
import { applyOfferSort, getOfferRows } from '../lib/item-offer-sort.js?v=20261023-advanced-offers-1';
import { normalizeOfferFilters } from '../lib/item-offer-filters.js?v=20261027-watch-groups-1';
import { bindOfferFilters } from '../lib/item-offer-panel.js?v=20261023-advanced-offers-1';
import { bindTrends } from '../lib/trend.js?v=20261021-trend-values-2';
import { readPeriod, resolvePeriod, decoratePeriod, automaticPeriod, savePeriod } from '../lib/period.js?v=20261022-regressions-1';
// Item page behaviour on top of the server-rendered markup: tabs, channel
// groups, ladder tiers, "more" lists, the watchlist star, the bonus-stats
// switch, and change-event refresh.
//
// Refresh: live() reads /api/v1/item/<id> with its ETag, so an unchanged
// market costs a 304. When this item's numbers moved (listing count, newest
// sale, typical price) it fetches the server-rendered market sections
// (/item/<id>?part=market) and swaps the [data-market] blocks, so the
// markup has one renderer (Rust) and this file only keeps UI state.
import { api, live } from '../lib/api.js?v=20261022-auto-watch-2';
import { bindTabs, setFreshness } from '../lib/chrome.js?v=20261022-regressions-1';

const html = document.documentElement;


const stall = document.querySelector('.item-stall');
// Older cached HTML may still include this entry alongside the React shell.
// Let the current shell own that page so two controllers cannot mutate it.
if (stall && !document.querySelector('script[src^="/web/react/shell.js"]')) init(stall);

async function init(stall) {
  await userDataReady;
  // Bind the visible control immediately; resolving the statistics period may
  // involve a network request. A native select must never look active while its
  // sorting handler is still waiting for that request.
  const state = { tab: 'ladder', channels: new Map(), tier: null, more: new Set(), bonusOnly: false };
  try{state.offerSort=localStorage.getItem('market.offerSort')==='recent'?'recent':'price';}catch{state.offerSort='price';}
  const filterKey = `item.offerFilters.${stall.dataset.item}`;
  try { state.offerFilters = normalizeOfferFilters(JSON.parse(localStorage.getItem(filterKey))); }
  catch { state.offerFilters = normalizeOfferFilters(); }
  if (!stall.querySelector('.listing-offer')) state.offerFilters.equipment = 'all';
  let offerPanel;
  const applyOffers = () => {
    applyOfferSort(stall, state.offerSort, state.offerFilters);
    offerPanel?.refresh();
  };
  const saveOffers = () => {
    try {
      localStorage.setItem('market.offerSort', state.offerSort);
      localStorage.setItem(filterKey, JSON.stringify(state.offerFilters));
    } catch { /* private mode */ }
    applyOffers();
  };
  offerPanel = bindOfferFilters(stall, {
    read: () => state.offerFilters, rows: () => getOfferRows(stall),
    apply: filters => { state.offerFilters = normalizeOfferFilters(filters); saveOffers(); },
  });
  applyOffers();
  stall.addEventListener('change', e => {
    if (e.target.matches('[data-offer-sort]')) state.offerSort = e.target.value === 'recent' ? 'recent' : 'price';
    else return;
    saveOffers();
  });
  // Browser form restoration must not leave the selected label and DOM order
  // disagreeing after back/forward navigation.
  addEventListener('pageshow', applyOffers);
  // A quotation can age out even when the market sends no new data.
  setInterval(() => {
    if (!document.hidden && state.offerFilters.hours !== 'all') applyOffers();
  }, 30000);
  const period = await resolvePeriod();
  const url = new URL(location.href);
  if (url.searchParams.get('hours') !== period) {
    url.searchParams.set('hours',period);
    if(automaticPeriod())url.searchParams.set('auto_period','1');
    location.replace(url);return;
  }
  decoratePeriod(stall.querySelector('[data-item-period]'),period);
  stall.querySelector('[data-item-period]')?.addEventListener('change',async e => {
    const choice=e.target.value,saved=savePeriod(choice),next=choice==='auto'?await resolvePeriod():saved;
    if(e.target.value!==choice)return;
    const target = new URL(location.href);target.searchParams.set('hours',next);
    if(choice==='auto')target.searchParams.set('auto_period','1');else target.searchParams.delete('auto_period');
    location.assign(target);
  });
  // Refresh the stylesheet once for browsers retaining the previous layout.
  const css = document.querySelector('link[href*="/web/css/item.css"]');
  if(css) { const href=new URL(css.href); if(href.searchParams.get('v')!=='20261023-advanced-offers-1') { href.searchParams.set('v','20261023-advanced-offers-1'); css.href=href.href; } }
  const id = Number(stall.dataset.item);
  // What the visitor opened or picked; re-applied after every swap.
  let mark = null, refreshing = false;
  state.refreshOfferPanel = () => offerPanel.refresh();

  setFreshness(Number(stall.dataset.asOf));
  bindStar(stall.querySelector('[data-star]'), id);
  bindTabs(stall, null, (key) => { state.tab = key; });
  bindTrends(stall);
  stall.addEventListener('click', (e) => onClick(e, stall, state));
  addEventListener('resize', () => {
    // Desktop shows recent sales in their own panel, not as a tab.
    if (html.dataset.device === 'desktop' && state.tab === 'sales') selectTab(stall, 'ladder', state);
  });

  const stop = live(api.item(id), (data) => {
    const next = markOf(data);
    if (next === mark || refreshing) return;
    refreshing = true;
    swapMarket(stall, id, state).then(() => { mark = next; }).catch((e) => console.warn('item refresh failed', e)).finally(() => { refreshing = false; });
  }, {
    notifyUnchanged: true,
    // 404: the market has never seen this item; nothing to refresh.
    onError: (e) => { if (e.status === 404) stop(); },
  });
}

// Compare complete market content; the SSR data-mark is only an initial hint.
function markOf(data) {
  // Actual quotes, stock, locations, variants and daily points can change
  // while the listing count and sale median remain unchanged.
  return JSON.stringify([data.product, data.listings, data.sales, data.daily]);
}

async function swapMarket(stall, id, state) {
  const lang = html.dataset.lang === 'en' ? '&lang=en' : '';
  const res = await fetch(`/item/${id}?part=market&hours=${readPeriod()}${lang}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Item refresh ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const root = doc.body.firstElementChild;
  const openOffers = new Set([...stall.querySelectorAll('[data-offer][open]')].map(el => el.dataset.offer));
  const incoming = new Map([...doc.querySelectorAll('[data-market]')].map((el) => [el.dataset.market, el]));
  for (const old of stall.querySelectorAll('[data-market]')) {
    const next = incoming.get(old.dataset.market);
    if (next) old.replaceWith(document.importNode(next, true));
    else old.remove();
    incoming.delete(old.dataset.market);
  }
  // A section that was not there before (equipment stats) goes after "where to buy".
  for (const el of incoming.values()) stall.querySelector('[data-market=where]')?.after(document.importNode(el, true));
  stall.dataset.mark = root?.dataset.mark ?? '';
  stall.dataset.asOf = root?.dataset.asOf ?? stall.dataset.asOf;
  setFreshness(Number(stall.dataset.asOf));
  for (const offer of stall.querySelectorAll('[data-offer]')) offer.open = openOffers.has(offer.dataset.offer);
  refreshTimes(stall);
  restore(stall, state);
  bindTrends(stall);
}

function onClick(e, stall, state) {
  const head = e.target.closest('[data-ch]');
  if (head) {
    const group = head.closest('.cgroup');
    const open = group.classList.toggle('open');
    head.setAttribute('aria-expanded', String(open));
    state.channels.set(group.dataset.chKey, open);
    return;
  }
  const rung = e.target.closest('[data-tier]');
  if (rung) {
    state.tier = Number(rung.dataset.tier);
    selectTier(rung.closest('.pane'), state.tier);
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    state.more.add(more.dataset.more);
    more.closest('.well')?.classList.add('all');
    return;
  }
  const bonus = e.target.closest('[data-bonus-only]');
  if (bonus) {
    state.bonusOnly = !state.bonusOnly;
    applyBonus(stall, state.bonusOnly);
  }
}

function selectTier(pane, index) {
  if (!pane) return;
  const rungs = pane.querySelectorAll('[data-tier]');
  if (!rungs.length || index >= rungs.length) return;
  for (const r of rungs) {
    const on = Number(r.dataset.tier) === index;
    r.classList.toggle('sel', on);
    r.setAttribute('aria-pressed', String(on));
  }
  for (const p of pane.querySelectorAll('[data-read]')) p.hidden = Number(p.dataset.read) !== index;
}

// Mirrors bindTabs() for a programmatic switch.
function selectTab(stall, key, state) {
  const btn = stall.querySelector(`[data-tab="${key}"]`);
  if (!btn) return;
  state.tab = key;
  const list = btn.closest('.tabs');
  for (const b of list.querySelectorAll('[data-tab]')) {
    const on = b === btn;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const pane of list.parentElement.querySelectorAll(':scope > [data-pane]')) pane.hidden = pane.dataset.pane !== key;
}

function applyBonus(stall, on) {
  stall.classList.toggle('bonus-only', on);
  const btn = stall.querySelector('[data-bonus-only]');
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
}

function restore(stall, state) {
  if (state.tab !== 'ladder') selectTab(stall, state.tab, state);
  for (const [key, open] of state.channels) {
    const group = stall.querySelector(`.cgroup[data-ch-key="${CSS.escape(key)}"]`);
    if (!group) continue;
    group.classList.toggle('open', open);
    group.querySelector('[data-ch]')?.setAttribute('aria-expanded', String(open));
  }
  applyOfferSort(stall,state.offerSort,state.offerFilters);
  state.refreshOfferPanel?.();
  if (state.tier != null) selectTier(stall.querySelector('[data-pane=ladder]'), state.tier);
  for (const key of state.more) {
    for (const btn of stall.querySelectorAll(`[data-more="${key}"]`)) btn.closest('.well')?.classList.add('all');
  }
  applyBonus(stall, state.bonusOnly);
}

// ---------- watchlist star ----------

// localStorage `watchlist`: JSON array of item ids, shared with the prices
// and watch pages. Entries in other shapes are kept as they are.
function readWatchlist() {
  try {
    const list = JSON.parse(localStorage.getItem('watchlist'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const isEntry = (entry, id) => entry === id || entry?.item_id === id;

function bindStar(btn, id) {
  if (!btn) return;
  const show = () => btn.setAttribute('aria-pressed', String(readWatchlist().some((w) => isEntry(w, id))));
  btn.addEventListener('click', () => {
    const list = readWatchlist();
    if(list.length>=100&&!list.some(w=>isEntry(w,id))){btn.title=document.documentElement.lang.startsWith('zh')?'最多关注 100 个商品':'Up to 100 watches';return;}
    const next = list.some((w) => isEntry(w, id)) ? list.filter((w) => !isEntry(w, id)) : [...list, id];
    try { localStorage.setItem('watchlist', JSON.stringify(next)); } catch { /* private mode */ }
    show();
  });
  // Another tab (the prices page) may change the list.
  addEventListener('storage', (e) => { if (e.key === 'watchlist') show(); });
  show();
}
