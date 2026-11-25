// The client's 刷图 · 历史 and the site's 我的记录 are one list: same filters and columns.
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
const base = (i, minutes, map, name, kills, segments) => ({
  started_at: now - 3600 * (i + 1), ended_at: now - 3600 * (i + 1) + minutes * 60, active_seconds: minutes * 60,
  character: { name, level: 74, job: 310 }, job_name: '猎人', level: 74, map_name: map, exp: 1000 * minutes,
  exp_per_hour: 60000, net: 100, net_per_hour: 2000, kills, rate_history: [], segments,
});
const runs = [base(0, 3, '破败的坟墓', 'Skyyyy', 36, 1), base(1, 12, '破败的坟墓', 'Skyyyy', 300, 2),
  base(2, 25, '第3军营', 'Other', 900, 1), base(3, 165, '破败的坟墓', 'Skyyyy', 2777, 3)];
const site = runs.map((r, i) => { const { segments, ...rest } = r; return { ...rest, row: i + 1, share_code: i === 3 ? 'abc' : null, segment_count: segments }; });
const client = runs.map((r, i) => ({ ...r, id: `run${i}`, segments: Array.from({ length: r.segments }, () => ({})), share_url: null }));

const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
const type = file => file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: true, public_id: 'me', csrf: 'x', nickname: '测试', stats: {} });
  if (url.pathname === '/api/v1/grind/runs') return json(res, { runs: site });
  if (url.pathname === '/api/v1/grind/live') return json(res, { runs: [] });
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

async function check(page, label) {
  const rows = page.locator('.gh-row:not(.head)');
  await rows.first().waitFor();
  if (process.env.GRIND_SHOTS) await page.screenshot({ path: path.join(process.env.GRIND_SHOTS, label + '.png') });
  assert.equal(await rows.count(), 4, label + ': all runs');
  assert.match(await rows.last().innerText(), /\+2/, label + ': maps a run went through');
  assert.match(await page.locator('.gh-row.head').innerText(), /击杀/, label + ': kills column');
  const length = page.locator('select[aria-label="时长"]');
  await length.selectOption('10');
  assert.equal(await rows.count(), 3, label + ': 10 minutes or more');
  await length.selectOption('20');
  assert.equal(await rows.count(), 2, label + ': 20 minutes or more');
  await page.locator('select[aria-label="角色"]').selectOption('Skyyyy');
  assert.equal(await rows.count(), 1, label + ': one character');
  await page.locator('select[aria-label="角色"]').selectOption('');
}

try {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/grind?lang=zh');
  await check(page, 'site');
  await page.reload();
  await page.locator('.gh-row:not(.head)').first().waitFor();
  assert.equal(await page.locator('.gh-row:not(.head)').count(), 2, 'site: the length filter is remembered');
  await page.evaluate(() => localStorage.removeItem('grind.history.length'));

  const desk = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  desk.on('pageerror', e => errors.push(e.message));
  await desk.addInitScript(runs => {
    const state = { version: '0.8.8', phase: 'idle', mode: 'scan', message: '', capture: 'connected', upload: 'ready', updates: 'up_to_date',
      selected: 12, windows: [{ id: 12, title: 'MapleStory', pid: 42 }], theme: 'light', language: 'zh', activities: [], maximized: false };
    const live = () => ({ alive_at: Date.now() / 1000, stale: false, runs: [], finished: [], calibration: [], characters: [] });
    const settings = { buff_warn_seconds: 3, buff_sound: false, hotkeys: {}, overlay: { enabled: false, fields: [] } };
    window.pywebview = { api: { ready: async () => state, command: async () => true, workspace: async () => ({ linked: false }),
      grind: async action => action === 'history' ? runs : ({ live: live(), settings, editing: false, calibrating: false, calibration: null }),
      state: async () => ({ live: live(), settings, editing: false, language: 'zh', update: null }) } };
  }, client);
  await desk.goto(origin + '/desk/');
  await desk.getByRole('button', { name: '刷图' }).first().click();
  await desk.getByRole('button', { name: '历史' }).first().click();
  await check(desk, 'client');
  assert.deepEqual(errors, []);
  console.log('grind history: site and client agree');
} finally {
  await browser.close();
  server.close();
}
