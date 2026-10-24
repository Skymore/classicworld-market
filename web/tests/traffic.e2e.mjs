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
  pages: [{ name: '/item/2000000', count: 800 }], sources: [{ name: 'example.com', count: 35 }], devices: [{ name: 'phone', count: 1100 }] };
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
  const file = url.pathname === '/traffic' ? path.join(root, 'traffic.html')
    : url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
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
    await page.setViewportSize({ width, height: 900 }); await page.goto(origin + '/traffic');
    await page.waitForFunction(() => document.getElementById('today-pv').textContent === '87');
    assert.equal(await page.locator('.day').count(), 30);
    assert.equal(await page.locator('#average-uv').textContent(), '14.5');
    assert(await page.locator('#pages').textContent().then(text => text.includes('/item/2000000')));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await page.locator('summary').click(); await page.locator('#daily tr').first().waitFor();
    await page.selectOption('#days', '7'); await page.waitForFunction(() => !document.getElementById('days').disabled);
    if (process.env.TRAFFIC_SCREENSHOTS) {
      await mkdir(process.env.TRAFFIC_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.TRAFFIC_SCREENSHOTS, `traffic-${width}.png`), fullPage: true });
    }
  }
  assert.equal(views.length, 4, 'operator dashboard does not count itself');
  assert.deepEqual(errors, []);
  console.log('PASS traffic: real SPA navigation, query/hash/SSE dedup, reload UV, privacy opt-out, desktop/mobile dashboard');
} finally {
  await browser.close(); for (const stream of streams) stream.end();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
