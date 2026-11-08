// 摆摊页：账号设备的背包、成交 25%/中位、手动价、NPC 回收价和合计。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Date.now() / 1000;
const holdings = { observed_at: Math.floor(now), mesos: 1234567, categories: [2, 3, 4],
  items: [{ item_id: 2000002, quantity: 600 }, { item_id: 4004000, quantity: 45 }, { item_id: 2040804, quantity: 2 }] };
const products = [
  { item_id: 2000002, name_zh: '白色药水', name_en: 'White Potion', category: '消耗品', sales_window: 30, typical_window_low: 290.4, typical_window: 300, icon_url: '' },
  { item_id: 4004000, name_zh: '力量母矿', name_en: 'Power Crystal Ore', category: '其他', sales_window: 0, typical_low: 22000, typical: 25000, icon_url: '' },
  { item_id: 2040804, name_zh: '手套攻击卷轴', name_en: 'Gloves ATT Scroll', category: '消耗品', sales_window: 0, icon_url: '' },
];
const npc = { 2000002: 300, 4004000: 5000 };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events' || url.pathname === '/api/v1/account/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data = {};
    if (url.pathname === '/api/v1/account') data = { signed_in: true, csrf: 'x', nickname: 'tester' };
    if (url.pathname === '/api/v1/account/devices') data = { devices: [{ id: 'dev1', name: '主机', online: true, state: { sweep: { holdings, game: { connected: true } } } }] };
    if (url.pathname === '/api/v1/market/selected') data = { as_of: now, products: products.filter(p => url.searchParams.get('ids').split(',').includes(String(p.item_id))) };
    if (url.pathname === '/api/v1/npc-sell') data = { prices: Object.fromEntries(Object.entries(npc).filter(([id]) => url.searchParams.get('ids').split(',').includes(id))) };
    if (url.pathname === '/api/v1/watchlist/catalog') data = { items: [] };
    if (url.pathname === '/api/v1/crafting/prices') data = { prices: [] };
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
const total = page => page.locator('[data-selling-total]').textContent();
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/selling?lang=zh');
  await page.locator('[data-selling-item="2000002"]').click();
  const row = page.locator('[data-selling-row="2000002"]');
  await row.waitFor();
  // 默认成交中位 300，每组 100 × 6 组。
  assert.equal(await total(page), '180,000');
  // 价格竖排：成交 25%、成交中位、手动、NPC 回收自上而下同一列。
  const boxes = await Promise.all(['button[role=radio] >> nth=0', 'button[role=radio] >> nth=1', 'label', '[data-selling-npc]']
    .map(s => row.locator('.selling-prices ' + s).boundingBox()));
  for (let i = 1; i < boxes.length; i++) {
    assert.equal(Math.round(boxes[i].x), Math.round(boxes[0].x));
    assert.ok(boxes[i].y > boxes[i - 1].y);
  }
  assert.match(await row.locator('[data-selling-npc]').textContent(), /300/);
  // 300 不高于 NPC 回收 300：提示卖 NPC。
  assert.match(await row.textContent(), /NPC 回收价/);
  // 成交 25%：290.4 向上取整 291。
  await row.getByRole('radio', { name: /成交 25%/ }).click();
  assert.equal(await total(page), '174,600');
  await row.locator('input[inputmode=numeric]').first().fill('450');
  assert.equal(await total(page), '270,000');
  assert.doesNotMatch(await row.textContent(), /NPC 回收价，/);
  // 72 小时无成交：退到最近成交价，标注出来。
  await page.getByRole('tab', { name: '其他' }).click();
  await page.locator('[data-selling-item="4004000"]').click();
  const ore = page.locator('[data-selling-row="4004000"]');
  assert.match(await ore.textContent(), /按最近成交/);
  assert.match(await ore.textContent(), /25,000/);
  // 没有任何成交：价格选项不可点，要求手动定价。
  await page.getByRole('tab', { name: '消耗' }).click();
  await page.locator('[data-selling-item="2040804"]').click();
  const scroll = page.locator('[data-selling-row="2040804"]');
  assert.ok(await scroll.getByRole('radio', { name: /成交中位/ }).isDisabled());
  assert.match(await scroll.textContent(), /手动定价/);
  // 方案存在本机，刷新后还在。
  await page.reload();
  await page.locator('[data-selling-row="2000002"]').waitFor();
  assert.equal(await page.locator('[data-selling-row]').count(), 3);
  assert.deepEqual(errors, []);
  if (process.env.SELLING_SHOTS) await page.screenshot({ path: path.join(process.env.SELLING_SHOTS, 'selling-desktop.png'), fullPage: true });
  console.log('PASS desktop: bag, vertical prices, sold 25%/median, manual, NPC price, saved plan');

  const phone = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await phone.addInitScript(() => localStorage.clear());
  await phone.goto(origin + '/selling?lang=zh');
  await phone.locator('[data-selling-item="2000002"]').tap();
  const sizes = await phone.locator('.selling-page input').evaluateAll(list => list.map(i => parseFloat(getComputedStyle(i).fontSize)));
  assert.ok(sizes.length >= 2 && sizes.every(s => s >= 16), String(sizes));
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.SELLING_SHOTS) await phone.screenshot({ path: path.join(process.env.SELLING_SHOTS, 'selling-phone.png'), fullPage: true });
  console.log('PASS phone: 16px inputs, no horizontal scroll');
} finally {
  await browser?.close();
  server.close();
}
