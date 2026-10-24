import { compareQuotes } from './quote-order.js?v=20261023-item-sort-2';
import { meso } from './format.js';
import { OFFER_HOURS, OFFER_PERCENTILES, normalizeOfferFilters, filterOffers } from './item-offer-filters.js?v=20261023-offer-filters-1';

// Preserve all offers and their room labels across sorting and filtering.
// Realtime section replacements get a fresh snapshot of the incoming offers.
const sections = new WeakMap();
const STALE_SECONDS = 48 * 3600;

function entry(row) {
  // Support HTML cached before quote metadata was added to ordinary rows.
  const shown = row.querySelector('.lp')?.textContent.trim().replaceAll(',', '') || '';
  const match = shown.match(/^([\d.]+)\s*([KMB])?$/i);
  const legacyPrice = match ? Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] || 1) : Infinity;
  return {
    observed: Number(row.dataset.observed || row.querySelector('[data-relative-time]')?.dataset.relativeTime) || null,
    price: row.hasAttribute('data-unit-price') ? Number(row.dataset.unitPrice) : legacyPrice,
    key: row.dataset.quote || row.dataset.offer || row.querySelector('.lshop')?.textContent,
  };
}

function controls(section, en) {
  const bar = document.createElement('div');
  bar.className = 'offer-filters';
  const options = (values, label) => values.map(value => `<option value="${value}">${label(value)}</option>`).join('');
  bar.innerHTML = `<label data-offer-time-filter><span>${en ? 'Observed within' : '报价时间'}</span>
    <select data-offer-hours>${options(OFFER_HOURS, value => value === 'all' ? (en ? 'Any time' : '全部时间') : value === '168' ? (en ? 'Last 7 days' : '最近 7 天') : (en ? `Last ${value} hours` : `最近 ${value} 小时`))}</select></label>
    <label data-offer-price-filter hidden><span>${en ? 'Price percentile' : '价格百分位'}</span>
    <select data-offer-percentile>${options(OFFER_PERCENTILES, value => value === 'all' ? (en ? 'Any price' : '全部价格') : (en ? `Lowest ${value}%` : `最低 ${value}%`))}</select></label>
    <small data-offer-filter-note></small>`;
  section.querySelector('.well-h').after(bar);
  const empty = document.createElement('p');
  empty.className = 'note offer-empty';
  empty.dataset.offerEmpty = '';
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  empty.textContent = en ? 'No offers match. Try a wider filter.' : '没有符合条件的报价，请放宽筛选范围。';
  bar.after(empty);
  return { bar, empty };
}

const minimum = rows => {
  const fresh = rows.filter(row => !row.el.classList.contains('stale'));
  return Math.min(...(fresh.length ? fresh : rows).map(row => row.price));
};
const shopCount = rows => new Set(rows.map(row => JSON.stringify([row.channel, row.room, row.shop]))).size;

function updateGroup(group, en) {
  const { el, rows, price } = group;
  const meta = el.querySelector('.cg-meta');
  if (meta) meta.textContent = en ? `${shopCount(rows)} shops · ${rows.length} listings` : `${shopCount(rows)} 摊 · ${rows.length} 条挂单`;
  const min = el.querySelector('.cg-min b');
  if (min) min.textContent = Number.isFinite(price) ? meso(price) : '—';
  for (const hole of el.querySelectorAll('.hole')) {
    const room = Number(hole.querySelector('i')?.textContent);
    const here = rows.filter(row => row.roomNumber === room);
    const stale = here.length > 0 && here.every(row => row.el.classList.contains('stale'));
    const roomPrice = minimum(here);
    hole.classList.toggle('lit', here.length > 0);
    hole.classList.toggle('stale', stale);
    hole.classList.toggle('best', here.length > 0 && !stale && roomPrice === price);
    hole.querySelector('b')?.remove();
    hole.removeAttribute('title');
    if (here.length) {
      const b = document.createElement('b');
      b.textContent = meso(roomPrice);
      hole.append(b);
      hole.title = en ? `room ${room}, from ${meso(roomPrice)}` : `${room} 洞 最低 ${meso(roomPrice)}`;
    }
  }
}

