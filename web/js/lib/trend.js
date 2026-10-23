// A daily bucket is a UTC day; format its actual boundaries in the visitor's
// timezone instead of parsing a date-only string as local midnight.
export function trendValues(day, locale, timeZone) {
  const numbers = new Intl.NumberFormat(locale, {maximumFractionDigits: 20});
  const full = new Intl.DateTimeFormat(locale, {
    month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit',
    timeZoneName:'short', ...(timeZone ? {timeZone} : {}),
  });
  const start = Number(day.start) * 1000;
  const en = locale.startsWith('en');
  const price = key => day[key] == null || day[key] === '' || !Number.isFinite(Number(day[key]))
    ? '—' : numbers.format(Number(day[key]));
  return {
    range: `${full.format(new Date(start))} – ${full.format(new Date(start + 86400000))}`,
    median: price('median'), low: price('low'), high: price('high'),
    count: Number(day.count) === 0 ? (en ? '0 · No sales' : '0 · 无成交') : numbers.format(Number(day.count)),
  };
}

export function bindTrends(root) {
  for (const chart of root.querySelectorAll('.trend')) {
    if (chart.dataset.trendBound) continue;
    chart.dataset.trendBound = '1';
    const buttons = [...chart.querySelectorAll('[data-trend-day]')];
    if (!buttons.length) continue;
    const tooltip = document.createElement('div');
    tooltip.className = 'trend-tooltip'; tooltip.hidden = true;
    tooltip.setAttribute('aria-hidden','true');
    chart.prepend(tooltip);
    let selected = -1;
    const show = index => {
      if (index === selected || !buttons[index]) return;
      selected = index;
      const values = trendValues(buttons[index].dataset, document.documentElement.lang === 'en' ? 'en-US' : 'zh-CN');
      const en = document.documentElement.lang === 'en';
      tooltip.textContent = `${buttons[index].dataset.date} UTC · ${en?'mesos / item':'金币 / 件'}\n${en?'Median':'中位价'}  ${values.median}\n${en?'Low – high':'最低 – 最高'}  ${values.low} – ${values.high}\n${en?'Sales':'成交笔数'}  ${values.count}`;
      chart.querySelector('[data-trend-range]').textContent = values.range;
      for (const node of chart.querySelectorAll('[data-trend-value]')) node.textContent = values[node.dataset.trendValue];
      buttons.forEach((button,i) => button.setAttribute('aria-pressed', String(i === index)));
      chart.querySelectorAll('[data-trend-marker]').forEach(node => node.classList.toggle('selected', Number(node.dataset.trendMarker) === index));
    };
    chart.addEventListener('pointerover', e => {
      const target = e.target.closest('[data-trend-hit],[data-trend-day]');
      if (target) { show(Number(target.dataset.trendHit ?? target.dataset.trendDay)); tooltip.hidden = false; }
    });
    chart.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    chart.addEventListener('click', e => {
      const target = e.target.closest('[data-trend-hit],[data-trend-day]');
      if (target) { show(Number(target.dataset.trendHit ?? target.dataset.trendDay)); tooltip.hidden = false; }
    });
    chart.addEventListener('focusin', e => {
      const target = e.target.closest('[data-trend-day]');
      if (target) { show(Number(target.dataset.trendDay)); tooltip.hidden = false; }
    });
    chart.addEventListener('focusout', e => { if (!chart.contains(e.relatedTarget)) tooltip.hidden = true; });
    chart.addEventListener('keydown', e => {
      const index = buttons.indexOf(e.target);
      if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0,Math.min(buttons.length - 1,index + (e.key === 'ArrowLeft' ? -1 : 1)));
      buttons[next].focus();
    });
    const lastSale = buttons.findLastIndex(button => button.dataset.median != null);
    show(lastSale >= 0 ? lastSale : buttons.length - 1);
  }
}
