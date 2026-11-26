// 刷图 in the client and on the site is one set of pages: the history list (filters drawn from
// the period on screen), one run with its comparison line, sharing, and the leaderboard tabs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const desktop = path.resolve(fileURLToPath(new URL('../../desktop_ui/', import.meta.url)));
const now = Date.now() / 1000;
const base = (ago, minutes, map, name, kills, segments) => ({
  started_at: now - ago, ended_at: now - ago + minutes * 60, active_seconds: minutes * 60, map_id: 10006161,
  character: { name, level: 74, job: 310 }, job_name: '猎人', level: 74, map_name: map, exp: 1000 * minutes,
  exp_per_hour: 60000, net: 100, net_per_hour: 2000, kills, rate_history: [], segments,
});
const hour = 3600;
const runs = [base(1 * hour, 3, '破败的坟墓', 'Skyyyy', 36, 1), base(2 * hour, 12, '破败的坟墓', 'Skyyyy', 300, 2),
  base(3 * hour, 25, '第3军营', 'Other', 900, 1), base(4 * hour, 165, '破败的坟墓', 'Skyyyy', 2777, 3),
  base(40 * 24 * hour, 30, '旧地图', 'Old', 50, 1)];   // another period: never offered in this one's filters
// The piece picked up keeps its own stats: its quick preview shows those, not the catalogue's.
runs[4 - 1].loot = [{ item_id: 1432006, name: '九龙刀', quantity: 1, value: 800000, remaining_upgrades: 7,
  stats: [{ key: 'weapon_attack', value: 76 }] }];
const comparison = { level_from: 71, level_to: 75, job: 310, runs: 12, exp_better_than: 0.75, exp_per_hour_median: 50000 };
const site = runs.map((r, i) => { const { segments, ...rest } = r; return { ...rest, row: i + 1, share_code: i === 3 ? 'abc' : null, segment_count: segments }; });
const client = runs.map((r, i) => ({ ...r, id: `run${i}`, segments: Array.from({ length: r.segments }, () => ({})), share_url: null }));
const shares = [];

