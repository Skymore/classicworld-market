import { itemNames } from '../lib/names.js';
import { equipmentSummary } from '../lib/equipment-summary.js?v=20261022-1';
import { sortWatchQuotes } from '../lib/quote-order.js?v=20261023-watch-cap-1';
// /watch: the personal watchlist (plan v1 §5.5). Ids live in localStorage
// `watchlist` (the price table's star writes the same key), cap and alert
// switch in `watchlist_settings`; the logic is lib/watchlist-core.js.
// Cards show the current lowest ask from the live watch listings and the
// typical sale price from the market list; below them, the listings that
// satisfy each cap. A new listing under a cap pops a toast.
//
// The list-page helpers at the top (stylesheet, icon, empty state, filter
// panel, toast stack) are shared by sales.js and alerts.js.
import { api, getJson, live, qs } from '../lib/api.js?v=20261022-auto-watch-2';
import { t, addMessages, itemName, lang } from '../lib/i18n.js';
import { esc, meso, ago, loc, fullTime, mobImg } from '../lib/format.js';
import { I } from '../lib/icons.js';
import { setWatchHits, setFreshness } from '../lib/chrome.js?v=20261022-regressions-1';
import Core, { LIST_KEY, SETTINGS_KEY, MAX_WATCHES } from '../lib/watchlist-core.js';

addMessages({
  zh: {
    'lists.filter': '筛选', 'lists.close': '关闭', 'lists.reset': '重置', 'lists.show': '显示', 'lists.show_n': '显示 {n} 条',
    'lists.cat.all': '全部', 'lists.cat.equip': '装备', 'lists.cat.use': '消耗', 'lists.cat.etc': '其他', 'lists.cat.cash': '商城',
    'lists.categories': '分类', 'lists.watch_only': '仅看关注', 'lists.watch_only_sub': '只显示关注列表里的物品',
    'watch.title': '关注', 'watch.meta': '{n} 件物品 · {m} 件有符合条件的在售', 'watch.search': '搜索物品名称或 ID 添加',
    'watch.add': '添加', 'watch.added': '已关注', 'watch.full': '最多关注 100 种物品。', 'watch.no_results': '没有找到，换个关键词试试。',
    'watch.search_failed': '图鉴搜索暂不可用。', 'watch.preset': '弓弩预设',
    'watch.empty': '还没有关注的物品。点任意物品旁的 ☆ 开始关注。',
    'watch.lowest': '当前最低', 'watch.typical': '典型成交价', 'watch.under': '符合上限', 'watch.under_n': '{n} 条',
    'watch.cap': '最高单价', 'watch.cap_short': '上限', 'watch.cap_any': '不限', 'watch.notify': '新报价提醒', 'watch.remove': '取消关注 {name}',
    'watch.matches': '符合条件的在售', 'watch.matches_meta': '{n} 条', 'watch.show_all': '显示全部 {n} 条',
    'watch.sort': '在售报价排序', 'watch.sort_price': '单价从低到高', 'watch.sort_recent': '最新报价优先',
    'watch.no_matches': '暂无符合关注条件的在售报价；继续采集或等待共享市场更新。',
    'watch.note': '添加想买的物品，设置最高单价；保持本页打开，有新低价时提醒你。',
    'watch.help_title': '提醒如何工作？',
    'watch.help': '共享市场的新报价和自己刚逛到的摊位都能提醒。别人之前扫过的报价，自己第一次扫到且符合条件时也会提醒；同次更新只弹一次，反复开同一报价不刷屏。支持装备等所有物品，按最高单价和有货条件筛选。关注清单和价格上限只保存在当前浏览器，不与别人共享。保持本页打开，允许浏览器通知后可在后台接收提醒。实际库存与价格请到游戏内核对。捡漏使用另一套规则。',
    'watch.truncated': '报价较多，只显示最近 200 条观察。', 'watch.failed': '关注报价暂时无法更新，显示的是上次的报价。',
    'watch.stock': '库存 {n}', 'watch.bundle': '{n} 件一组', 'watch.allow_notify': '允许浏览器通知',
    'watch.toast_title': '关注物品有新报价', 'watch.toast_line': '{price} / 件 · 库存 {stock}',
  },
  en: {
    'lists.filter': 'Filter', 'lists.close': 'Close', 'lists.reset': 'Reset', 'lists.show': 'Show', 'lists.show_n': 'Show {n}',
    'lists.cat.all': 'All', 'lists.cat.equip': 'Equip', 'lists.cat.use': 'Use', 'lists.cat.etc': 'Etc', 'lists.cat.cash': 'Cash',
    'lists.categories': 'Categories', 'lists.watch_only': 'Watched only', 'lists.watch_only_sub': 'Only items on your watchlist',
    'watch.title': 'Watchlist', 'watch.meta': '{n} items · {m} with matching offers', 'watch.search': 'Search an item name or ID to add',
    'watch.add': 'Add', 'watch.added': 'Watching', 'watch.full': 'You can watch up to 100 items.', 'watch.no_results': 'Nothing found, try another word.',
    'watch.search_failed': 'Item search is unavailable right now.', 'watch.preset': 'Bow & crossbow preset',
    'watch.empty': 'No watched items yet. Tap the ☆ next to any item to start watching it.',
    'watch.lowest': 'Lowest now', 'watch.typical': 'Typical sale', 'watch.under': 'Under cap', 'watch.under_n': '{n}',
    'watch.cap': 'Max unit price', 'watch.cap_short': 'Cap', 'watch.cap_any': 'any', 'watch.notify': 'New offer alerts', 'watch.remove': 'Stop watching {name}',
    'watch.matches': 'Matching offers', 'watch.matches_meta': '{n}', 'watch.show_all': 'Show all {n}',
    'watch.sort': 'Sort matching offers', 'watch.sort_price': 'Lowest price first', 'watch.sort_recent': 'Latest quotes first',
    'watch.no_matches': 'No offers match your watches yet; keep collecting or wait for the shared market to update.',
    'watch.note': 'Add items and set your maximum unit price. Keep this page open for new low-price offers.',
    'watch.help_title': 'How do notifications work?',
    'watch.help': 'Get alerts for new shared offers and shops you just visited, even if another player saw the offer earlier. One update produces one alert; repeated visits to the same offer do not spam. All items, including equipment, follow your price cap and in-stock rules. Your list and caps stay in this browser. Keep this page open; browser notifications can alert you in the background. Verify prices and stock in game. Deals uses separate rules.',
    'watch.truncated': 'Many offers: showing the latest 200 observations.', 'watch.failed': 'Watch offers could not be updated; showing the last ones.',
    'watch.stock': 'stock {n}', 'watch.bundle': '{n} per bundle', 'watch.allow_notify': 'Allow browser notifications',
    'watch.toast_title': 'New offer on a watched item', 'watch.toast_line': '{price} each · stock {stock}',
  },
});

