// Market list rows shared by the home page tabs and the price table tabs,
// ported from wareRows / changeRows / busyRows / recentRows in
// design/mockups-v2/mock.html. `wide` = tablet and desktop (two-line rows),
// otherwise the phone layout.
import { t, itemName, addMessages } from './i18n.js';
import { esc, meso, ago, chg, loc, slot } from './format.js';
import { itemNames } from './names.js';
import {readPeriod} from './period.js?v=20261022-regressions-1';
import { priceUnit } from './market-source.js?v=20261022-external-1';

addMessages({
  zh: { 'rows.change_sub': '成交 {sales} 笔 · 在售 {listings} 件', 'rows.busy_sub': '在售 {listings} 件 · 最低 {low}', 'rows.sales_n': '{n} 笔' },
  en: { 'rows.change_sub': '{sales} sales · {listings} listed', 'rows.busy_sub': '{listings} listed · low {low}', 'rows.sales_n': '{n} sales' },
});

export const itemHref = (id) => `/item/${id}?hours=${readPeriod()}`;

// Selected-period movers: |change| ≥ 0.5 %, biggest first (mockup byChange).
export function byChange(rows) {
  return rows.filter((r) => r.change_window != null && Math.abs(r.change_window) >= 0.5)
    .sort((a, b) => Math.abs(b.change_window) - Math.abs(a.change_window) || b.sales_window - a.sales_window);
}

// Most sales in the selected period; ties by listings so the order is stable.
export function byBusy(rows) {
  return rows.filter((r) => r.sales_window > 0)
    .sort((a, b) => b.sales_window - a.sales_window || b.listings - a.listings || a.item_id - b.item_id);
}

function ware(r, wide, sub, right) {
  const name = itemNames(r);
  const main = wide
    ? `<span class="w-main"><span class="ware-name">${name}</span><span class="w-sub">${sub}</span></span>`
    : `<span class="ware-name">${name}</span>`;
  return `<a class="ware ${wide ? 'dual' : ''}" href="${itemHref(r.item_id)}" data-item-row>${slot(r.icon_url)}${main}${right}</a>`;
}

export function changeWare(r, wide) {
  return ware(r, wide, esc(t('rows.change_sub', { sales: r.sales_window, listings: r.listings })),
    `<span class="ware-price">${meso(r.typical)}${priceUnit(r)}</span>${chg(r.change_window)}`);
}

export function busyWare(r, wide) {
  return ware(r, wide, esc(t('rows.busy_sub', { listings: r.listings, low: meso(r.low) })),
    `<span class="ware-price">${meso(r.typical)}${priceUnit(r)}</span><span class="ware-n">${esc(t('rows.sales_n', { n: r.sales_window }))}</span>`);
}

const whereSold = (s) => (s.location ? loc(s.location.channel, s.location.room, s.location) : loc(null));
const evidence = (s) => `<span class="evi ${esc(s.kind)}" title="${esc(t(`evidence.help.${s.kind}`))}">${esc(t(`evidence.${s.kind}`))}</span>`;

// A sale from /api/v1/sales/recent. Ages always use the wall clock.
export function saleWare(s, wide, now, withEvidence = false) {
  const name = `<span class="ware-name">${itemNames(s)}</span>`;
  const when = `<span class="wa" data-relative-time="${s.time}" title="${esc(new Date(s.time * 1000).toLocaleString())}">${esc(ago(s.time))}</span>`;
  const price = `<span class="ware-price">${meso(s.sale_unit_price)}${priceUnit(s)}</span>`;
  const evi = withEvidence ? evidence(s) : '';
  if (wide) {
    return `<a class="ware one ${withEvidence ? 'evid' : ''}" href="${itemHref(s.item_id)}" data-item-row>${slot(s.icon_url)}${name}${evi}${whereSold(s)}${when}${price}</a>`;
  }
  return `<a class="ware two" href="${itemHref(s.item_id)}" data-item-row>${slot(s.icon_url)}<span class="w-main">${name}<span class="w-sub">${evi}${whereSold(s)}${when}</span></span>${price}</a>`;
}