export function applyOfferSort(stall, mode, filters = {}) {
  const section = stall.querySelector('.where-well');
  const select = section?.querySelector('[data-offer-sort]');
  if (!select) return;
  const en = document.documentElement.lang === 'en';
  const latest = mode === 'recent';
  const selected = normalizeOfferFilters(filters);
  select.value = latest ? 'recent' : 'price';
  let saved = sections.get(section);
  if (!saved) {
    const groups = [...section.querySelectorAll('.cgroup')].map(el => ({
      el, key: el.dataset.chKey,
      rows: [...(el.querySelector('.cg-list')?.children || [])].filter(row => row.matches('.listing-offer,.lrow')).map(el => {
        const room = el.querySelector('.lroom')?.textContent || '';
        return { el, room, roomNumber: Number(room.match(/\d+/)?.[0]) || null, channel: el.closest('.cgroup').dataset.chKey, shop: el.querySelector('.lshop')?.textContent.trim() || '' };
      }),
    }));
    const flat = document.createElement('div');
    flat.className = 'recent-offers';
    flat.hidden = true;
    section.insertBefore(flat, groups[0]?.el || null);
    saved = { groups, flat, ...controls(section, en) };
    sections.set(section, saved);
  }
  saved.bar.querySelector('[data-offer-time-filter]').hidden = latest;
  saved.bar.querySelector('[data-offer-price-filter]').hidden = !latest;
  saved.bar.querySelector('[data-offer-hours]').value = selected.hours;
  saved.bar.querySelector('[data-offer-percentile]').value = selected.percentile;

  const now = Date.now() / 1000;
  const all = saved.groups.flatMap(group => group.rows.map(row => ({ ...row, ...entry(row.el) })));
  const { rows, cap } = filterOffers(all, mode, selected, now);
  const visible = new Set(rows.map(row => row.el));
  for (const row of all) {
    row.el.hidden = !visible.has(row.el);
    if (row.observed !== null) row.el.classList.toggle('stale', now - row.observed > STALE_SECONDS);
  }
  const groups = saved.groups.map(group => {
    const list = group.el.querySelector('.cg-list');
    // Restore every row first, so clearing a filter also restores its offers.
    for (const row of group.rows) {
      list.append(row.el);
      const room = row.el.querySelector('.lroom');
      if (room) room.textContent = row.room;
    }
    const shown = rows.filter(row => row.channel === group.key).sort((a, b) => compareQuotes(a, b, latest));
    for (const row of shown) list.append(row.el);
    return { ...group, rows: shown, observed: Math.max(0, ...shown.map(row => row.observed || 0)), price: minimum(shown) };
  });
  groups.sort((a, b) => (a.rows.length === 0) - (b.rows.length === 0) ||
    (!latest && ((a.key === 'unknown') !== (b.key === 'unknown')) ? (a.key === 'unknown' ? 1 : -1) : compareQuotes(a, b, latest)));
  const before = section.querySelector(':scope > [data-more]');
  groups.forEach((group, index) => {
    section.insertBefore(group.el, before);
    group.el.hidden = latest || !group.rows.length;
    group.el.classList.toggle('xp', index >= 6);
    group.el.classList.toggle('xd', index >= 8);
    updateGroup(group, en);
  });
  // A filter may remove the only expanded channel. Open the first result so
  // matching offers remain visible, preserving other explicit channel choices.
  const active = groups.filter(group => group.rows.length);
  if (!latest && active.length && saved.groups.some(group => group.el.classList.contains('open')) &&
      !active.some((group, index) => group.el.classList.contains('open') &&
      (section.classList.contains('all') || index < (document.documentElement.dataset.device === 'desktop' ? 8 : 6)))) {
    active[0].el.classList.add('open');
    active[0].el.querySelector('[data-ch]')?.setAttribute('aria-expanded', 'true');
  }
  saved.flat.hidden = !latest;
  section.classList.toggle('recent-order', latest);
  const legend = section.querySelector('.legend');
  if (legend) legend.hidden = latest || !rows.length;
  for (const more of section.querySelectorAll(':scope > [data-more]')) {
    const rest = active.length - (more.classList.contains('on-desktop') ? 8 : 6);
    more.hidden = latest || rest <= 0;
    if (rest > 0) more.firstChild.textContent = en ? `Show ${rest} more channels ` : `显示其余 ${rest} 个频道 `;
  }
  if (latest) {
    for (const row of [...rows].sort((a, b) => compareQuotes(a, b, true))) {
      const room = row.el.querySelector('.lroom');
      if (room) room.textContent = (row.channel === 'unknown' ? (en ? 'Channel ?' : '频道未知') : 'CH ' + row.channel) + ' · ' + row.room;
      saved.flat.append(row.el);
    }
  }
  const count = section.querySelector('.well-h small');
  if (count) count.textContent = en ? `${rows.length} listings · ${shopCount(rows)} shops` : `${rows.length} 条挂单 · ${shopCount(rows)} 摊`;
  const note = saved.bar.querySelector('[data-offer-filter-note]');
  note.textContent = cap !== null
    ? (en ? `Unit price ≤ ${cap.toLocaleString('en-US')} · includes ties` : `单价 ≤ ${cap.toLocaleString('zh-CN')} · 含同价挂单`)
    : latest ? (en ? 'Percentile of current listing prices' : '按当前挂单单价计算百分位')
      : (en ? 'Time of last observation' : '按最近采集到报价的时间筛选');
  saved.empty.hidden = rows.length > 0;
}
