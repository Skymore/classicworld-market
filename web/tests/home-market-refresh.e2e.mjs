// SSE market events refresh the home price table: {"ids":[…]} fetches just those rows and replaces or removes them in
// place; {} revalidates the whole list through the browser cache; events merge (one refresh per 3 s, none while hidden).
// A server without row requests (only {} events, 400 for ids) falls back to whole-list refreshes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Math.floor(Date.now() / 1000);
const streams = new Set();
let rowRequests = true; // false: an older server that knows neither ids events nor row requests
let version = 1;
let rows = new Map(Array.from({ length: 30 }, (_, i) => [2000000 + i, {
  item_id: 2000000 + i, name_zh: `药水 ${i}`, name_en: `Potion ${i}`, category: '消耗品', sales_window: 100 - i,
  sales_10d: 100 - i, listings: 2, typical: 1000 + i, low: 900 + i, change_window: 3, last_seen: now - i, last_sale_at: now - i, trend: [],
}]));
const log = [];
const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data === undefined ? undefined : JSON.stringify(data));
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/market' && url.searchParams.get('view') === 'list') {
    const ids = url.searchParams.get('ids');
    const entry = { at: Date.now(), ids, inm: req.headers['if-none-match'] || null };
    log.push(entry);
    if (ids != null) {
      if (!rowRequests) { entry.status = 400; return json(res, 400, { error: 'bad_request' }); }
      const wanted = ids.split(',').map(Number);
      entry.status = 200;
      return json(res, 200, { as_of: now + version, products: wanted.filter(id => rows.has(id)).map(id => rows.get(id)), removed: wanted.filter(id => !rows.has(id)) }, { 'Cache-Control': 'private, no-cache' });
    }
    const etag = `"v${version}"`;
    const headers = { ETag: etag, 'Cache-Control': rowRequests ? 'private, no-cache' : 'no-store' };
    if (req.headers['if-none-match'] === etag) { entry.status = 304; res.writeHead(304, headers); return res.end(); }
    entry.status = 200;
    return json(res, 200, { as_of: now + version, products: [...rows.values()] }, headers);
  }
  if (url.pathname === '/api/v1/account') return json(res, 200, { signed_in: false });
  if (url.pathname === '/api/v1/market/period-default') return json(res, 200, { default_hours: 'all' });
  if (url.pathname === '/api/v1/dex/dropped-items') return json(res, 200, { item_ids: [] });
  if (url.pathname === '/api/v1/crafting/prices') return json(res, 200, { prices: [] });
  if (url.pathname.startsWith('/api/')) return json(res, 200, {});
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const send = data => { for (const stream of streams) stream.write(`event: market\ndata: ${data}\n\n`); };
const change = (id, patch) => { rows.set(id, { ...rows.get(id), ...patch }); version++; };
const since = at => log.filter(entry => entry.at >= at);
const price = (page, id) => page.locator(`tr[data-open="${id}"] td:nth-child(5)`).textContent();
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('theme', 'light'); });
    await page.goto(origin + '/?hours=all&lang=zh');
    await page.locator('tr[data-open="2000003"]').waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.liveConnection === 'connected');
    await page.evaluate(() => { for (const id of [2000003, 2000004]) document.querySelector(`tr[data-open="${id}"]`).dataset.mark = 'kept'; });

    // One changed row: only that row is fetched and replaced in place.
    let at = Date.now();
    change(2000003, { low: 777 });
    send('{"ids":[2000003]}');
    await page.waitForFunction(() => document.querySelector('tr[data-open="2000003"] td:nth-child(5)')?.textContent.includes('777'));
    assert.deepEqual(since(at).map(entry => entry.ids), ['2000003'], 'an ids event asks for those rows only');
    assert.equal(await page.locator('tr[data-open="2000003"]').getAttribute('data-mark'), 'kept', 'the changed row is updated in place');
    assert.equal(await page.locator('tr[data-open="2000004"]').getAttribute('data-mark'), 'kept', 'other rows stay as they are');
    const firstRefresh = since(at)[0].at;

    // Events within 3 s merge into one later request; a row the list no longer has goes away.
    at = Date.now();
    change(2000005, { low: 555 });
    rows.delete(2000006); version++;
    send('{"ids":[2000005]}');
    send('{"ids":[2000006]}');
    await page.locator('tr[data-open="2000006"]').waitFor({ state: 'detached', timeout: 6000 });
    assert.match(await price(page, 2000005), /555/);
    const merged = since(at);
    assert.equal(merged.length, 1, `merged events make one request: ${JSON.stringify(merged)}`);
    assert.deepEqual(merged[0].ids.split(',').sort(), ['2000005', '2000006']);
    assert(merged[0].at - firstRefresh >= 2900, `refreshes are at least 3 s apart: ${merged[0].at - firstRefresh} ms`);

    // {} revalidates the whole list with its ETag: the patched rows make it differ once, then it costs a 304.
    const fullRefresh = async () => {
      await page.waitForTimeout(3100);
      const start = Date.now();
      send('{}');
      await page.waitForFunction(start => performance.getEntriesByType('resource').some(entry => entry.name.includes('view=list&hours=all') && !entry.name.includes('ids=') && entry.startTime + performance.timeOrigin >= start), start);
      await page.waitForTimeout(300);
      return since(start).map(entry => [entry.ids, entry.status, Boolean(entry.inm)]);
    };
    assert.deepEqual(await fullRefresh(), [[null, 200, true]]);
    assert.deepEqual(await fullRefresh(), [[null, 304, true]], 'unchanged data costs a 304');
    assert.equal(await page.locator('tr[data-open="2000006"]').count(), 0);
    assert.match(await price(page, 2000003), /777/);

    // The next visit revalidates the list the browser kept instead of downloading it again.
    at = Date.now();
    const next = await context.newPage();
    await next.goto(origin + '/?hours=all&lang=zh');
    await next.locator('tr[data-open="2000003"]').waitFor();
    const visit = since(at).filter(entry => entry.ids == null);
    assert.equal(visit.length, 1);
    assert.equal(visit[0].status, 304, `a repeat visit costs a 304: ${JSON.stringify(visit)}`);
    assert.match(await price(next, 2000003), /777/);
    await next.close();

    // A hidden page does not refresh; it catches up once when shown again.
    await page.waitForTimeout(3100);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    at = Date.now();
    change(2000007, { low: 424 });
    send('{"ids":[2000007]}');
    await page.waitForTimeout(1500);
    assert.equal(since(at).length, 0, 'no refresh while hidden');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('tr[data-open="2000007"] td:nth-child(5)')?.textContent.includes('424'));
    assert.deepEqual(since(at).map(entry => entry.ids), ['2000007'], 'one catch-up refresh when shown');

    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS ids events patch rows in place, merge within 3 s and wait while hidden; {} and repeat visits revalidate with 304');
  }
  {
    // An older server: no-store lists, 400 for row requests and only {} events.
    rowRequests = false;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('theme', 'light'); });
    await page.goto(origin + '/?hours=all&lang=zh');
    await page.locator('tr[data-open="2000008"]').waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.liveConnection === 'connected');
    let at = Date.now();
    change(2000008, { low: 868 });
    send('{}');
    await page.waitForFunction(() => document.querySelector('tr[data-open="2000008"] td:nth-child(5)')?.textContent.includes('868'));
    assert.deepEqual(since(at).map(entry => [entry.ids, entry.status]), [[null, 200]], '{} reloads the whole list');
    await page.waitForTimeout(3100);
    at = Date.now();
    change(2000009, { low: 979 });
    send('{"ids":[2000009]}');
    await page.waitForFunction(() => document.querySelector('tr[data-open="2000009"] td:nth-child(5)')?.textContent.includes('979'));
    assert.deepEqual(since(at).map(entry => [entry.ids, entry.status]), [['2000009', 400], [null, 200]], 'a 400 for rows falls back to the whole list');
    await page.waitForTimeout(3100);
    at = Date.now();
    change(2000010, { low: 101 });
    send('{"ids":[2000010]}');
    await page.waitForFunction(() => document.querySelector('tr[data-open="2000010"] td:nth-child(5)')?.textContent.includes('101'));
    assert.deepEqual(since(at).map(entry => [entry.ids, entry.status]), [[null, 200]], 'after a 400 the page stops asking for rows');
    await page.waitForTimeout(3100);
    at = Date.now();
    send('{}');
    await page.waitForFunction(at => window.performance.getEntriesByType('resource').some(entry => entry.name.includes('view=list&hours=all') && entry.startTime + performance.timeOrigin >= at), at);
    await page.waitForTimeout(300);
    assert.deepEqual(since(at).map(entry => [entry.ids, entry.status, Boolean(entry.inm)]), [[null, 304, true]], 'an unchanged no-store list still costs a 304 within the page');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS without row requests: {} and ids events fall back to whole-list refreshes with ETag revalidation');
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
