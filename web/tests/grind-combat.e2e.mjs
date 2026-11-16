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
async function bridge(page, overlay = null, characters = []) {
  await page.addInitScript(({ run, settings, overlay, characters }) => {
    window.testRun = run;
    if (overlay) Object.assign(settings.overlay, overlay);
    const live = () => ({ alive_at: Date.now() / 1000, stale: false, runs: [structuredClone(window.testRun)], finished: [], calibration: [], characters: characters.map(c => ({ ...c, drops: c.drops.map(d => ({ ...d, t: Date.now() / 1000 - d.age, gone: d.age_gone == null ? undefined : Date.now() / 1000 - d.age_gone })) })) });
    const state = { version: '0.7.15', phase: 'idle', mode: 'scan', message: '', room: null, channel: null, visited: 0,
      uploaded: 0, capture: 'connected', upload: 'ready', updates: 'up_to_date', selected: 12,
      windows: [{ id: 12, title: 'MapleStory', pid: 42 }], theme: 'light', language: 'zh', activities: [], maximized: false };
    window.pywebview = { api: { ready: async () => state, command: async () => state,
      workspace: async () => ({ linked: false }),
      grind: async () => ({ live: live(), settings, editing: false, calibrating: false, calibration: null }),
      state: async () => ({ live: live(), settings, editing: false, language: 'zh', update: window.testUpdate ?? null }),
      update: async () => { window.updated = true; return true; },
      command: async action => { (window.commands ||= []).push(action); return true; },
    } };
  }, { run, settings, overlay, characters });
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
      assert.equal(await page.locator('.rate-chart path[d^="M"]').count(), 2);
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
  // The everyday preset: EXP, level and profit stacked, each with its run total; one line each for consumables and loot.
  for (const theme of ['dark', 'market', 'cute', 'maple']) {
    const page = await browser.newPage({ viewport: { width: 296, height: 520 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await bridge(page, { layout: 'slim', theme, fields: ['time', 'exp_rate', 'profit', 'level', 'buffs', 'potions', 'recent'] });
    await page.goto(base + '/overlay.html');
    await page.locator('.ov-stat').first().waitFor();
    assert.equal(await page.locator('.ov-slim .ov-sec > .ov-stat').count(), 2);
    assert.deepEqual(await page.locator('.ov-total').allInnerTexts(), ['经验 +1万', '净收益 +1.2万']);
    assert.equal(await page.locator('.ov-tally').count(), 2);
    assert.deepEqual(await page.locator('.ov-tally .ov-sign').allInnerTexts(), ['+', '−'], 'loot is a plus row, consumables a minus row');
    assert.deepEqual(await page.locator('.ov-tally > b').allInnerTexts(), ['+2000', '−5000'], 'loot counts items only (mesos have their own figure)');
    for (const row of await page.locator('.ov-tally').all()) assert((await row.boundingBox()).height < 34, `slim/${theme}: consumables and loot keep to one line each`);
    assert.equal(await page.locator('.ov-team').count(), 0);
    assert.equal(await page.locator('.rate-chart').count(), 0);
    assert.equal(await page.locator('.ov-buffs.tiles span').count(), 3);
    const height = (await page.locator('.ov').boundingBox()).height;
    assert(height < 480, `slim/${theme}: the card stays small (${height})`);
    if (out) await page.screenshot({ path: path.join(out, `grind-slim-${theme}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `slim/${theme}: no horizontal clipping`);
    assert.equal(await page.locator('.ov-grip').count(), 0, 'no corner grip: the size is picked in settings');
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Valuable drops sit between the rates and the buffs: on the ground and for how long, who picked each up, or that nobody did.
  {
    const page = await browser.newPage({ viewport: { width: 296, height: 620 } });
    const drops = [
      { age: 95, object: 1, item_id: 1302004, name: '九龙刀', value: 240000, by: 'party', by_name: 'SHadowFiend' },
      { age: 40, age_gone: 5, object: 2, item_id: 2040001, name: '头盔命中率卷轴：中级', value: 10000, by: 'me', how: 'pet', taker: 'me', taker_name: 'Me' },
      { age: 130, age_gone: 3, object: 3, item_id: 1442007, name: '#1442007', value: null, by: 'party', how: 'expired' },
      { age: 20, age_gone: 2, object: 4, item_id: 1041076, name: '红色侠客衣', value: 5000, by: 'party', by_name: 'Pig', how: 'picked', taker: 'party', taker_name: 'Pig' },
      { age: 10, age_gone: 1, object: 5, item_id: 1041077, name: '不显示', value: 1, how: 'gone' },
    ];
    await bridge(page, { layout: 'slim', theme: 'dark', fields: ['time', 'exp_rate', 'profit', 'level', 'buffs', 'potions', 'recent'] }, [{ name: 'Me', level: 70, job: 230, map_id: 1, buffs: [], drops }]);
    await page.addInitScript(() => { window.testUpdate = { state: 'ready_to_update', version: '0.7.99' }; });
    await page.goto(base + '/overlay.html');
    await page.locator('.ov-ground-row').first().waitFor();
    // A client update ready: offered on the site line at the bottom.
    assert.equal(await page.locator('.ov-foot .ov-update').innerText(), '更新到 v0.7.99');
    await page.locator('.ov-foot .ov-update').click();
    assert.equal(await page.evaluate(() => window.updated), true);
    assert.equal(await page.locator('.ov-foot .ov-updating').innerText(), '正在更新…');
    const rows = (await page.locator('.ov-ground-row > b').allInnerTexts()).map(t => t.replace(/\d+秒/, 'N秒'));
    assert.deepEqual(rows, ['✓ Pig捡了', '✓ 你的宠物捡了', '地上 N秒', '没人捡，消失了']);
    assert.equal(await page.locator('.ov-ground-row > b.warn').count(), 2, 'over 90 s on the ground and expired are red');
    const ground = await page.locator('.ov-ground').boundingBox(), stat = await page.locator('.ov-slim .ov-sec > .ov-stat').last().boundingBox();
    assert(ground.y > stat.y, 'drops come after the rates');
    assert.equal(await page.locator('.ov-tally').count(), 2, 'consumables and loot right after the rates');
    assert.equal(await page.locator('.ov-slim > .ov-sec').count(), 3, 'three sections: EXP, profit and drops, buffs');
    assert((await page.locator('.ov-tally').last().boundingBox()).y < ground.y, 'consumables and loot above the drops');
    // Recording status in the header; pause and end at the bottom (end asks for a second click).
    assert.equal(await page.locator('.ov-head .ov-rec.on').innerText(), '记录中');
    assert.deepEqual(await page.locator('.ov-controls button').allInnerTexts(), ['暂停', '结束']);
    await page.locator('.ov-controls button').first().click();
    await page.locator('.ov-controls button.end').click();
    assert.equal(await page.locator('.ov-controls button.end').innerText(), '再点一次结束');
    assert.deepEqual(await page.evaluate(() => window.commands), ['toggle'], 'one click on end does nothing yet');
    await page.locator('.ov-controls button.end').click();
    assert.deepEqual(await page.evaluate(() => window.commands), ['toggle', 'end']);
    await page.mouse.move(0, 0); await page.waitForTimeout(300);
    if (out) await page.screenshot({ path: path.join(out, 'grind-slim-drops.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'drops: no horizontal clipping');
    await page.close();
  }
  // Spoken buff warnings, each twice (again 10 s later unless cast again): a skill 3 s before
  // it ends; an item buff (龙血) 1 s after the server ends it, since the game asks to confirm one used while still on.
  {
    const page = await browser.newPage({ viewport: { width: 296, height: 620 } });
    await page.addInitScript(({ run, settings }) => {
      const t0 = Date.now() / 1000;
      window.said = [];
      window.Audio = class { constructor(src) { this.src = src; } play() { window.said.push([Math.round(Date.now() / 1000 - t0), this.src]); setTimeout(() => this.onended?.(), 10); return Promise.resolve(); } };
      const ends = { 3001000: t0 + 6, '-2012000': t0 + 2, 3101004: t0 + 5 };
      const live = () => {
        const now = Date.now() / 1000;
        if (now > t0 + 4) ends[3101004] = t0 + 200;   // cast again after its first warning
        const buffs = [{ source: 3001000, name: '集中术', item_id: null, total: 120 }, { source: -2012000, name: '龙血', item_id: 2012000, total: 180 },
          { source: 3101004, name: '无形箭', item_id: null, total: 200 }, { source: 3100001, name: '终极弓', item_id: null, total: 60, proc: true, on: t0 }]
          .map(b => ({ ...b, seconds: b.proc ? Math.max(0.1, t0 + 4 - now) : Math.round((ends[b.source] - now) * 10) / 10 }))
          // 龙血 is nominally over at 2 s; the server ends it at 4 s (0-7 s late in recordings): "ending" until then.
          .map(b => b.source === -2012000 && b.seconds <= 0 && now < t0 + 4 ? { ...b, seconds: 0, ending: true } : b)
          // Then it is over: kept as a pinned row at 0 (greyed), which must not read as ending.
          .map(b => b.source === -2012000 && b.seconds <= 0 && !b.ending ? { ...b, seconds: 0, pinned: true } : b)
          .filter(b => b.seconds > 0 || b.ending || b.pinned);
        // A pet that is out and hungry: "宠物饿了，请喂食" twice, 10 s apart; one is out, so no "宠物没出来".
        const pets = [{ serial: 'a1', item_id: 5000007, name: 'Black Pig', level: 9, fullness: 15, out: true, hungry: true },
          { serial: 'b2', item_id: 5000033, name: 'Snail', level: 1, fullness: 5, out: false, hungry: false }];
        return { alive_at: now, stale: false, runs: [{ ...structuredClone(run), in_combat: true, buffs, pets }], finished: [], calibration: [], characters: [] };
      };
      const shown = { ...settings, buff_sound: true, buff_warn_seconds: 3, overlay: { ...settings.overlay, layout: 'slim', fields: ['buffs'] } };
      // A late state write across 龙血's nominal end: the page counts it down to 0 itself and
      // must keep it as ending, not announce it then and again at the real end (速度药水 twice).
      let frozen = null;
      const state = () => {
        const now = Date.now() / 1000;
        if (frozen && now >= t0 + 2 && now < t0 + 3.6) return frozen;
        const s = { live: live(), settings: shown, editing: false, language: 'zh' };
        if (now < t0 + 2) frozen = s;
        return s;
      };
      window.pywebview = { api: { state: async () => state(), fit: async () => 0, scale: async v => v } };
    }, { run, settings });
    await page.goto(base + '/overlay.html');
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('.ov-buffs .ending b').innerText(), '将结束', 'an item buff past its time but not ended by the server');
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('.ov-buffs .ending').count(), 0, 'a pinned item buff that ran out is not shown as ending');
    await page.waitForTimeout(13000);
    const said = await page.evaluate(() => window.said.filter(([, src]) => !src.includes('drop_alert')));
    const at = name => said.filter(([, src]) => src.includes(name)).map(([t]) => t);
    assert.deepEqual(at('/3001000.mp3'), [3, 13], `a skill: 3 s before it ends, again 10 s later (${JSON.stringify(said)})`);
    const item = at('/-2012000.mp3');
    assert(item.length === 2 && item[0] >= 5 && item[1] - item[0] >= 10, `an item buff: 1 s after the server ends it, again 10 s later (${JSON.stringify(said)})`);
    assert.deepEqual(at('/3101004.mp3'), [2], `cast again after the first warning: not said again (${JSON.stringify(said)})`);
    assert.deepEqual(at('/3100001.mp3'), [], `a Final Attack is never warned (${JSON.stringify(said)})`);
    const hungry = at('/pet_hungry.mp3');
    assert(hungry.length === 2 && hungry[1] - hungry[0] >= 10, `a hungry pet: said twice, 10 s apart (${JSON.stringify(said)})`);
    assert.deepEqual(at('/pet_away.mp3'), [], `a pet is out: no summon reminder (${JSON.stringify(said)})`);
    assert.equal(await page.locator('.ov-buffs .pet').count(), 2, 'both pets in the buff row');
    assert.equal(await page.locator('.ov-buffs .pet.off b').innerText(), '背包', 'the pet in the bag says so');
    if (out) await page.locator('.ov-buffs').screenshot({ path: path.join(out, 'grind-pets.png') });
    await page.close();
  }
  console.log('Grind combat table, live updates, all 20 overlay combinations, the slim preset and its drop list, and the buff warning timing passed.');
} finally { await browser.close(); server.close(); }
