// 刷图 设置 on the site: the account's shared settings (account_data pref grind.settings),
// which its clients take (grind_settings_sync.py). Only the shared choices are offered; a
// change keeps the others; 绩效模式 from the account shows 积分 on the account's own runs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Date.now() / 1000;
const run = { started_at: now - 3600, ended_at: now, active_seconds: 3600, map_id: 10006161, character: { name: 'Sky', level: 74, job: 310 },
  job_name: '猎人', level: 74, map_name: '破败的坟墓', exp: 100000, exp_per_hour: 100000, net: 50000, net_per_hour: 50000, mesos: 50000,
  item_value: 0, basic_value: 0, consume_cost: 0, kills: 300, rate_history: [], segments: [] };
let record = { kind: 'pref', key: 'grind.settings', value: JSON.stringify({ performance: { enabled: true, exp_per_10k: 0.8 }, future: { a: 1 } }), version: 1 };
const writes = [];

const json = (res, data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const type = file => file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: true, public_id: 'me', csrf: 'x', nickname: '测试', stats: {} });
  if (url.pathname === '/api/v1/account/data') {
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { operations } = JSON.parse(body);
      for (const op of operations) {
        if (op.key !== 'grind.settings') continue;
        if (op.version !== record.version) return json(res, { error: 'sync_conflict' }, 409);
        writes.push(JSON.parse(op.value));
        record = { ...record, value: op.value, version: record.version + 1 };
      }
    }
    return json(res, { records: [record] });
  }
  if (url.pathname === '/api/v1/grind/runs') return json(res, { runs: [{ ...run, row: 1, share_code: null, segment_count: 1 }] });
  if (url.pathname === '/api/v1/grind/runs/1') return json(res, { row: 1, run, share_code: null, comparison: null });
  if (url.pathname === '/api/v1/grind/live') return json(res, { runs: [] });
  if (url.pathname.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ok\n\n'); return; }
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const rel = url.pathname.startsWith('/web/') ? url.pathname.slice(5) : 'index.html';
  const file = path.resolve(web, rel);
  if (!file.startsWith(web)) { res.writeHead(404); return res.end(); }
  try { res.setHeader('Content-Type', type(file)); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });

try {
  const errors = [];
  for (const [label, viewport] of [['desktop', { width: 1100, height: 900 }], ['phone', { width: 375, height: 812 }]]) {
    const page = await browser.newPage({ viewport, ...(label === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/grind?tab=settings&lang=zh');
    const view = page.locator('.grind-site-settings');
    await view.waitFor();
    // The account's choice, not the default.
    const on = view.getByLabel('开启绩效模式（净收益下方显示积分）');
    await page.waitForFunction(() => document.querySelector('.grind-site-settings input[type=checkbox]:checked'));
    assert.equal(await on.isChecked(), true, `${label}: 绩效模式 from the account`);
    const exp = view.locator('label.grind-field', { hasText: '每万经验积分' }).locator('input');
    assert.equal(await exp.inputValue(), '0.8', `${label}: the account's rate`);
    // Only the shared choices.
    for (const text of ['显示悬浮窗', '鼠标穿透', '开启刷图记录', '协议标定', '暂停 / 继续'])
      assert.equal(await view.getByText(text, { exact: false }).count(), 0, `${label}: no "${text}" (stays on each PC)`);
    if (label === 'phone') {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'phone: no sideways scroll');
      assert.equal(await exp.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 16, 'phone: 16px inputs');
      await page.close();
      continue;
    }
    // A change keeps every other choice, including ones this page does not know.
    const income = view.locator('label.grind-field', { hasText: '每万收益积分' }).locator('input');
    await income.fill('2');
    await income.blur();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !writes.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(writes.at(-1), { performance: { enabled: true, exp_per_10k: 0.8, income_per_10k: 2 }, future: { a: 1 } });
    await view.getByRole('radio', { name: '可爱' }).click();
    for (let i = 0; i < 50 && writes.length < 2; i++) await page.waitForTimeout(100);
    assert.equal(writes.at(-1).overlay.theme, 'cute');
    assert.equal(writes.at(-1).performance.income_per_10k, 2);
    // 积分 on the account's own run.
    await page.goto(origin + '/grind/run/1?lang=zh');
    await page.locator('.gr-kpis').getByText('积分').waitFor();
    await page.locator('.gr-points').waitFor();
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('grind settings: account settings on the site, shared choices only, kept on change, points on own runs, phone layout');
} finally {
  await browser.close();
  server.close();
}