// ---------------------------------------------------------------- shared helpers

const LISTS_CSS = '/web/css/lists.css?v=20261023-watch-cap-1';

// app.js loads page CSS once the shell maps these pages to lists.css; until
// then (and for direct imports) the page adds it. Same selector as app.js.
export function ensureListsCss() {
  const existing = [...document.querySelectorAll('link[rel=stylesheet]')].find(link=>new URL(link.href,location.href).pathname==='/web/css/lists.css');
  if (existing) return existing.sheet ? Promise.resolve() : new Promise((done) => { existing.addEventListener('load', done, { once: true }); existing.addEventListener('error', done, { once: true }); });
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: LISTS_CSS });
  return new Promise((done) => {
    link.addEventListener('load', () => { link.dataset.loaded = '1'; done(); }, { once: true });
    link.addEventListener('error', done, { once: true });
    document.head.append(link);
  });
}

// Item icon slot; an item without `icon_url` gets an empty slot.
export function icon(url, size = 28) {
  const img = url ? `<img src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy">` : '';
  return `<span class="slot" style="--s:${size}px">${img}</span>`;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBS = [100100, 100101, 1110100, 210100];

// Empty / loading state with a small monster; a broken picture hides itself
// (see hideBroken).
export function emptyState(text, pick = 0, withMob = true) {
  const mob = withMob ? `<img src="${mobImg(MOBS[pick % MOBS.length], reducedMotion() ? 'stand' : 'move')}" alt="" width="48" height="48">` : '';
  return `<div class="lempty" role="status">${mob}<p>${esc(text)}</p></div>`;
}

export function hideBroken(container) {
  container.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
}

// The mockup's funnel panel inside `#filter-root` of `scope`: a bottom sheet
// on phones, a drop-down elsewhere. `body()` renders the sections; clicks
// inside the panel go to `onClick`. Esc and outside clicks close it.
export function filterPanel(scope, body, onClick) {
  const root = () => scope.querySelector('#filter-root');
  let count = '';
  let opener = null;
  const isOpen = () => Boolean(root()?.querySelector('.fpanel'));
  const expanded = (on) => { for (const b of scope.querySelectorAll('[data-filter]')) b.setAttribute('aria-expanded', String(on)); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    const dialog = root()?.querySelector('.fpanel[aria-modal="true"]');
    if (e.key !== 'Tab' || !dialog) return;
    const controls = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')].filter(el => el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
  };
  // A click that re-rendered the panel leaves its target detached: not outside.
  const onOutside = (e) => { if (e.target.isConnected && !e.target.closest('.ltools')) close(false); };
  function open(button) {
    opener = button;
    root().innerHTML = `<div class="scrim" data-filter-close></div><div class="fpanel" role="dialog" aria-modal="${matchMedia('(max-width:640px)').matches}" aria-label="${esc(t('lists.filter'))}">
      <div class="fhead"><h3>${esc(t('lists.filter'))}</h3><button type="button" class="bar-btn" data-filter-close aria-label="${esc(t('lists.close'))}">${I.close}</button></div>
      <div data-fbody>${body()}</div>
      <div class="ffoot"><button type="button" class="btn" data-reset>${esc(t('lists.reset'))}</button><button type="button" class="btn primary" data-filter-close data-fshow>${esc(count)}</button></div></div>`;
    expanded(true);
    root().querySelector('[data-fbody] button')?.focus();
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('click', onOutside), 0);
  }
  function close(restore) {
    if (!isOpen()) return;
    root().innerHTML = '';
    expanded(false);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onOutside);
    if (restore) (opener?.isConnected ? opener : scope.querySelector('[data-filter]'))?.focus();
  }
  // Re-render the sections and keep focus on the same control.
  function refresh() {
    const body_ = root()?.querySelector('[data-fbody]');
    if (!body_) return;
    const focused = document.activeElement;
    const key = focused && body_.contains(focused) ? `${focused.dataset.chip || ''}|${focused.dataset.value ?? ''}|${'watchOnly' in focused.dataset}` : null;
    body_.innerHTML = body();
    if (key) [...body_.querySelectorAll('button')].find((b) => `${b.dataset.chip || ''}|${b.dataset.value ?? ''}|${'watchOnly' in b.dataset}` === key)?.focus();
  }
  scope.addEventListener('click', (e) => {
    if (e.target.closest('[data-filter-close]')) return close(true);
    const button = e.target.closest('[data-filter]');
    if (button) return isOpen() ? close(true) : open(button);
    if (e.target.closest('.fpanel')) onClick?.(e);
    return undefined;
  });
  return {
    refresh,
    close: () => close(false),
    setCount(text) {
      count = text;
      const show = root()?.querySelector('[data-fshow]');
      if (show) show.textContent = text;
    },
  };
}

