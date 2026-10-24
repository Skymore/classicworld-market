import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const views = [], streams = new Set();
const now = Date.now() / 1000;
const daily = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, pageviews: i * 3, visitors: i }));
const report = { days: 30, pageviews: 1305, daily_visitors: 435, today: { pageviews: 87, visitors: 29 }, daily,
  regions: [{ code: 'US', count: 800 }, { code: 'CA', count: 350 }, { code: 'SG', count: 100 }, { code: '', count: 55 }],
  sources: [{ name: 'example.com', count: 35 }, { name: '', count: 1270 }], devices: [{ name: 'phone', count: 1100 }, { name: 'desktop', count: 205 }] };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/traffic/event') {
    let body = ''; for await (const part of req) body += part;
    views.push(JSON.parse(body)); res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/traffic/summary') data = report;
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/market') data = { as_of: now, products: [] };
    if (url.pathname === '/api/v1/market/period-default') data = { default_hours: 'all' };
    if (url.pathname === '/api/v1/sales/recent') data = { sales: [], generated_at: now };
    if (url.pathname === '/api/v1/crafting/prices') data = { prices: [] };
    if (url.pathname === '/api/v1/dex/counts') data = { mobs: 1, maps: 1 };
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data));
  }
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const poll = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } assert(predicate(), 'timed out waiting for tracking'); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => localStorage.setItem('lang', 'zh'));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?q=never-record-this'); await poll(() => views.length === 1);
  assert.equal(views[0].path, '/');
  const navigate = async href => {
    await page.evaluate(href => { const link = document.createElement('a'); link.href = href; document.body.append(link); link.click(); link.remove(); }, href);
  };
  await navigate('/privacy'); await poll(() => views.length === 2);
  await page.getByRole('heading', { name: '网站访问统计', exact: true }).waitFor();
  await navigate('/privacy?lang=zh#details');
  for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
  await page.waitForTimeout(200); assert.equal(views.length, 2, 'query/hash changes and SSE do not record views');
  await page.goBack(); await page.waitForTimeout(100); assert.equal(views.length, 2);
  await page.goBack(); await poll(() => views.length === 3);
  assert.equal(new Set(views.map(view => view.visitor)).size, 1);
  await page.reload(); await poll(() => views.length === 4);
  assert.equal(views[3].visitor, views[0].visitor, 'reload keeps the daily UV');
  const privatePage = await browser.newPage();
  await privatePage.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
  await privatePage.goto(origin + '/'); await privatePage.locator('.hero').waitFor();
  await privatePage.waitForTimeout(150); assert.equal(views.length, 4);
  await privatePage.close();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(origin + '/');
    await page.locator('[data-traffic-link]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.home-foot a[href="/web/download.html"]').count(), 0);
    await page.evaluate(() => { window.trafficHeader = document.querySelector('.ptop'); });
    await page.locator('[data-traffic-link]').click();
    await page.waitForURL(origin + '/traffic');
    await page.locator('[data-traffic-page] .traffic-world').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-traffic-today-pv]').textContent === '87');
    assert(await page.evaluate(() => window.trafficHeader === document.querySelector('.ptop')), 'traffic shares the persistent site shell');
    assert.equal(await page.locator('.dock a').count(), 6);
    assert.equal(await page.locator('[data-traffic-page] .stall').count(), 4);
    assert.equal(await page.locator('[data-traffic-page] p').count(), 0, 'no explanatory paragraphs');
    assert.equal(await page.locator('.traffic-world [data-country=US][data-visited]').count(), 1);
    assert.equal(await page.locator('.traffic-world [data-country=SG][data-visited]').count(), 1);
    await page.locator('[data-region=CA]').click();
    assert.equal(await page.locator('.traffic-world [data-country=CA][data-selected]').count(), 1);
    await page.locator('.traffic-world [data-country=US]').focus();
    await page.locator('.traffic-world [data-country=US]').press('Enter');
    assert.equal(await page.locator('.traffic-world [data-country=US][data-selected]').count(), 1);
    assert(!await page.locator('[data-traffic-page]').textContent().then(text => /热门页面|每日明细|统计口径|UTC|Do Not Track/.test(text)));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    const range = page.waitForResponse(response => response.url().includes('/api/v1/traffic/summary?days=30'));
    await page.getByLabel('统计范围', { exact: true }).selectOption('30'); await (await range).finished();
    assert.equal(await page.getByLabel('统计范围', { exact: true }).evaluate(node => getComputedStyle(node).fontSize), '16px');
    assert(await page.locator('.traffic-breakdown').first().textContent().then(text => text.includes('example.com')));
    if (process.env.TRAFFIC_SCREENSHOTS) {
      await mkdir(process.env.TRAFFIC_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.TRAFFIC_SCREENSHOTS, `traffic-${width}-light.png`), fullPage: true });
    }
    await page.locator('[data-theme-toggle]:visible').click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.traffic-map-panel')).backgroundColor), 'rgb(35, 43, 56)');
    if (process.env.TRAFFIC_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TRAFFIC_SCREENSHOTS, `traffic-${width}-dark.png`), fullPage: true });
    await page.locator('[data-lang-toggle]:visible').click();
    await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
    await page.getByLabel('Period', { exact: true }).selectOption('90');
    assert.equal(await page.locator('[data-traffic-page] p').count(),0);
    await page.locator('[data-theme-toggle]:visible').click();
  }
  await poll(() => views.length === 8);
  assert.equal(views.filter(view => view.path === '/traffic').length, 2, 'public page counts visits but not summary refreshes');
  assert.deepEqual(errors, []);
  console.log('PASS traffic: shared shell/theme, concise UI, no download entry, regions map/keyboard, sources/devices, ranges, language, mobile and tracking dedup');
} finally {
  await browser.close(); for (const stream of streams) stream.end();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
