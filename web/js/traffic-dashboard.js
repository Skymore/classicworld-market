import { trackPage } from './lib/traffic.js';
trackPage('/traffic');
(function () {
  const byId = id => document.getElementById(id);
  const number = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  function rows(id, values) {
    const body = byId(id);
    body.replaceChildren();
    for (const valuesInRow of values.length ? values : [['暂无数据', '—']]) {
      const row = body.insertRow();
      valuesInRow.forEach(value => { row.insertCell().textContent = String(value); });
    }
  }
  function render(data) {
    byId('today-pv').textContent = number(data.today.pageviews);
    byId('today-uv').textContent = number(data.today.visitors);
    byId('period-pv').textContent = number(data.pageviews);
    byId('average-uv').textContent = number(data.daily_visitors / data.days);
    const trend = byId('trend');
    trend.replaceChildren();
    const max = Math.max(1, ...data.daily.map(day => day.pageviews));
    for (const item of data.daily) {
      const day = document.createElement('div'); day.className = 'day';
      day.title = `${item.day}：${item.pageviews} 次浏览，${item.visitors} 位访客`;
      for (const [value, className] of [[item.pageviews, 'bar'], [item.visitors, 'bar visitor']]) {
        const bar = document.createElement('span'); bar.className = className;
        bar.style.height = `${value / max * 100}%`; day.append(bar);
      }
      trend.append(day);
    }
    byId('start-date').textContent = data.daily[0].day;
    byId('end-date').textContent = data.daily.at(-1).day + '（UTC）';
    rows('daily', [...data.daily].reverse().map(day => [day.day, number(day.pageviews), number(day.visitors)]));
    rows('pages', data.pages.map(row => [row.name, number(row.count)]));
    rows('sources', data.sources.map(row => [row.name || '直接访问 / 站内跳转', number(row.count)]));
    const devices = { phone: '手机', tablet: '平板', desktop: '电脑' };
    rows('devices', data.devices.map(row => [devices[row.name] || row.name, number(row.count)]));
  }
  let running = false;
  async function refresh() {
    if (running) return;
    running = true; byId('refresh').disabled = true; byId('days').disabled = true;
    try {
      const response = await fetch('/api/v1/traffic/summary?days=' + byId('days').value, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      render(await response.json());
      byId('status').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN') + ' · 每分钟自动刷新';
      delete byId('status').dataset.error;
    } catch {
      byId('status').textContent = '统计暂时无法读取，请稍后刷新。';
      byId('status').dataset.error = '1';
    } finally { running = false; byId('refresh').disabled = false; byId('days').disabled = false; }
  }
  byId('refresh').addEventListener('click', refresh);
  byId('days').addEventListener('change', refresh);
  setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
  void refresh();
}());
