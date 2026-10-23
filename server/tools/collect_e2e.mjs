// Headless check of the collector page: it loads the WASM on the page and in the worker,
// reads a synthetic shop from a mocked screen share, and posts it to /api/v1/upload.
//   cargo run --release -p market-core --example reader_bench -- --dump /tmp/r4frames
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node server/tools/collect_e2e.mjs /tmp/r4frames
// getDisplayMedia is replaced by a canvas stream of the frame; /api/v1/* is answered by the test.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const frame = fs.readFileSync(path.join(process.argv[2] || '/tmp/r4frames', 'collect_e2e_1920x1080.raw'));
// Optional channel: show the menu first, then the shop, and check the actual upload.
const expectedChannel = Number(process.argv[3] || 0);
const menu = expectedChannel ? fs.readFileSync(path.join(process.argv[2], `channel_${expectedChannel}.raw`)) : null;
const PORT = 18000 + Math.floor(Math.random() * 1000);

// (slot, item id, price, bundle, stock) the frame shows.
const EXPECTED = [
  [1, 4010001, 45000, 10, 1], [2, 2000000, 2500, 100, 1], [3, 2000006, 9999, 1, 0],
  [4, 2060000, 45000, 1000, 1], [5, 4020000, 1234567, 11, 0],
];

const server = spawn(process.execPath, ['server/tools/serve_collect.mjs', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));
const fail = (msg) => { console.error('FAIL:', msg); server.kill(); process.exit(1); };

let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await page.route('**/__e2e/frame.raw', (r) => r.fulfill({ body: frame, contentType: 'application/octet-stream' }));
  if (menu) await page.route('**/__e2e/menu.raw', (r) => r.fulfill({ body: menu, contentType: 'application/octet-stream' }));
  let registered = 0;
  await page.route('**/api/v1/register', (r) => { registered++; r.fulfill({ status: 201, json: { member_id: 'e2e', token: 't'.repeat(40) } }); });
  let uploadResolve;
  const uploaded = new Promise((resolve) => { uploadResolve = resolve; });
  await page.route('**/api/v1/upload', (r) => {
    const req = r.request();
    uploadResolve({ body: JSON.parse(req.postData()), auth: req.headers().authorization });
    r.fulfill({ status: 201, json: { ok: true, duplicate: false } });
  });
  await page.addInitScript(({ expectedChannel }) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 1920; c.height = 1080;
      const ctx = c.getContext('2d');
      const raw = new Uint8ClampedArray(await (await fetch('/__e2e/frame.raw')).arrayBuffer());
      const img = new ImageData(raw, 1920, 1080);
      const menuImage = expectedChannel ? new ImageData(new Uint8ClampedArray(await (await fetch('/__e2e/menu.raw')).arrayBuffer()), 1920, 1080) : null;
      let showShop = !menuImage;
      // The test switches only once the real worker has read the menu and minimap.
      window.__e2eShowShop = () => { showShop = true; };
      const paint = () => ctx.putImageData(showShop ? img : menuImage, 0, 0);
      paint();
      setInterval(paint, 100);   // a canvas stream only sends frames when the canvas is painted
      return c.captureStream(10);
    };
  }, { expectedChannel });
  await page.goto(`http://127.0.0.1:${PORT}/collect/`);
  await page.waitForFunction(() => document.documentElement.dataset.ready, null, { timeout: 30000 });
  const ready = await page.evaluate(() => document.documentElement.dataset.ready);
  if (ready !== '1') fail('page did not load the WASM reader: ' + (await page.textContent('#error')));
  console.log('page loaded:', await page.textContent('#ver'));
  await page.click('#start');
  if (expectedChannel) {
    await page.waitForFunction((ch) => document.querySelector('#c-channel').textContent === String(ch)
      && document.querySelector('#c-map').textContent.includes('4'), expectedChannel, { timeout: 30000 });
    await page.evaluate(() => window.__e2eShowShop());
  }
  const got = await Promise.race([uploaded, new Promise((resolve) => setTimeout(() => resolve(null), 60000).unref())]);
  if (!got) fail('no upload within 60 s; log: ' + (await page.textContent('#log')));
  const b = got.body;
  if (b.version !== 1 || b.source !== 'screen' || b.world !== 'ClassicWorld' || b.complete !== true) fail('envelope ' + JSON.stringify(b));
  if (expectedChannel && (b.location?.channel !== expectedChannel || b.location?.room !== 4)) fail('location ' + JSON.stringify(b.location));
  if (expectedChannel && !b.reader_version.includes('channels-v2')) fail('outdated WASM ' + b.reader_version);
  if (!Number.isInteger(b.shop_id) || b.shop_id < 1 || b.shop_id > 2 ** 32 - 1) fail('shop_id ' + b.shop_id);
  if (got.auth !== 'Bearer ' + 't'.repeat(40) || registered !== 1) fail('auth ' + got.auth + ' registered ' + registered);
  const items = b.items.map((i) => [i.slot, i.item_id, i.price, i.bundle, i.stock]);
  if (JSON.stringify(items) !== JSON.stringify(EXPECTED)) fail('items ' + JSON.stringify(items));
  const chips = await page.evaluate(() => ({
    fps: document.getElementById('c-fps').textContent,
    find: document.getElementById('c-find').textContent,
    read: document.getElementById('c-read').textContent,
    scale: document.getElementById('c-scale').textContent,
    rows: document.querySelectorAll('#rows tr:not(.rej)').length,
  }));
  console.log('upload ok:', JSON.stringify({ shop_id: b.shop_id, title: b.title, location: b.location, reader: b.reader_version, items: items.length }));
  console.log('page chips:', JSON.stringify(chips));
  const errors = logs.filter((l) => /^(error|pageerror)/.test(l));
  if (errors.length) fail('console errors: ' + errors.join(' | '));
  // SHOT=file.png: a picture of the page after the upload (layout check).
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  console.log('PASS');
} finally {
  await browser?.close();
  server.kill();
}
