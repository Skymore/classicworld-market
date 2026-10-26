// Item drawer for wide screens (mockup openDrawer, `.drawer` in base.css):
// the item head from the list row at once, then a where-to-buy summary from
// /api/v1/item/<id> and a link to the full SSR page. Esc, the scrim and the
// close button close it; Tab stays inside while it is open.
import { t, addMessages, itemName, lang } from './i18n.js';
import { I } from './icons.js';
import { esc, meso, num, chg, slot } from './format.js';
import { api, getJson } from './api.js?v=20261022-regressions-1';
import { skeletonRows, errorState } from './states.js';
import { itemHref } from './rows.js';
import { trapFocus } from './dialog.js';

addMessages({
  zh: {
    'drawer.title': '物品详情', 'drawer.open_page': '打开完整物品页', 'drawer.unit': '金币 · 成交中位',
    'drawer.range': '常见 {lo}–{hi}', 'drawer.sales': '所选时段 {n} 笔', 'drawer.listed': '在售 {n} 件', 'drawer.shops': '{n} 摊',
    'drawer.low_data': '样本少', 'drawer.no_price': '还没有成交价',
    'drawer.where': '在哪买', 'drawer.where_sub': '{n} 条挂单 · {shops} 摊', 'drawer.group': '{shops} 摊 · {stock} 件',
    'drawer.min': '最低', 'drawer.none': '最近 72 小时没有在售挂单。', 'drawer.full': '在物品页看全部 {n} 个频道、洞图和挂单',
    'drawer.full_short': '查看完整物品页',
  },
  en: {
    'drawer.title': 'Item details', 'drawer.open_page': 'Open the full item page', 'drawer.unit': 'mesos · median sale',
    'drawer.range': 'usually {lo}–{hi}', 'drawer.sales': '{n} sales in period', 'drawer.listed': '{n} listed', 'drawer.shops': '{n} shops',
    'drawer.low_data': 'few sales', 'drawer.no_price': 'no sale price yet',
    'drawer.where': 'Where to buy', 'drawer.where_sub': '{n} listings · {shops} shops', 'drawer.group': '{shops} shops · {stock} pcs',
    'drawer.min': 'low', 'drawer.none': 'No listings in the last 72 hours.', 'drawer.full': 'All {n} channels, room map and listings on the item page',
    'drawer.full_short': 'Open the full item page',
  },
});

const STALE_SECONDS = 48 * 3600;
const CHANNELS_SHOWN = 6;
const otherName = (r) => (lang === 'en' ? r.name_zh : r.name_en) || '';

/**
 * Opens the drawer for list row `row` inside `root` (an empty container).
 * `asOf` is retained for caller compatibility; staleness uses the real clock.
 * `returnFocus` gets focus back on close, `onClose` runs after closing.
 * Returns `close()`.
 */
export function openItemDrawer(root, row, { asOf, returnFocus = null, onClose } = {}) {
  const id = row.item_id;
  root.innerHTML = `<div class="scrim" data-drawer-close></div><aside class="stall drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-name">
    <div class="stall-bar"><h2>${esc(t('drawer.title'))}</h2><span class="bar-meta">${esc(itemName(row))}</span>
      <a class="bar-btn" href="${itemHref(id)}" aria-label="${esc(t('drawer.open_page'))}">${I.chev}</a>
      <button type="button" class="bar-btn" data-drawer-close aria-label="${esc(t('common.close'))}">${I.close}</button></div>
    <div class="scroll">${head(row)}<div class="ibody" data-drawer-body>${skeletonRows(4, 44)}</div></div></aside>`;
  const dialog = root.querySelector('.drawer');
  let open = true;

  const close = () => {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey, true);
    root.innerHTML = '';
    if (returnFocus?.isConnected) returnFocus.focus();
    onClose?.();
  };
  // Capture phase, so the page's own Escape handling never sees this key.
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') trapFocus(dialog, e);
  }
  document.addEventListener('keydown', onKey, true);
  root.querySelectorAll('[data-drawer-close]').forEach((el) => el.addEventListener('click', close));
  root.querySelector('button[data-drawer-close]').focus();

  getJson(api.item(id))
    .then(({ data }) => whereWell(id, data.listings || [], asOf))
    .catch(() => `${errorState()}<a class="more" href="${itemHref(id)}">${esc(t('drawer.full_short'))} ${I.chev}</a>`)
    .then((html) => {
      const body = open && root.querySelector('[data-drawer-body]');
      if (body) body.innerHTML = html;
    });
  return close;
}

