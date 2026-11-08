// Read-only regression against real legacy captures and the built site.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.CRITICAL_TEST_ORIGIN || 'http://127.0.0.1:18767';
const browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const request = await browser.newPage();
  for (const [id, key, label, en] of [
    [1082000, 'critical_rate', '暴击率', 'Critical Rate'],
    [1032007, 'critical_damage', '暴击伤害', 'Critical Damage'],
  ]) {
    const api = await request.request.get(`${origin}/api/v1/item/${id}`);
    assert.equal(api.status(), 200);
    const rows = (await api.json()).listings;
    assert(rows.some(row => row.equipment?.stats?.some(stat => stat.key === key && stat.value === 2)), key);
    assert(rows.every(row => !row.equipment?.unknown_fields?.some(field => field.bit === (id === 1082000 ? 14 : 15))), 'legacy critical field is named');
    const filteredUrl = `/item/${id}?hours=all&attributes=${encodeURIComponent(JSON.stringify([[key, 2]]))}`;
    const filtered = await request.request.get(`${origin}/api/v1/catalog/page?url=${encodeURIComponent(filteredUrl)}`);
    assert.equal(filtered.status(), 200);
    const selected = (await filtered.json()).page;
    assert(selected.market.listings.length);
    assert(selected.market.listings.every(row => row.variant.stats.some(stat => stat.key === key && stat.value >= 2)));
    for (const width of [375, 1280]) for (const lang of ['zh', 'en']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 640, hasTouch: width < 640 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/item/${id}?hours=all&lang=${lang}`);
      await page.locator('[data-equipment-group]').first().waitFor({ state: 'attached' });
      const text = await page.locator('.item-stall').innerText();
      assert(text.includes(lang === 'zh' ? label : en), `${id} ${width}px ${lang} displays ${key}`);
      await page.locator('[data-offer-filter-open]').click();
      await page.locator('[data-stat-add]').click();
      await page.locator('[data-stat-key]').last().selectOption(key);
      assert.equal(await page.locator('[data-stat-key]').last().inputValue(), key);
      await page.keyboard.press('Escape');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`PASS ${id}: legacy ${key} API, server filters, phone/desktop Chinese/English display and filter option`);
  }
  await request.close();
} finally { await browser.close(); }