// Game-announcement toasts, newest on top, at most five on screen.
const TOAST_LIMIT = 5;
const TOAST_MS = 20000;
let toastBox = null;

export function toast({ title, html, href }) {
  if (!toastBox?.isConnected) {
    toastBox = Object.assign(document.createElement('div'), { className: 'toasts' });
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    toastBox.addEventListener('click', (e) => { if (e.target.closest('[data-toast-close]')) e.target.closest('.toast')?.remove(); });
    document.body.append(toastBox);
  }
  const el = document.createElement('section');
  el.className = 'toast';
  el.innerHTML = `<div class="stall-bar"><h2>${I.starSm}${esc(title)}</h2><button type="button" class="bar-btn" data-toast-close aria-label="${esc(t('lists.close'))}">${I.close}</button></div>
    <a class="toast-body" href="${esc(href)}">${html}</a>`;
  toastBox.prepend(el);
  while (toastBox.children.length > TOAST_LIMIT) toastBox.lastElementChild.remove();
  setTimeout(() => el.remove(), TOAST_MS);
}

// A desktop notification when the visitor already allowed them.
export function notify(title, body, tag) {
  if (!('Notification' in globalThis) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag }); } catch { /* some mobile browsers only notify from a service worker */ }
}

// ---------------------------------------------------------------- watch page

// Per tab session: when the page started and which offers were already
// seen, so remounting the page does not pop the same offer twice.
const STARTED = Date.now() / 1000;
const SEEN = new Map();
const NOTIFICATIONS={shared:SEEN,personal:new Map(),delivered:new Map()};
const ADDED_AT = {};
const MATCHES_SHOWN = 50;

const otherName = (r) => (lang === 'en' ? r.name_zh : r.name_en) || '';