function head(r) {
  const tags = [`<span class="tagx">${esc(t(`cat.${r.category}`))}</span>`];
  if (lang === 'zh' && r.subcategory) tags.push(`<span class="tagx">${esc(r.subcategory)}</span>`);
  if (r.level != null) tags.push(`<span class="tagx">${esc(r.level > 0 ? t('level.n', { n: r.level }) : t('level.none'))}</span>`);
  if (r.low_data) tags.push(`<span class="tagx low">${esc(t('drawer.low_data'))}</span>`);
  const facts = [];
  if (r.typical_low != null && r.typical_high != null) facts.push(`<b>${esc(t('drawer.range', { lo: meso(r.typical_low), hi: meso(r.typical_high) }))}</b>`);
  facts.push(esc(t('drawer.sales', { n: r.sales_window })), esc(t('drawer.listed', { n: num(r.listings) })), esc(t('drawer.shops', { n: num(r.shops) })));
  const price = r.typical != null
    ? `<span class="big">${meso(r.typical)}</span><span class="unit">${esc(t('drawer.unit'))}</span>${chg(r.change_window)}`
    : `<span class="unit">${esc(t('drawer.no_price'))}</span>`;
  return `<div class="ihead">${slot(r.icon_url, 44)}<div><h3 class="ih-name" id="drawer-name">${esc(itemName(r))}</h3><div class="en">${esc(otherName(r))}</div><div class="tags">${tags.join('')}</div></div></div>
    <div class="iprice">${price}<span class="range">${facts.join(' · ')}</span></div>`;
}

// Channel summary of the live listings (mockup whereWell, collapsed rows
// only). Listings older than 48 h do not count towards a channel's minimum.
function whereWell(id, listings, asOf = Date.now() / 1000) {
  const byChannel = new Map();
  for (const l of listings) {
    const ch = l.location?.channel ?? 'unknown';
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(l);
  }
  const groups = [...byChannel].map(([ch, ls]) => {
    const fresh = ls.filter((l) => Date.now()/1000 - l.time <= STALE_SECONDS);
    return {
      ch,
      min: Math.min(...(fresh.length ? fresh : ls).map((l) => l.unit_price)),
      shops: new Set(ls.map((l) => l.shop_key)).size,
      stock: ls.every(l=>l.stock!=null) ? ls.reduce((sum, l) => sum + l.stock, 0) : null,
    };
  }).sort((a, b) => (a.ch === 'unknown') - (b.ch === 'unknown') || a.min - b.min);
  const shops = new Set(listings.map((l) => l.shop_key)).size;
  const top = `<div class="well-h"><h3>${esc(t('drawer.where'))}</h3><small>${esc(t('drawer.where_sub', { n: num(listings.length), shops: num(shops) }))}</small></div>`;
  const full = `<a class="more" href="${itemHref(id)}">${esc(groups.length ? t('drawer.full', { n: groups.length }) : t('drawer.full_short'))} ${I.chev}</a>`;
  if (!listings.length) return `<section class="well">${top}<p class="note">${esc(t('drawer.none'))}</p>${full}</section>`;
  const rows = groups.slice(0, CHANNELS_SHOWN).map((g) => {
    const label = g.ch === 'unknown' ? `<span class="chno unk">${esc(t('loc.unknown'))}</span>` : `<span class="chno">${esc(lang === 'en' ? `CH ${g.ch}` : `${g.ch}频道`)}</span>`;
    return `<div class="cg-head cg-static">${label}<span class="cg-meta">${esc(t('drawer.group', { shops: g.shops, stock: num(g.stock) }))}</span><span class="cg-min">${esc(t('drawer.min'))} <b>${meso(g.min)}</b></span></div>`;
  }).join('');
  return `<section class="well">${top}<div class="cg-list">${rows}</div>${full}</section>`;
}
