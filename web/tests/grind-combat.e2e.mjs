import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../desktop_ui/', import.meta.url));
const out = process.env.DESKTOP_SCREENSHOTS;
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, p === '/' ? 'index.html' : p);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const fields = ['time', 'exp_rate', 'level', 'profit', 'dps', 'kills', 'party', 'buffs', 'potions', 'recent'];
const run = {
  id: 'test', status: 'active', character: { name: 'Tester', level: 68, job: 310 }, level: 68,
  map_id: 10004141, map_name: '第2军营', job_name: '猎人', active_seconds: 120, idle_seconds: 0,
  exp: 10000, exp_per_hour: 300000, exp_per_hour_5m: 300000, exp_per_hour_1m: 300000,
  exp_percent: 25, percent_per_hour: 20, eta_seconds: 3600, net: 12000, net_per_hour: 360000,
  mesos: 15000, item_value: 2000, consume_cost: 5000, mesos_spent: 0,
  kills: 24, kills_per_hour: 720, kills_estimated: false, deaths: 0, gaps: 0, pending_prices: 0,
  dps: 900, damage: 108000, average_dps: 850, party_known: true,
  attack_count: 40, attacks: [], casts: [], hp_drops: 0, hp_lost: 0, consumables: [], buffs: [], mobs: [], recent: [], drops: [],
  loot: Array.from({ length: 6 }, (_, i) => ({ t: 1, item_id: 4000000 + i, name: `战利品${i}`, quantity: 80 - i, value: 0, priced: false })),
  consumables: Array.from({ length: 4 }, (_, i) => ({ item_id: 2000000 + i, name: `药品${i}`, used: 7 + i, remaining: 819, minutes_left: 443 })),
  combat: Array.from({ length: 6 }, (_, i) => ({ character_id: i + 1, name: i ? `Teammate${i}` : 'Tester', self: !i,
    away: i === 5, partial: i === 4, damage: i === 5 ? null : 108000 - i * 10000,
    dps: i >= 4 ? null : 900 - i * 100, average_dps: 850 - i * 100, kills: 24 - i, hits: 40 })),
};
const settings = { buff_warn_seconds: 10, buff_sound: false, hotkeys: {}, overlay: {
  enabled: true, layout: 'standard', theme: 'dark', opacity: .92, scale: 1, fields,
} };
async function bridge(page, overlay = null) {
  await page.addInitScript(({ run, settings, overlay }) => {
    window.testRun = run;
    if (overlay) Object.assign(settings.overlay, overlay);
    const live = () => ({ alive_at: Date.now() / 1000, stale: false, runs: [structuredClone(window.testRun)], finished: [], calibration: [], characters: [] });
    const state = { version: '0.7.15', phase: 'idle', mode: 'scan', message: '', room: null, channel: null, visited: 0,
      uploaded: 0, capture: 'connected', upload: 'ready', updates: 'up_to_date', selected: 12,
      windows: [{ id: 12, title: 'MapleStory', pid: 42 }], theme: 'light', language: 'zh', activities: [], maximized: false };
    window.pywebview = { api: { ready: async () => state, command: async () => state,
      workspace: async () => ({ linked: false }),
      grind: async () => ({ live: live(), settings, editing: false, calibrating: false, calibration: null }),
      state: async () => ({ live: live(), settings, editing: false, language: 'zh' }),
    } };
  }, { run, settings, overlay });
}
try {
  const page = await browser.newPage({ viewport: { width: 880, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await bridge(page);
  await page.goto(base);
  await page.getByRole('button', { name: '刷图', exact: true }).click();
  const table = page.getByRole('region', { name: '队伍战斗统计' });
  await table.getByRole('cell', { name: '900', exact: true }).waitFor();
  assert.equal(await table.locator('tbody tr').count(), 6);
  assert.match(await table.locator('tbody tr').last().innerText(), /离开.*—/s);
  assert.match(await table.locator('tbody tr').nth(4).innerText(), /数据不完整/);
  await page.evaluate(() => { window.testRun.combat[0].dps = 1234; window.testRun.dps = 1234; });
  await table.getByRole('cell', { name: '1,234', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (out) { await mkdir(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'grind-combat.png') }); }
  assert.equal(await page.getByText('获得 ×80', { exact: true }).count(), 1);
  assert.equal(await page.getByText('使用 ×7', { exact: true }).count(), 1);
  assert.equal(await page.getByText('待估价', { exact: true }).count(), 6);
  assert.deepEqual(errors, []);
  await page.close();

  const sizes = { compact: [730, 201], standard: [300, 525], detailed: [330, 615], rail: [112, 560], big: [260, 305] };
  for (const [layout, [width, height]] of Object.entries(sizes)) {
    for (const theme of ['dark', 'market', 'cute', 'maple']) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await bridge(page, { layout, theme });
      await page.goto(base + '/overlay.html');
      await page.locator('.ov-team-row.own').waitFor();
      assert.equal(await page.locator('.ov-team-row').count(), 7);
      if (layout === 'detailed' || layout === 'standard') {
        assert.equal(await page.getByText('使用 ×7', { exact: true }).count(), 1);
        assert.equal(await page.getByText('获得 ×80', { exact: true }).count(), 1);
        assert.equal(await page.getByText('剩819', { exact: true }).count(), 0);
      }
      const box = await page.locator('.ov-team').boundingBox();
      assert(box.y + box.height <= height, `${layout}/${theme}: party rows fit vertically`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${layout}/${theme}: no horizontal clipping`);
      if (out && theme === 'maple' && layout === 'standard') await page.screenshot({ path: path.join(out, 'grind-party-overlay.png') });
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log('Grind combat table, live updates and all 20 overlay combinations passed.');
} finally { await browser.close(); server.close(); }
