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
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
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
  net_per_hour_1m: -1200, rate_history: [{ t: 0, exp: 100, net: -1200 }, { t: 10, exp: 300, net: 500 }],
  exp_percent: 25, percent_per_hour: 20, eta_seconds: 3600, net: 12000, net_per_hour: 360000,
  mesos: 15000, item_value: 2000, consume_cost: 5000, mesos_spent: 0,
  kills: 24, kills_per_hour: 720, kills_estimated: false, deaths: 0, gaps: 0, pending_prices: 0,
  dps: 900, damage: 108000, average_dps: 850, party_known: true,
  attack_count: 40, attacks: [], casts: [], hp_drops: 0, hp_lost: 0, consumables: [], buffs: [{ source: 3001000, name: '集中术', seconds: 90, total: 90, item_id: null }, { source: 1101004, name: '愤怒之火', seconds: 300, total: 300, item_id: null }, { source: 4101001, name: '轻功', seconds: 300, total: 300, item_id: null }], mobs: [{ mob_id: 67, name: '骷髅士兵', kills: 18, attack_samples: 4, attack_distribution: [{ attacks: 1, kills: 1 }, { attacks: 2, kills: 3 }] }, { mob_id: 68, name: '骷髅士官', kills: 6 }], recent: [], drops: [],
  loot: Array.from({ length: 6 }, (_, i) => ({ t: 1, item_id: 4000000 + i, name: `战利品${i}`, quantity: 80 - i, value: 0, priced: false })),
  consumables: Array.from({ length: 7 }, (_, i) => ({ item_id: 2000000 + i, name: i === 5 ? '攻击神水' : `药品${i}`, used: 7 + i, cost: 350 + i, remaining: 819, minutes_left: 443 })),
  combat: Array.from({ length: 6 }, (_, i) => ({ character_id: i + 1, name: i ? `Teammate${i}` : 'Tester', self: !i,
    away: i === 5, partial: i === 4, damage: i === 5 ? null : 108000 - i * 10000,
    dps_5m: i >= 4 ? null : 900 - i * 100, kills_5m: 24 - i, exp_received_5m: i ? null : 10000, kill_exp_5m: (24-i)*183, exp_contribution_5m: 20, exp_yield_5m: i ? null : 120, dps: i >= 4 ? null : 900 - i * 100, average_dps: 850 - i * 100, kills: 24 - i, hits: 40 })),
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
  assert((await table.boundingBox()).height > 150, 'combat region must not shrink away');
  await page.locator('.grind-attack-distribution summary').click();
  assert.match(await page.locator('.grind-attack-distribution').innerText(), /25.0%.*75.0%/s);

  assert.match(await table.locator('tbody tr').last().innerText(), /离开.*—/s);
  assert.equal(await table.locator('tbody tr').nth(4).locator('td').first().getAttribute('title'), '数据不完整');
  await page.evaluate(() => { window.testRun.combat[0].dps = 1234; window.testRun.combat[0].dps_5m = 1234; window.testRun.dps = 1234; });
  await table.getByRole('cell', { name: '1234', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (out) { await mkdir(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'grind-combat.png') }); }
  assert.equal(await page.getByText('×80', { exact: true }).count(), 1);
  assert.equal(await page.getByText('×7', { exact: true }).count(), 1);
  assert.equal(await page.getByText('待估价', { exact: true }).count(), 6);
  assert.deepEqual(errors, []);
  await page.close();

  const sizes = { compact: [730, 445], standard: [330, 900], detailed: [360, 1045], rail: [140, 850], big: [290, 640] };
  for (const [layout, [width, height]] of Object.entries(sizes)) {
    for (const theme of ['dark', 'market', 'cute', 'maple']) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await bridge(page, { layout, theme });
      await page.goto(base + '/overlay.html');
      await page.locator('.ov-team-row.own').waitFor();
      assert.equal(await page.locator('.ov-team-row').count(), 6);
      assert.equal(await page.locator('.ov-site').count(), 1);
      assert(await page.locator('.ov-site').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 12));
      if (layout === 'standard' || layout === 'detailed') {
        const site = await page.locator('.ov-head .ov-site').boundingBox();
        const timer = await page.locator('.ov-head em').boundingBox();
        const header = await page.locator('.ov-head').boundingBox();
        assert(site.y >= header.y && site.y + site.height <= timer.y, 'website stays inside title bar above timer');
      }
      if (out && theme === 'market' && layout === 'detailed') await page.screenshot({ path: path.join(out, 'grind-title-market.png') });
      if (layout === 'detailed' || layout === 'standard') {
        assert.equal(await page.getByText('×7', { exact: true }).count(), 1);
        assert.equal(await page.locator('.ov-account').first().locator('.ov-account-row').count(), 7);
        await page.getByText('攻击神水', { exact: true }).waitFor();
        assert.equal(await page.getByText('×80', { exact: true }).count(), 1);
        assert.equal(await page.getByText('剩819', { exact: true }).count(), 0);
        await page.waitForFunction(() => [...document.querySelectorAll('.ov-mobs img')].every(img => img.complete && img.naturalWidth > 0));
        assert(await page.locator('.ov-mobs').evaluate(el => !!(el.compareDocumentPosition(document.querySelector('.ov-buffs')) & Node.DOCUMENT_POSITION_FOLLOWING)));
        assert.equal(await page.locator('.ov-mesos').count(), 1);
        assert(await page.locator('.ov-accounts').evaluate(el => el.previousElementSibling?.getAttribute('aria-label') === '金币净收益'));
        assert.equal(await page.locator('.ov-account-heading .amount').count(), 2);
        assert.match(await page.locator('.ov-account-heading .amount').first().innerText(), /−/);
        assert.match(await page.locator('.ov-account-heading .amount').last().innerText(), /\+/);
        const iconLefts = await page.evaluate(() => ['.ov-mobs img', '.ov-buffs img', '.ov-account-row>span>img'].map(selector => document.querySelector(selector).getBoundingClientRect().left));
        assert(Math.max(...iconLefts) - Math.min(...iconLefts) <= 1.1, 'all section icons share the same left edge');


      }
      await page.waitForFunction(() => [...document.querySelectorAll('.mesos-icon')].every(img => img.complete && img.naturalWidth > 0));
      assert.equal(await page.locator('.rate-chart polyline').count(), 2);
      await page.locator('.rate-chart').first().hover();
      await page.locator('.rate-tooltip').first().waitFor();
      assert.match(await page.locator('.rate-tooltip').first().innerText(), /\/h/);
      await page.mouse.move(0, 0);

      assert.equal(await page.locator('.ov-buffs img[src*="/skills/3001000.png"]').count(), 1);
      await page.waitForFunction(() => [...document.querySelectorAll('.ov-buffs img')].every(img => img.complete && img.naturalWidth > 0));
      assert.deepEqual(await page.locator('.rate-metrics').first().locator('.rate-values small').allTextContents(), ['平均/时', '实时/时', '累计']);
      await page.locator('.ov-team').scrollIntoViewIfNeeded();
      const box = await page.locator('.ov-team').boundingBox();
      assert(box.y + box.height <= height + 1, `${layout}/${theme}: party rows fit vertically (${box.y}+${box.height} <= ${height})`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${layout}/${theme}: no horizontal clipping`);
      if (out && theme === 'maple' && layout === 'standard') await page.screenshot({ path: path.join(out, 'grind-party-overlay.png') });
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  // The leveling preset: one line per metric, a small card, and a corner to size it by.
  for (const theme of ['dark', 'market', 'cute', 'maple']) {
    const page = await browser.newPage({ viewport: { width: 260, height: 300 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await bridge(page, { layout: 'slim', theme, fields: ['time', 'exp_rate', 'level', 'dps', 'buffs'] });
    await page.goto(base + '/overlay.html');
    await page.locator('.rate-line').waitFor();
    assert.equal(await page.locator('.rate-line').count(), 1);
    assert.equal(await page.locator('.rate-chart').count(), 0);
    assert.equal(await page.locator('.ov-buffs.icons span').count(), 3);
    assert((await page.locator('.ov').boundingBox()).height < 180, `slim/${theme}: the card stays small`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `slim/${theme}: no horizontal clipping`);
    assert.equal(await page.locator('.ov-grip').count(), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Grind combat table, live updates, all 20 overlay combinations and the slim preset passed.');
} finally { await browser.close(); server.close(); }