export async function mount(main) {
  await ensureListsCss();
  if(['localhost','127.0.0.1'].includes(location.hostname)&&!['8766','8765'].includes(location.port)&&location.hash.startsWith('#watch=')){
    try{
      const imported=JSON.parse(decodeURIComponent(location.hash.slice(7)));
      const ids=Core.readList({getItem:()=>JSON.stringify(imported.ids)});
      const settings=Core.readSettings({getItem:()=>JSON.stringify(imported.settings)},ids);
      const previous=Core.readList(localStorage),previousSettings=Core.readSettings(localStorage,previous);
      Core.saveList(localStorage,[...new Set([...ids,...previous])].slice(0,MAX_WATCHES));
      Core.saveSettings(localStorage,{...previousSettings,...settings});
    }catch{}
    history.replaceState(null,'',location.pathname+location.search);
  }
  let ids = Core.readList(localStorage);
  let settings = Core.readSettings(localStorage, ids);
  let listings = [];
  let packet = null;
  let failed = false;
  let showAll = false;
  let offerSort='price';
  try{if(localStorage.getItem('watch.offerSort')==='recent')offerSort='recent';}catch{}
  let stopPoll = null;
  let stopPersonal=null,personalIdentity=null,personalToken=null,personalFeedToken=null,personalBase='',connectingPersonal=false,nextPersonalAttempt=0;
  let asOf = null;
  const items = new Map(); // item_id -> { name_zh, name_en, icon_url, typical, low }
  let presets = [];
  let stopped = false;
  const initialController=new AbortController();

  main.innerHTML = `<div class="lwrap watch-page">
    <section class="stall lpage">
      <div class="stall-bar"><h1>${esc(t('watch.title'))}</h1><span class="bar-meta" data-meta></span></div>
      <p class="sale-note">${esc(t('watch.note'))}</p>
      <details class="watch-help"><summary>${esc(t('watch.help_title'))}</summary><p>${esc(t('watch.help'))}</p></details>
      <div class="wadd">
        <form class="finder" role="search" data-search-form>${I.search}<input type="search" autocomplete="off" placeholder="${esc(t('watch.search'))}" aria-label="${esc(t('watch.search'))}" data-search></form>
        <button type="button" class="btn" data-preset disabled>${esc(t('watch.preset'))}</button>
        <button type="button" class="btn" data-allow hidden>${esc(t('watch.allow_notify'))}</button>
      </div>
      <div class="wresults" data-results hidden></div>
      <p class="wstatus" data-status role="status"></p>
      <div class="wcards" data-cards></div>
    </section>
    <section class="stall lpage wmatches" data-matches-panel hidden>
      <div class="stall-bar"><h2>${esc(t('watch.matches'))}</h2><div class="watch-offer-tools"><span class="bar-meta" data-mmeta></span><select data-watch-sort aria-label="${esc(t('watch.sort'))}"><option value="price">${esc(t('watch.sort_price'))}</option><option value="recent">${esc(t('watch.sort_recent'))}</option></select></div></div>
      <div class="llist" data-matches></div>
      <div class="lfoot" data-mfoot></div>
    </section></div>`;
  const $ = (sel) => main.querySelector(sel);
  const cards = $('[data-cards]');
  const results = $('[data-results]');
  const status = $('[data-status]');
  hideBroken(main);

  const info = (id) => items.get(id) || { item_id: id, name_zh: String(id), name_en: '' };
  const summaryNow = () => Core.summary(listings, ids, settings);

  // Phones fold the cap + alert row behind this button; it shows the cap.
  const capLabel = (cap) => `${t('watch.cap_short')} ${cap == null ? t('watch.cap_any') : meso(cap)}`;

  function card(id, s) {
    const it = info(id);
    const name = itemName(it);
    const cap = settings[id]?.cap;
    const on = settings[id]?.notify !== false;
    const lowest = s?.lowest ?? null;
    return `<article class="well wcard" data-card="${id}">
      <div class="wc-head">${icon(it.icon_url, 32)}<a class="wc-name" href="/item/${id}"><b>${esc(name)}</b><small>${esc([otherName(it), id].filter(Boolean).join(' · '))}</small></a>
        <button type="button" class="btn wc-edit" data-edit="${id}" aria-expanded="false" aria-controls="wc-set-${id}">${esc(capLabel(cap))}</button>
        <button type="button" class="bar-btn wc-x" data-remove="${id}" aria-label="${esc(t('watch.remove', { name }))}">${I.close}</button></div>
      <div class="wc-nums">
        <span><small>${esc(t('watch.lowest'))}</small><b data-lowest>${meso(lowest)}</b></span>
        <span><small>${esc(t('watch.typical'))}</small><b>${meso(it.typical ?? null)}</b></span>
        <span class="${s?.under ? 'hit' : ''}" data-under-box><small>${esc(t('watch.under'))}</small><b data-under>${esc(t('watch.under_n', { n: s?.under ?? 0 }))}</b></span>
      </div>
      <div class="wc-set" id="wc-set-${id}">
        <label class="wc-cap"><span>${esc(t('watch.cap'))}</span><input type="number" inputmode="decimal" min="0" step="any" value="${cap ?? ''}" placeholder="${esc(t('watch.cap_any'))}" data-cap="${id}"></label>
        <button type="button" class="toggle ${on ? 'on' : ''}" aria-pressed="${on}" data-notify="${id}"><i></i>${esc(t('watch.notify'))}</button>
      </div></article>`;
  }

  function renderCards() {
    const s = summaryNow();
    cards.innerHTML = ids.length ? ids.map((id) => card(id, s[id])).join('') : emptyState(t('watch.empty'), 1);
    $('[data-matches-panel]').hidden = !ids.length;
    renderCounts(s);
  }

  // Numbers that change with every live, updated in place so a focused cap
  // input keeps its focus and value.
  function renderCounts(s = summaryNow()) {
    for (const id of ids) {
      const el = cards.querySelector(`[data-card="${id}"]`);
      if (!el) continue;
      el.querySelector('[data-lowest]').textContent = meso(s[id]?.lowest ?? null);
      el.querySelector('[data-under]').textContent = t('watch.under_n', { n: s[id]?.under ?? 0 });
      el.querySelector('[data-under-box]').classList.toggle('hit', Boolean(s[id]?.under));
    }
    const hits = ids.filter((id) => s[id]?.under > 0).length;
    $('[data-meta]').textContent = ids.length ? t('watch.meta', { n: ids.length, m: hits }) : '';
    setWatchHits(hits);
  }

  function matchRow(r) {
    const it = info(r.item_id);
    const equipment=equipmentSummary(r,lang==='en');
    const where = r.location ? loc(r.location.channel, r.location.room) : loc(null);
    const extra = [r.bundle > 1 ? t('watch.bundle', { n: r.bundle }) : '', t('watch.stock', { n: r.stock })].filter(Boolean).join(' · ');
    return `<a class="ware srow wrow" href="/item/${Number(r.item_id)}" data-item-row>${icon(it.icon_url || null)}
      <span class="w-main"><span class="ware-name">${itemNames({ ...it, ...r })}${equipment?`<span class="offer-equipment">${esc(equipment)}</span>`:''}</span>
        <span class="w-sub"><span class="ss">${esc(r.shop)}</span>${where}</span></span>
      <span class="s-right"><span class="ware-price">${meso(r.unit_price)}<span class="sq">${esc(extra)}</span></span><time class="sa" data-relative-time="${r.observed}" title="${esc(fullTime(r.observed))}">${esc(ago(r.observed))}</time></span></a>`;
  }

  function renderMatches() {
    const rows = sortWatchQuotes(Core.matching(listings, ids, settings),offerSort);
    $('[data-watch-sort]').value=offerSort;
    const shown = showAll ? rows : rows.slice(0, MATCHES_SHOWN);
    $('[data-matches]').innerHTML = shown.map(matchRow).join('') || `<p class="lend">${esc(t('watch.no_matches'))}</p>`;
    $('[data-mmeta]').textContent = rows.length ? t('watch.matches_meta', { n: rows.length }) : '';
    $('[data-mfoot]').innerHTML = rows.length > shown.length ? `<button type="button" class="more" data-show-all>${esc(t('watch.show_all', { n: rows.length }))} ${I.chev}</button>` : '';
    status.textContent = failed ? t('watch.failed') : packet?.truncated ? t('watch.truncated') : '';
  }

  function announce(fresh) {
    const unique = [...new Map(fresh.map((r) => [r.id, r])).values()].filter((r) => settings[r.item_id]?.notify !== false);
    for (const r of unique.slice(0, TOAST_LIMIT)) {
      const name = itemName({ ...info(r.item_id), ...r });
      const line = t('watch.toast_line', { price: meso(r.unit_price), stock: r.stock });
      const where = r.location ? loc(r.location.channel, r.location.room) : loc(null);
      const equipment=equipmentSummary(r,lang==='en');
      toast({ title: t('watch.toast_title'), href: `/item/${Number(r.item_id)}`, html: `<b>${esc(name)}</b><span>${esc(line)}</span>${equipment?`<span class="offer-equipment">${esc(equipment)}</span>`:''}<span class="tmeta"><span class="ss">${esc(r.shop)}</span>${where}</span>` });
      notify(t('watch.toast_title'), `${name} · ${line}${equipment?' · '+equipment:''} · ${r.shop}`, r.id);
    }
  }

  function onListings(data) {
    packet = data;
    failed = false;
    listings = Array.isArray(data.listings) ? data.listings : [];
    const fresh = Core.combinedNotifications(listings, Core.watches(ids, settings, ADDED_AT), NOTIFICATIONS, STARTED, Date.now() / 1000);
    announce(fresh);
    renderCounts();
    renderMatches();
    if(!personalIdentity&&!connectingPersonal&&Date.now()>=nextPersonalAttempt)connectPersonal().then(()=>{if(personalIdentity&&!stopped)watchListings();});
  }

  // One poll per watchlist; a changed list restarts it.
  function watchListings() {
    stopPoll?.();
    stopPersonal?.();stopPersonal=null;
    stopPoll = null;
    listings = listings.filter((r) => ids.includes(r.item_id));
    if (!ids.length) return;
    stopPoll = live(api.watchListings({ ids: [...ids].sort((a, b) => a - b).join(',') }), onListings, {
      onError: () => { failed = true; renderMatches(); },
    });
    if(personalIdentity){
      const identity=personalIdentity;
      stopPersonal=live(personalBase+'/api/v1/collector/watch-listings'+qs({ids:ids.join(',')}),data=>{
        if(data.collector_id!==identity||!data.personal)return;
        showSource();
        announce(Core.combinedNotifications(Array.isArray(data.listings)?data.listings:[],Core.watches(ids,settings,ADDED_AT),NOTIFICATIONS,STARTED,Date.now()/1000,'personal',identity));
      },{headers:personalFeedToken?{Authorization:`Bearer ${personalFeedToken}`}:{},onError:()=>{
        const hint=main.querySelector('[data-personal-source]');if(hint)hint.textContent=lang==='en'?'Personal capture temporarily unavailable; shared alerts remain active.':'我的采集暂时无法连接，共享报价提醒仍在运行。';
      }});
    }
  }

  function save() {
    Core.saveList(localStorage, ids);
    const stored = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })();
    for (const id of ids) stored[id] = settings[id];
    for (const key of Object.keys(stored)) if (!ids.includes(Number(key))) delete stored[key];
    Core.saveSettings(localStorage, stored);
  }

  function setIds(next) {
    if (next === ids) return;
    for (const id of next) if (!ids.includes(id)) ADDED_AT[id] = Date.now() / 1000;
    ids = next;
    settings = Object.fromEntries(ids.map((id) => [id, settings[id] ?? { cap: null, notify: true }]));
    save();
    renderCards();
    renderMatches();
    renderResults();
    watchListings();
    resolveNames();
  }

  function addItem(item) {
    if (ids.length >= MAX_WATCHES) { status.textContent = t('watch.full'); return; }
    if (!items.has(item.item_id)) items.set(item.item_id, item);
    setIds(Core.add(ids, item.item_id));
  }

  // ---- search
  let found = [];
  let resultLimit = 40;
  let searchComposing = false;
  let searchTimer = null;
  let searchGen = 0;
  function renderResults() {
    results.hidden = !found.length && !results.dataset.message;
    if (!found.length) { results.innerHTML = results.dataset.message ? `<p class="lend">${esc(results.dataset.message)}</p>` : ''; return; }
    results.innerHTML = found.slice(0, resultLimit).map((it) => {
      const have = ids.includes(it.item_id);
      const sub = [otherName(it), it.level ? `Lv.${it.level}` : '', it.item_id].filter(Boolean).join(' · ');
      return `<button type="button" class="ware wres" data-add="${it.item_id}" ${have ? 'aria-disabled="true"' : ''}>${icon(it.icon_url)}<span class="w-main"><span class="ware-name">${esc(itemName(it))}</span><span class="w-sub">${esc(sub)}</span></span><span class="wres-act ${have ? '' : 'go'}">${esc(t(have ? 'watch.added' : 'watch.add'))}</span></button>`;
    }).join('') + (found.length > resultLimit ? `<button type="button" class="more" data-search-more>${lang === 'en' ? 'Show more items' : '显示更多商品'} (${resultLimit} / ${found.length})</button>` : '');
  }
  async function search(q) {
    const gen = ++searchGen;
    delete results.dataset.message;
    resultLimit = 40;
    if (!q) { found = [...items.values()].sort((a,b) => a.item_id-b.item_id); renderResults(); return; }
    try {
      const { data } = await getJson(api.watchCatalog() + qs({ q }));
      if (gen !== searchGen) return;
      found = data.items || [];
      if (!found.length) results.dataset.message = t('watch.no_results');
    } catch {
      if (gen !== searchGen) return;
      found = [];
      results.dataset.message = t('watch.search_failed');
    }
    renderResults();
  }

  // Names and icons: the market list covers every item seen in a shop; the
  // catalogue search covers the rest (an item watched before anyone sold it).
  async function resolveNames() {
    for (const id of ids.filter((x) => !items.has(x))) {
      try {
        if(stopped) return;
        const { data } = await getJson(api.watchCatalog() + qs({ q: id }),{signal:initialController.signal,maxAgeMs:15000});
        if(stopped) return;
        const hit = (data.items || []).find((x) => x.item_id === id);
        if (hit) { items.set(id, hit); renderCards(); }
      } catch { /* keep the id as its name */ }
    }
  }

  async function loadMarket() {
    try {
      const { data } = await getJson(api.list(),{signal:initialController.signal,maxAgeMs:15000});
      if(stopped) return;
      asOf = data.as_of ?? null;
      setFreshness(asOf);
      for (const p of data.products || []) {
        const prev = items.get(p.item_id);
        items.set(p.item_id, { ...prev, item_id: p.item_id, name_zh: p.name_zh, name_en: p.name_en, icon_url: p.icon_url, typical: p.typical, low: p.low });
      }
    } catch (e) { if(!stopped) console.warn(e); }
  }

  async function loadPresets() {
    try {
      const { data } = await getJson(api.watchCatalog() + qs({ q: '' }),{signal:initialController.signal,maxAgeMs:15000});
      if(stopped) return;
      presets = data.presets || [];
      const preset = presets[0];
      const button = $('[data-preset]');
      if (preset?.items?.length) {
        button.disabled = false;
        button.textContent = lang === 'en' ? preset.name_en || t('watch.preset') : preset.name_zh || t('watch.preset');
      }
    } catch { /* the preset button stays disabled */ }
  }

  function syncAllowButton() {
    $('[data-allow]').hidden = !('Notification' in globalThis) || Notification.permission !== 'default';
  }

  // ---- events
  $('[data-search]').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchGen++;
    const q = e.target.value.trim();
    found=[]; results.dataset.message=t('common.loading'); renderResults();
    if (!searchComposing) { if(!q) search(''); else searchTimer = setTimeout(() => search(q), 200); }
  });
  $('[data-search]').addEventListener('focus', () => search($('[data-search]').value.trim()));
  $('[data-search]').addEventListener('compositionstart', () => { searchComposing=true; clearTimeout(searchTimer); searchGen++; });
  $('[data-search]').addEventListener('compositionend', () => { searchComposing=false; clearTimeout(searchTimer); search($('[data-search]').value.trim()); });
  $('[data-search-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('[data-search]').value.trim();
    const exact = found.filter((it) => String(it.item_id) === q || itemName(it) === q);
    const pick = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
    if (pick) { addItem(pick); $('[data-search]').value = ''; found = []; renderResults(); }
  });
  main.addEventListener('click', (e) => {
    if(e.target.closest('[data-search-more]')) { resultLimit+=40; renderResults(); return; }
    const add = e.target.closest('[data-add]');
    if (add && add.getAttribute('aria-disabled') !== 'true') {
      const it = found.find((x) => x.item_id === Number(add.dataset.add));
      if (it) addItem(it);
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const open = edit.closest('.wcard').classList.toggle('open');
      edit.setAttribute('aria-expanded', String(open));
      if (open) edit.closest('.wcard').querySelector('[data-cap]').focus();
      return undefined;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) return setIds(Core.remove(ids, Number(remove.dataset.remove)));
    const toggle = e.target.closest('[data-notify]');
    if (toggle) {
      const id = Number(toggle.dataset.notify);
      settings[id] = { ...settings[id], notify: settings[id]?.notify === false };
      toggle.classList.toggle('on', settings[id].notify);
      toggle.setAttribute('aria-pressed', String(settings[id].notify));
      return save();
    }
    if (e.target.closest('[data-preset]')) {
      for (const it of presets[0]?.items || []) if (!items.has(it.item_id)) items.set(it.item_id, it);
      return setIds(Core.addPreset(ids, presets[0]));
    }
    if (e.target.closest('[data-show-all]')) { showAll = true; return renderMatches(); }
    if (e.target.closest('[data-allow]')) {
      return Notification.requestPermission().then(syncAllowButton, syncAllowButton);
    }
    return undefined;
  });
  main.addEventListener('change', (e) => {
    if(e.target.matches('[data-watch-sort]')){
      offerSort=e.target.value==='recent'?'recent':'price';
      try{localStorage.setItem('watch.offerSort',offerSort);}catch{}
      renderMatches();return;
    }
    const input = e.target.closest('[data-cap]');
    if (!input) return;
    const id = Number(input.dataset.cap);
    const raw = input.value.trim();
    const cap = raw === '' ? null : Number(raw);
    if (cap != null && !(Number.isFinite(cap) && cap >= 0)) { input.value = settings[id]?.cap ?? ''; return; }
    settings[id] = { ...settings[id], cap };
    const edit = main.querySelector(`[data-edit="${id}"]`);
    if (edit) edit.textContent = capLabel(cap);
    save();
    renderCounts();
    renderMatches();
  });
  // The price table's star (another tab) changes the same keys.
  const onStorage = (e) => {
    if(e.key==='cwm.collector.token'){
      personalToken=e.newValue;personalIdentity=null;stopPersonal?.();
      connectPersonal().then(()=>{if(!stopped)watchListings();});return;
    }
    if (e.key !== LIST_KEY && e.key !== SETTINGS_KEY) return;
    ids = Core.readList(localStorage);
    settings = Core.readSettings(localStorage, ids);
    renderCards();
    renderMatches();
    watchListings();
    resolveNames();
  };
  addEventListener('storage', onStorage);

  syncAllowButton();
  renderCards();
  const hint=document.createElement('p');hint.className='wstatus';hint.dataset.personalSource='';
  main.querySelector('.wstatus').after(hint);
  function showSource(){
    if(personalIdentity){hint.textContent=lang==='en'?'Alerts: shared offers + shops I just visited':'提醒范围：共享新报价 + 我刚逛到的摊位';return;}
    hint.textContent=lang==='en'?'Shared offer alerts are on for all watched items. Your own visits join automatically when connected.':'已开启所有关注物品的共享新报价提醒；连接采集器后，自动加入自己刚逛到的摊位。';
  }
  try{personalToken=localStorage.getItem('cwm.collector.token');}catch{}
  async function connectPersonal(){
    if(connectingPersonal||stopped)return;
    connectingPersonal=true;nextPersonalAttempt=Date.now()+30000;
    const token=personalToken;
    const gateway=['localhost','127.0.0.1'].includes(location.hostname)&&!['8766','8765'].includes(location.port);
    const official=['https://mxd.ruit.me','http://127.0.0.1:8766','http://localhost:8766'].includes(location.origin);
    const candidates=[...(token||gateway?[{base:'',token}]:[]),...(official?[{base:'http://127.0.0.1:8780',token:null}]:[])];
    for(const target of candidates){
     if(stopped||token!==personalToken)break;
     hint.dataset.capturePath=target.base?'desktop':'browser';hint.dataset.captureState='connecting';
     try{
      const deadline=new AbortController();const timeout=setTimeout(()=>deadline.abort(),15000);
      const abort=()=>deadline.abort();initialController.signal.addEventListener('abort',abort,{once:true});
      try{
        const response=await fetch(target.base+'/api/v1/collector/status',{headers:target.token?{Authorization:`Bearer ${target.token}`}:{},credentials:'same-origin',cache:'no-store',signal:deadline.signal});
        hint.dataset.captureState='http-'+response.status;
        if(response.ok){const data=await response.json();if(!stopped&&token===personalToken&&(target.token||data.local_collector===true)){personalIdentity=data.collector_id;personalBase=target.base;personalFeedToken=target.token;hint.dataset.captureState='connected';break;}}
      }finally{clearTimeout(timeout);initialController.signal.removeEventListener('abort',abort);}
     }catch(error){hint.dataset.captureState=error.name||'unavailable';}
    }
    connectingPersonal=false;
    if(!stopped)showSource();
  }
  const personalReady=connectPersonal();
  const reconnectPersonal=()=>{if(!personalIdentity&&!connectingPersonal)connectPersonal().then(()=>{if(personalIdentity&&!stopped)watchListings();});};
  addEventListener('focus',reconnectPersonal);
  showSource();
  personalReady.then(()=>{if(personalIdentity&&!stopped)watchListings();});
  Promise.all([loadMarket(), loadPresets()]).then(()=>{
    if(stopped) return;
    renderCards();renderMatches();watchListings();resolveNames();
  });

  return () => {
    stopped=true;
    initialController.abort();
    stopPoll?.();
    stopPersonal?.();
    removeEventListener('focus',reconnectPersonal);
    searchGen++;
    clearTimeout(searchTimer);
    removeEventListener('storage', onStorage);
  };
}
