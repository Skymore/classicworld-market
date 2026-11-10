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
  items: [{ item_id: 2000002, quantity: 600 }, { item_id: 4004000, quantity: 45 }, { item_id: 2040804, quantity: 2 }],
  equipment: [
    { slot: 1, item_id: 1452016, decoded: true, stats: [{ key: 'weapon_attack', value: 59 }, { key: 'dex', value: 3 }], remaining_upgrades: 7, enhancements: 0 },
    { slot: 4, item_id: 1040002, decoded: false, stats: [], remaining_upgrades: null, enhancements: null },
  ] };
const gearSale = (price, attack, days = 1) => ({ sale_unit_price: price, time: now - days * 86400,
  equipment: { status: 'candidate', stats: [{ key: 'weapon_attack', value: attack }], remaining_upgrades: 7, enhancements: 0 } });
const gearSales = { 1452016: [gearSale(100000, 59), gearSale(120000, 59), gearSale(140000, 59), gearSale(500000, 60)],
  1040002: [gearSale(3000, 0), gearSale(5000, 0)] };
const products = [
  { item_id: 2000002, name_zh: '白色药水', name_en: 'White Potion', category: '消耗品', sales_window: 30, typical_window_low: 290.4, typical_window: 300, icon_url: '' },
  { item_id: 4004000, name_zh: '力量母矿', name_en: 'Power Crystal Ore', category: '其他', sales_window: 0, typical_low: 22000, typical: 25000, icon_url: '' },
  { item_id: 2040804, name_zh: '手套攻击卷轴', name_en: 'Gloves ATT Scroll', category: '消耗品', sales_window: 0, icon_url: '' },
  { item_id: 1452016, name_zh: '火焰弓', name_en: 'Fire Bow', category: '装备', sales_window: 4, sales_10d: 4, icon_url: '' },
  { item_id: 1040002, name_zh: '白色背心', name_en: 'White Undershirt', category: '装备', sales_10d: 2, icon_url: '' },
];
const npc = { 2000002: 300, 4004000: 5000, 1452016: 20000 };
let gameConnected = true;
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
    if (url.pathname === '/api/v1/collector/inventory') data = { holdings: gameConnected ? holdings : null };
    if (url.pathname.startsWith('/api/v1/item/')) data = { sales: gearSales[url.pathname.split('/').at(-1)] || [], listings: [] };
    if (url.pathname === '/api/v1/crafting/prices') data = { prices: [] };
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data));
  }
  if (url.pathname === '/host.html') {
    // Stands in for the collector window: it frames the website's page and hands it the PC's bag.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><body style="margin:0"><iframe src="/selling?lang=zh&embed=1&own=1" style="width:100vw;height:100vh;border:0"></iframe><script>
      window.bag = ${JSON.stringify(holdings)};
      const frame = document.querySelector('iframe');
      window.send = () => frame.contentWindow.postMessage({ type: 'cwm-bag', holdings: window.bag }, location.origin);
      addEventListener('message', e => { if (e.source === frame.contentWindow && e.data && e.data.type === 'cwm-bag-request') send(); });
    </script></body>`);
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
  // 装备栏是默认页：同物攻 59 的三笔成交（排除物攻 60 的高价），25% 110,000、中位 120,000。
  await page.locator('[data-selling-item="eq:1:1452016"]').click();
  const bow = page.locator('[data-selling-row="eq:1:1452016"]');
  await bow.waitFor();
  assert.match(await bow.locator('[data-selling-stats]').textContent(), /物攻 \+59.*敏 \+3.*可升 7/);
  await page.waitForFunction(() => /同物攻 59 · 成交 3 笔/.test(document.querySelector('[data-selling-row="eq:1:1452016"]')?.textContent || ''));
  assert.match(await bow.getByRole('radio', { name: /成交 25%/ }).textContent(), /110,000/);
  assert.equal(await total(page), '120,000');
  assert.match(await bow.locator('[data-selling-npc]').textContent(), /20,000/);
  // 属性没解析的装备：按同名全部成交并标明。
  await page.locator('[data-selling-item="eq:4:1040002"]').click();
  await page.waitForFunction(() => /同名 · 成交 2 笔（属性不同）/.test(document.querySelector('[data-selling-row="eq:4:1040002"]')?.textContent || ''));
  assert.equal(await total(page), '124,000');
  if (process.env.SELLING_SHOTS) await page.screenshot({ path: path.join(process.env.SELLING_SHOTS, 'selling-gear.png'), fullPage: true });
  await bow.getByRole('button', { name: '移出清单' }).click();
  await page.locator('[data-selling-row="eq:4:1040002"]').getByRole('button', { name: '移出清单' }).click();
  await page.getByRole('tab', { name: '消耗' }).click();
  await page.locator('[data-selling-item="2000002"]').click();
  const row = page.locator('[data-selling-row="2000002"]');
  await row.waitFor();
  // 默认成交中位 300，每组 100 × 6 组。
  assert.equal(await total(page), '180,000');
  // 价格竖排：成交 25%、成交中位、手动自上而下同一列。
  const boxes = await Promise.all(['button[role=radio] >> nth=0', 'button[role=radio] >> nth=1', 'label']
    .map(s => row.locator('.selling-prices ' + s).boundingBox()));
  for (let i = 1; i < boxes.length; i++) {
    assert.equal(Math.round(boxes[i].x), Math.round(boxes[0].x));
    assert.ok(boxes[i].y > boxes[i - 1].y);
  }
  assert.match(await row.locator('[data-selling-npc]').textContent(), /300/);
  // 300 不高于 NPC 回收 300：提示卖 NPC。
  assert.match(await row.textContent(), /直接卖 NPC 更划算/);
  // 成交 25%：290.4 向上取整 291。
  await row.getByRole('radio', { name: /成交 25%/ }).click();
  assert.equal(await total(page), '174,600');
  await row.locator('input[inputmode=numeric]').first().fill('450');
  assert.equal(await total(page), '270,000');
  assert.doesNotMatch(await row.textContent(), /更划算/);
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
  assert.match(await scroll.textContent(), /请输入单价/);
  // 没数据的档位不显示成选中，手动输入框突出。
  assert.equal(await scroll.locator('.selling-prices button.on').count(), 0);
  assert.equal(await scroll.locator('.selling-prices label.on').count(), 1);
  // 方案存在本机，刷新后还在。
  await page.reload();
  await page.locator('[data-selling-row="2000002"]').waitFor();
  assert.equal(await page.locator('[data-selling-row]').count(), 3);
  assert.deepEqual(errors, []);
  if (process.env.SELLING_SHOTS) await page.screenshot({ path: path.join(process.env.SELLING_SHOTS, 'selling-desktop.png'), fullPage: true });
  console.log('PASS desktop: equipment by main stat, unread stats fallback, bag, vertical prices, sold 25%/median, manual, NPC price, saved plan');

  // 采集器的「摆摊」栏目：同一页面经本机回环打开，读本机背包；没有页内导航和面包屑。
  const client = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  await client.addInitScript(() => { if (!sessionStorage.getItem('fresh')) { localStorage.clear(); sessionStorage.setItem('fresh', '1'); } });
  await client.goto(origin + '/selling?lang=zh&embed=1');
  await client.locator('[data-selling-item="eq:1:1452016"]').click();
  await client.getByRole('tab', { name: '消耗' }).click();
  await client.locator('[data-selling-item="2040804"]').click();
  await client.locator('[data-selling-item="2000002"]').click();
  assert.equal(await client.locator('.embed-nav, .tool-breadcrumb').count(), 0);
  assert.match(await client.locator('[data-selling-source]').textContent(), /背包更新于/);
  if (process.env.SELLING_SHOTS) await client.screenshot({ path: path.join(process.env.SELLING_SHOTS, 'selling-client.png') });
  // 游戏断开：继续显示上次读到的背包并标明，清单照常定价。
  gameConnected = false;
  await client.waitForFunction(() => /游戏未连接/.test(document.querySelector('[data-selling-source]')?.textContent || ''), null, { timeout: 15000 });
  assert.ok(await client.locator('[data-selling-item="2000002"]').isVisible());
  assert.doesNotMatch(await client.locator('[data-selling-row="2000002"]').textContent(), /已经没有了/);
  await client.reload();
  await client.locator('[data-selling-row="eq:1:1452016"]').waitFor();
  assert.match(await client.locator('[data-selling-source]').textContent(), /游戏未连接/);
  if (process.env.SELLING_SHOTS) await client.screenshot({ path: path.join(process.env.SELLING_SHOTS, 'selling-client-offline.png') });
  gameConnected = true;
  console.log('PASS collector tab: local bag, no in-page navigation, last bag kept while the game is disconnected');

  // 新版采集器的「摆摊」栏目：加载网站页面本身（own=1），背包由采集器窗口用页面消息传入，不需要登录。
  const host = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  await host.addInitScript(() => { if (!sessionStorage.getItem('fresh')) { localStorage.clear(); sessionStorage.setItem('fresh', '1'); } });
  const deviceCalls = [];
  host.on('request', r => { if (/account\/devices|collector\/inventory/.test(r.url())) deviceCalls.push(r.url()); });
  await host.goto(origin + '/host.html');
  const tab = host.frameLocator('iframe');
  await tab.locator('[data-selling-item="eq:1:1452016"]').click();
  await tab.locator('[data-selling-row="eq:1:1452016"]').waitFor();
  assert.equal(await tab.locator('.embed-nav, .tool-breadcrumb').count(), 0);
  assert.match(await tab.locator('[data-selling-source]').textContent(), /背包更新于/);
  await host.evaluate(() => { window.bag = null; window.send(); });
  await tab.locator('[data-selling-source]', { hasText: '游戏未连接' }).waitFor();
  assert.ok(await tab.locator('[data-selling-item="eq:1:1452016"]').isVisible());
  assert.deepEqual(deviceCalls, []);
  console.log('PASS collector tab (website page): bag passed in by the window, no sign-in or local endpoint');

  const phone = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await phone.addInitScript(() => localStorage.clear());
  await phone.goto(origin + '/selling?lang=zh');
  await phone.getByRole('tab', { name: '消耗' }).tap();
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
