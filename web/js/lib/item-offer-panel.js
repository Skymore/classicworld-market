import { esc } from './format.js';
import { OFFER_HOURS, OFFER_PERCENTILES, normalizeOfferFilters, filterOffers, clearOfferFilter } from './item-offer-filters.js?v=20261023-advanced-offers-1';

// The modal stays outside data-market sections, so live updates can refresh
// offers without replacing inputs or reopening a native select picker.
export function bindOfferFilters(stall, { read, rows, apply }) {
  const en = document.documentElement.lang === 'en';
  const text = (zh, english) => en ? english : zh;
  let dialog, form, opener;
  const options = (values, label) => values.map(value => `<option value="${esc(value)}">${esc(label(value))}</option>`).join('');
  const label = (title, content, cls = '') => `<label class="offer-field ${cls}"><span>${title}</span>${content}</label>`;
  const number = (name, placeholder, min = 0, step = 'any') => `<input type="number" name="${name}" min="${min}" step="${step}" inputmode="decimal" placeholder="${placeholder}">`;
  function values() {
    const data = new FormData(form);
    return normalizeOfferFilters(Object.fromEntries(data));
  }
  function populate(filters) {
    const f = normalizeOfferFilters(filters);
    for (const [key, value] of Object.entries(f)) {
      if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value ?? '';
    }
    preview();
  }
  function preview() {
    if (!form) return;
    const result = filterOffers(rows(), '', values());
    form.querySelector('[data-offer-apply]').textContent = text(`显示 ${result.rows.length} 条报价`, `Show ${result.rows.length} offers`);
    form.querySelector('[data-offer-preview]').textContent = result.cap === null
      ? text('所有条件同时生效，排序方式不影响筛选。', 'All conditions apply together, regardless of sort order.')
      : text(`价格百分位上限：单价 ${result.cap.toLocaleString('zh-CN')}，含同价挂单。`, `Percentile cutoff: unit price ${result.cap.toLocaleString('en-US')}, including ties.`);
  }
  function close() { if (dialog?.open) dialog.close(); }
  function open(button) {
    opener = button;
    dialog?.remove();
    const all = rows();
    dialog = document.createElement('dialog');
    dialog.id = 'offer-filter-dialog';
    dialog.className = 'offer-filter-dialog';
    dialog.setAttribute('aria-labelledby', 'offer-filter-title');
    dialog.innerHTML = `<form class="offer-filter-form">
      <header class="offer-filter-head"><div><h3 id="offer-filter-title">${text('筛选报价', 'Filter offers')}</h3><p>${text('组合条件，找到合适的报价', 'Combine conditions to find the right offer')}</p></div><button type="button" data-offer-close aria-label="${text('关闭筛选', 'Close filters')}" autofocus>×</button></header>
      <div class="offer-filter-body">
        <fieldset><legend>${text('时间与价格', 'Time and price')}</legend><div class="offer-field-grid">
          ${label(text('报价时间', 'Last observed'), `<select name="hours" data-offer-hours>${options(OFFER_HOURS, value => value === 'all' ? text('全部时间', 'Any time') : value === '168' ? text('最近 7 天', 'Last 7 days') : text(`最近 ${value} 小时`, `Last ${value} ${value === '1' ? 'hour' : 'hours'}`))}</select>`)}
          ${label(text('价格百分位', 'Price percentile'), `<select name="percentile" data-offer-percentile>${options(OFFER_PERCENTILES, value => value === 'all' ? text('全部价格', 'Any price') : text(`最低 ${value}%`, `Lowest ${value}%`))}</select>`)}
          ${label(text('最低单价（金币）', 'Min unit price (mesos)'), number('minPrice', text('不限', 'No minimum')))}
          ${label(text('最高单价（金币）', 'Max unit price (mesos)'), number('maxPrice', text('不限', 'No maximum')))}
        </div><p class="offer-field-hint">${text('百分位按本物品全部挂单的单价计算，临界同价挂单一起保留。', 'Percentiles use all offers for this item; ties at the cutoff are included.')}</p></fieldset>
        <fieldset><legend>${text('库存与属性', 'Stock and stats')}</legend><div class="offer-field-grid">
          ${label(text('库存信息', 'Stock information'), `<select name="stock">${options(['all', 'known', 'unknown'], value => ({ all: text('全部库存', 'Any stock'), known: text('仅库存已知', 'Known stock only'), unknown: text('仅库存未知', 'Unknown stock only') })[value])}</select>`)}
          ${label(text('最低库存数量', 'Minimum stock'), number('minStock', text('不限', 'Any quantity'), 1, '1'))}
          ${all.some(row => row.isEquipment) ? label(text('装备实际属性', 'Captured equipment stats'), `<select name="equipment">${options(['all', 'captured', 'missing', 'bonus'], value => ({ all: text('全部属性', 'Any stats'), captured: text('已采集实际属性', 'Stats captured'), missing: text('未采集实际属性', 'Stats not captured'), bonus: text('只看有加成属性', 'Bonus stats only') })[value])}</select>`, 'offer-field-wide') : ''}
        </div></fieldset>
      </div>
      <footer class="offer-filter-foot"><p data-offer-preview role="status" aria-live="polite"></p><div><button type="button" class="btn" data-offer-reset>${text('重置条件', 'Reset filters')}</button><button type="submit" class="btn primary" data-offer-apply></button></div></footer>
    </form>`;
    stall.append(dialog);
    form = dialog.querySelector('form');
    populate(read());
    form.addEventListener('input', preview);
    form.addEventListener('change', preview);
    form.addEventListener('submit', event => { event.preventDefault(); const selected = values(); close(); apply(selected); });
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-offer-close]')) close();
      if (event.target.closest('[data-offer-reset]')) populate({});
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }
    });
    dialog.addEventListener('close', () => {
      for (const trigger of stall.querySelectorAll('[data-offer-filter-open]')) trigger.setAttribute('aria-expanded', 'false');
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else stall.querySelector('[data-offer-filter-open]')?.focus({ preventScroll: true });
    });
    dialog.showModal();
    button.setAttribute('aria-expanded', 'true');
  }
  stall.addEventListener('click', event => {
    const trigger = event.target.closest('[data-offer-filter-open]');
    if (trigger) open(trigger);
    const clear = event.target.closest('[data-offer-clear]');
    if (clear) apply(clearOfferFilter(read(), clear.dataset.offerClear));
  });
  return {
    refresh() {
      if (dialog?.open) {
        preview();
        for (const trigger of stall.querySelectorAll('[data-offer-filter-open]')) trigger.setAttribute('aria-expanded', 'true');
      }
    },
    close,
  };
}
