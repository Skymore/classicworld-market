// The already-open leaderboard responds to the existing SSE event on both
// desktop and mobile; no navigation, polling timer or manual reload is needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const streams = new Set();
let shops = 1, reads = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n'); streams.add(res);
    req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: false };
    if (url.pathname === '/api/v1/contributors') {
      reads++;
      data = { period: url.searchParams.get('period'), contributors: [{ nickname: '测试蘑菇', shops, quotes: shops * 3, days: 1 }] };
    }
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
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [false, true]) {
    shops = 1;
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 760 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/contributors?lang=zh`);
    await page.waitForFunction(() => document.querySelector('.board-row strong')?.textContent === '1');
    await page.waitForFunction(() => document.documentElement.dataset.liveConnection === 'connected');
    const before = reads, started = performance.now();
    shops = 2;
    for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
    await page.waitForFunction(() => document.querySelector('.board-row strong')?.textContent === '2', null, { timeout: 2000 });
    assert.ok(reads > before);
    assert.equal(new URL(page.url()).pathname, '/contributors');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mobile, eventToVisibleMs: Math.round(performance.now() - started), automatic: true }));
    await page.close();
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