const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
const type = file => file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: true, public_id: 'me', csrf: 'x', nickname: '测试', stats: {} });
  if (url.pathname === '/api/v1/grind/runs') return json(res, { runs: site });
  const one = url.pathname.match(/^\/api\/v1\/grind\/runs\/(\d+)(\/share)?$/);
  if (one && one[2]) { shares.push(one[1]); return json(res, { code: 'site1234', url: 'unused' }); }
  if (one) return json(res, { row: Number(one[1]), run: site[Number(one[1]) - 1], share_code: null, comparison });
  if (url.pathname === '/api/v1/catalog/page') return json(res, { kind: 'item', page: { item: { id: 1432006, name_zh: '九龙刀', name_en: 'The Nine Dragons', category: '装备', req_level: 50 },
    stats: null, droppers: [], npc_offers: [], equipment: { upgrades: 7 }, market: { listings: [], sales: [], days: [], sale_points: [], base_stats: [['weapon_attack', 75]] } } });
  if (url.pathname === '/api/v1/grind/live') return json(res, { runs: [] });
  if (url.pathname === '/api/v1/grind/leaderboard') return json(res, { rows: [] });
  if (url.pathname.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ok\n\n'); return; }
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const desk = url.pathname.startsWith('/desk/');
  const rootDir = desk ? desktop : web;
  const rel = desk ? (url.pathname.slice(6) || 'index.html') : url.pathname.startsWith('/web/') ? url.pathname.slice(5) : 'index.html';
  const file = path.resolve(rootDir, rel);
  if (!file.startsWith(rootDir)) { res.writeHead(404); return res.end(); }
  try { res.setHeader('Content-Type', type(file)); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const options = async (page, label) => (await page.locator(`select[aria-label="${label}"] option`).allInnerTexts()).slice(1);

async function list(page, label) {
  const rows = page.locator('.gh-row:not(.head)');
  await rows.first().waitFor();
  if (process.env.GRIND_SHOTS) await page.screenshot({ path: path.join(process.env.GRIND_SHOTS, label + '.png') });
  assert.equal(await rows.count(), 4, label + ': this period\'s runs');
  assert.match(await rows.last().innerText(), /\+2/, label + ': maps a run went through');
  assert.match(await page.locator('.gh-row.head').innerText(), /击杀/, label + ': kills column');
  // Characters and maps come from the period on screen, not from all history.
  assert.deepEqual((await options(page, '角色')).sort(), ['Other', 'Skyyyy'], label + ': characters of this period');
  assert.deepEqual((await options(page, '地图')).sort(), ['破败的坟墓', '第3军营'].sort(), label + ': maps of this period');
  await page.locator('select[aria-label="地图"]').selectOption('第3军营');
  assert.equal(await rows.count(), 1, label + ': one map');
  assert.equal(await page.locator('select[aria-label="角色"]').count(), 0, label + ': one character on that map, no list');
  await page.locator('select[aria-label="地图"]').selectOption('');
  const length = page.locator('select[aria-label="时长"]');
  await length.selectOption('10');
  assert.equal(await rows.count(), 3, label + ': 10 minutes or more');
  await length.selectOption('20');
  assert.equal(await rows.count(), 2, label + ': 20 minutes or more');
  await length.selectOption('0');
}

async function runPage(page, label) {
  await page.locator('.gh-row:not(.head)').last().click();
  await page.getByText('这场经验效率高于 75%').waitFor();
  const blade = page.locator('[data-piece-item="1432006"]');
  assert.match(await blade.innerText(), /攻击\+76/, label + ': the dropped piece shows its own stats');
  if (label === 'site') {   // the client opens the site's item page instead of a preview
    await blade.hover();
    await page.locator('.item-peek.is-piece [data-preview-piece]').waitFor();
    assert.match(await page.locator('.item-peek').innerText(), /76/, label + ': its preview shows this piece');
    assert.doesNotMatch(await page.locator('.item-peek').innerText(), /\+75/, label + ': not the catalogue base');
    await page.mouse.move(0, 0);
  }
  await page.getByRole('button', { name: '分享' }).click();
  const link = page.locator('.gs-url');
  await page.waitForFunction(() => /\/g\//.test(document.querySelector('.gs-url')?.value || ''));
  assert.match(await link.inputValue(), /\/g\/\w+/, label + ': the link is made when sharing opens');
  for (const name of ['复制链接', '打开分享页', '复制图片', '保存图片'])
    assert.equal(await page.locator('.gs-side').getByRole('button', { name }).count(), 1, `${label}: ${name}`);
  if (process.env.GRIND_SHOTS) await page.screenshot({ path: path.join(process.env.GRIND_SHOTS, label + '-share.png'), fullPage: true });
}

try {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/grind?lang=zh');
  await list(page, 'site');
  await page.locator('select[aria-label="时长"]').selectOption('20');
  await page.reload();
  await page.locator('.gh-row:not(.head)').first().waitFor();
  assert.equal(await page.locator('.gh-row:not(.head)').count(), 2, 'site: the length filter is remembered');
  await page.locator('select[aria-label="时长"]').selectOption('0');
  await runPage(page, 'site');
  assert.deepEqual(shares, ['4']);
  // Inside the collector (embed, own) the site's grind tabs are left to the collector.
  await page.goto(origin + '/grind?tab=board&embed=1&own=1&lang=zh');
  await page.getByText('近 30 天全站客户端数据').waitFor();
  assert.equal(await page.locator('.grind-site-bar').count(), 0, 'embedded: no second tab bar');
  assert.equal(await page.locator('.embed-nav').count(), 0, 'embedded: no in-page navigation');

  const desk = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  desk.on('pageerror', e => errors.push(e.message));
  await desk.addInitScript(({ runs, comparison, origin }) => {
    const state = { version: '0.8.9', phase: 'idle', mode: 'scan', message: '', capture: 'connected', upload: 'ready', updates: 'up_to_date',
      selected: 12, windows: [{ id: 12, title: 'MapleStory', pid: 42 }], theme: 'light', language: 'zh', activities: [], maximized: false };
    const live = () => ({ alive_at: Date.now() / 1000, stale: false, runs: [], finished: [], calibration: [], characters: [] });
    const settings = { buff_warn_seconds: 3, buff_sound: false, hotkeys: {}, overlay: { enabled: false, fields: [] } };
    window.calls = [];
    const pages = { grind_board: '/grind?tab=board', grind_all: '/grind?tab=all' };
    window.pywebview = { api: { ready: async () => state, command: async () => true,
      workspace: async (action, value) => { window.calls.push([action, value?.page]); return action === 'page' ? { url: origin + (pages[value.page] || '/') + '&embed=1&own=1&lang=zh' } : { linked: false }; },
      grind: async (action, value) => {
        window.calls.push([action, value]);
        if (action === 'history') return runs;
        if (action === 'compare') return comparison;
        if (action === 'share') return { code: 'desk1234', url: 'https://mxd.ruit.me/g/desk1234' };
        return { live: live(), settings, editing: false, calibrating: false, calibration: null };
      },
      state: async () => ({ live: live(), settings, editing: false, language: 'zh', update: null }) } };
  }, { runs: client, comparison, origin });
  await desk.goto(origin + '/desk/');
  await desk.getByRole('button', { name: '刷图' }).first().click();
  await desk.getByRole('button', { name: '历史' }).first().click();
  await list(desk, 'client');
  await runPage(desk, 'client');
  assert.ok(await desk.evaluate(() => window.calls.some(([a, v]) => a === 'compare' && v === 'run3')), 'client: comparison asked for');
  await desk.getByRole('button', { name: '地图效率榜' }).click();
  await desk.frameLocator('iframe[title="地图效率榜"]').getByText('近 30 天全站客户端数据').waitFor();
  assert.ok(await desk.evaluate(() => window.calls.some(([a, v]) => a === 'page' && v === 'grind_board')), 'client: the leaderboard is the site page');
  if (process.env.GRIND_SHOTS) await desk.screenshot({ path: path.join(process.env.GRIND_SHOTS, 'client-board.png') });
  await desk.getByRole('button', { name: '全部用户' }).click();
  assert.ok(await desk.evaluate(() => window.calls.some(([a, v]) => a === 'page' && v === 'grind_all')), 'client: everyone is the site page');
  assert.deepEqual(errors, []);
  console.log('grind pages: site and client agree');
} finally {
  await browser.close();
  server.close();
}
