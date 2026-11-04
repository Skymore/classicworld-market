// The 图鉴 filter bar against a running market-web with catalogue data:
// DEX_VERIFY_ORIGIN=http://127.0.0.1:18481 PLAYWRIGHT_MODULE=… node web/tests/dex-filters-live.e2e.mjs
// Expected numbers come from the same server's JSON, so any imported catalogue works.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.DEX_VERIFY_ORIGIN || 'http://127.0.0.1:18481', shots = process.env.DEX_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const num = (n) => Number(n).toLocaleString('en-US');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    const page = await browser.newPage(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('theme', 'light'); });
    const api = async (url) => (await (await page.request.get(origin + '/api/v1/catalog/page?' + new URLSearchParams({ url }))).json()).page;
    const click = (locator) => (phone ? locator.tap() : locator.click());
    const shot = async (name) => { if (!phone) await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur?.()); await page.waitForTimeout(300); if (shots) await page.screenshot({ path: path.join(shots, `${name}-${tag}.png`) }); };
    const params = () => new URL(page.url()).searchParams;
    // React renders the new URL a moment after the address bar changes; then the fetch runs.
    const settle = async () => { await page.waitForTimeout(200); await page.waitForFunction(() => document.querySelector('[data-react-catalogue=search]')?.getAttribute('aria-busy') === 'false'); };
    const open = async (url) => { await page.goto(origin + url); await page.locator('[data-react-catalogue=search] [data-search-results]').waitFor(); await settle(); };
    const total = () => page.locator('[data-total]').textContent();
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    // Default items: counts on every category, the total and one pager at the bottom.
    await open('/search?kind=item');
    const all = await api('/search?kind=item');
    for (const facet of all.facets.categories) {
      assert.equal(await page.locator(`[data-cat=${facet.key || 'all'}] small`).textContent(), num(facet.count), facet.key);
    }
    const pages = Math.ceil(all.items.total / all.page_size);
    assert.equal(await total(), `共 ${num(all.items.total)} 件 · 第 1/${pages} 页`);
    assert.equal(await page.locator('[data-pager]').count(), 1, 'numbered pages at the bottom only');
    const [grid, pager] = await Promise.all(['[data-search-results]', '[data-pager]'].map((s) => page.locator(s).boundingBox()));
    assert(pager.y >= grid.y + grid.height - 1);
    assert.equal(await page.locator('[data-active-filters]').count(), 0);
    assert(await noOverflow(), 'no horizontal overflow');
    if (phone) {
      const [find, filter, cats, tabs] = await Promise.all(['#catalog-search', '[data-filter-btn]', '[data-cats]', '.dex-kinds'].map((s) => page.locator(s).boundingBox()));
      assert(Math.abs(find.y - filter.y) < 8, 'sort and filter sit beside the search box');
      assert(cats.width >= tabs.width - 1, 'categories get the full width');
    }
    await shot('search-item');
    await click(page.locator('[data-page="2"]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === '2'); await settle();
    assert.match(await total(), new RegExp(`第 2/${pages} 页`));

    // Old links: job=1 and min_level map to the new filters; the bar shows the
    // server's category (装备), not the URL's (消耗).
    await open('/search?kind=item&cat=use&job=1&min_level=30&max_level=40');
    assert.equal(await page.locator('[data-cat=equip]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-cat=use]').getAttribute('aria-pressed'), 'false');
    const tokens = page.locator('[data-active-filters] .tok');
    assert.deepEqual(await tokens.allTextContents(), ['职业 战士 ×', '等级 30–40 ×']);
    assert.equal(await page.locator('[data-filter-btn] .fcount').textContent(), '2');
    const warrior = await api('/search?kind=item&job=warrior&lmin=30&lmax=40');
    assert.equal(warrior.filters.cat, 'equip');
    assert.match(await total(), new RegExp(`^共 ${num(warrior.items.total)} 件`));
    await shot('search-item-warrior-30-40');
    await click(page.locator('[data-remove-filter=job]'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('job')); await settle();
    assert.equal(params().get('lmin'), '30', 'the other filter stays');
    assert.equal(params().get('cat'), 'equip', 'the shown category stays');
    await click(page.locator('[data-clear-filters]'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('lmin')); await settle();
    assert.equal(await page.locator('[data-active-filters]').count(), 0);

    // Sort by level, high to low.
    await open('/search?kind=item&cat=equip');
    await click(page.locator('[data-sort-btn]')); await click(page.locator('[data-sort=level_desc]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('sort') === 'level_desc'); await settle();
    assert.equal(await page.locator('[data-sort-label]').textContent(), '等级从高到低');
    const levels = (await page.locator('[data-search-results] .lv').allTextContents()).map((t) => Number(t.replace(/\D/g, '')));
    assert(levels.length > 2 && levels.every((n, i) => !i || n <= levels[i - 1]), 'levels descend');

    // The filter sheet: chips change the URL, the footer shows the live total.
    await open('/search?kind=item');
    await click(page.locator('[data-filter-btn]'));
    const dialog = page.locator('.dex-filter-dialog');
    await click(dialog.locator('[data-job=warrior]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('job') === 'warrior');
    await click(dialog.locator('[data-lv="30-40"]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('lmax') === '40');
    await page.waitForFunction((text) => document.querySelector('[data-apply]')?.textContent === text, `显示 ${num(warrior.items.total)} 件`);
    assert.equal(await dialog.locator('[data-shared]').isChecked(), true, 'all-class gear is included by default');
    for (const type of warrior.facets.types) assert.match(await dialog.locator(`[data-equipment-type=${type.key}]`).textContent(), new RegExp(num(type.count)));
    if (phone) {
      const box = await dialog.boundingBox();
      assert(Math.abs(box.y + box.height - 844) < 2, 'a bottom sheet on phones');
      await shot('search-item-sheet');
    }
    await click(dialog.locator('[data-equipment-type=weapon]'));
    await dialog.locator('[data-weapon]').first().waitFor();
    await click(dialog.locator('[data-shared]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('shared') === '0'); await settle();
    const own = await api('/search?kind=item&job=warrior&lmin=30&lmax=40&type=weapon&shared=0');
    await page.waitForFunction((text) => document.querySelector('[data-apply]')?.textContent === text, `显示 ${num(own.items.total)} 件`);
    await click(dialog.locator('[data-apply]'));
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-cat=equip]').getAttribute('aria-pressed'), 'true', 'equipment filters select 装备');
    await click(page.locator('[data-cat=use]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('cat') === 'use'); await settle();
    assert.equal(params().get('job'), null, 'another category drops the equipment filters');
    await click(page.locator('[data-filter-btn]'));
    assert.equal(await dialog.locator('[data-job]').count(), 0);
    await click(dialog.locator('[data-use=potion]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('use') === 'potion');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });

    // Monsters: level range and bosses.
    await open('/search?kind=mob');
    assert.equal(await page.locator('[data-cats]').count(), 0);
    await click(page.locator('[data-filter-btn]'));
    await click(dialog.locator('[data-lv="1-10"]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('lmax') === '10'); await settle();
    const low = await api('/search?kind=mob&lmin=1&lmax=10');
    await page.waitForFunction((text) => document.querySelector('[data-apply]')?.textContent === text, `显示 ${num(low.mobs.total)} 只`);
    await click(dialog.locator('[data-apply]')); await dialog.waitFor({ state: 'detached' });
    const mobLevels = (await page.locator('[data-search-results] .lv').allTextContents()).map((t) => Number(t.replace(/\D/g, '')));
    assert(mobLevels.length && mobLevels.every((n) => n >= 1 && n <= 10));
    assert.equal(await page.locator('[data-remove-filter=level]').textContent(), '等级 1–10 ×');
    await shot('search-mob-level');
    await click(page.locator('[data-filter-btn]'));
    await click(dialog.locator('[data-boss]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('boss') === '1'); await settle();
    const bosses = await api('/search?kind=mob&lmin=1&lmax=10&boss=1');
    await page.waitForFunction((text) => document.querySelector('[data-apply]')?.textContent === text, `显示 ${num(bosses.mobs.total)} 只`);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });

    // Maps: the region and towns are chips over the world map, not a sheet.
    await open('/search?kind=map');
    assert.equal(await page.locator('[data-sort-btn], [data-filter-btn]').count(), 0, 'maps have no sort or sheet');
    await click(page.locator('[data-town]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('town') === '1'); await settle();
    const towns = await api('/search?kind=map&town=1');
    assert.match(await total(), new RegExp(`^共 ${num(towns.maps.total)} 张`));
    assert.equal(await page.locator('[data-town].on').count(), 1);
    await shot('search-map-town');

    // A typed query without a kind: three groups, no filter bar; tabs keep the query.
    await open('/search?q=' + encodeURIComponent('蜗牛'));
    assert.equal(await page.locator('[data-cats], [data-filter-btn], [data-sort-btn]').count(), 0);
    assert.equal(await page.locator('#search-item, #search-mob, #search-map').count(), 3);
    await click(page.locator('[data-kind=mob]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('kind') === 'mob'); await settle();
    assert.equal(params().get('q'), '蜗牛');
    assert.equal(await page.locator('[data-filter-btn]').count(), 1, 'a kind brings the filters back');
    assert(await noOverflow());
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${tag}: counts, normalized category, old links, tokens, sort, sheet total, monster level/boss, map towns, mixed search`);
  }
} finally {
  await browser.close();
}
