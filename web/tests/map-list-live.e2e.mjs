// The map list (图鉴 · 地图) against a running market-web with catalogue data:
// DEX_VERIFY_ORIGIN=http://127.0.0.1:18481 PLAYWRIGHT_MODULE=… node web/tests/map-list-live.e2e.mjs
// Expected numbers come from the same server's JSON, so any imported catalogue works.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.DEX_VERIFY_ORIGIN || 'http://127.0.0.1:18481';
const num = (n) => Number(n).toLocaleString('en-US');
const browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    const page = await browser.newPage(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
    await page.addInitScript(() => { localStorage.setItem('uiLang', 'zh'); localStorage.setItem('uiTheme', 'light'); });
    const api = async (url) => (await (await page.request.get(origin + '/api/v1/catalog/page?' + new URLSearchParams({ url }))).json()).page;
    const click = (locator) => (phone ? locator.tap() : locator.click());
    const settle = async () => { await page.waitForTimeout(200); await page.waitForFunction(() => document.querySelector('[data-react-catalogue=search]')?.getAttribute('aria-busy') === 'false'); };
    const tiles = () => page.locator('.mtile').count();
    const all = await api('/search?kind=map');
    assert.equal(all.page_size, 24);
    await page.goto(origin + '/search?kind=map');
    await page.locator('[data-map-browser] .mtile').first().waitFor();
    await settle();

    // Chips with counts, the world map with spots, cards with pictures.
    const chips = await page.locator('.mb-chip[data-region]').allTextContents();
    assert.deepEqual(chips, all.map_regions.map((f) => `${f.names.zh} ${num(f.count)}`));
    assert.equal(await page.locator('.mb-total').textContent(), `共 ${num(all.maps.total)} 张`);
    assert.equal(await tiles(), Math.min(24, all.maps.total));
    assert((await page.locator('.mtile img').count()) > 20, 'cards have pictures');
    const ids = await page.locator('.mtile').evaluateAll((els) => els.map((e) => e.dataset.map));
    assert.equal(new Set(ids).size, ids.length);
    if (phone) {
      assert.equal(await page.locator('.mb-wm').isVisible(), false, 'the world map starts folded');
      await click(page.locator('.mb-fold'));
      assert.equal(await page.locator('.mb-wm').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'no sideways scroll');
    } else {
      assert(await page.locator('.mb-wm').isVisible());
      // The cards scroll in the box, not the page.
      await page.locator('.mb-right').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(() => document.querySelectorAll('.mtile').length > 24);
      assert.equal(await page.evaluate(() => scrollY), 0);
      // Hovering a card on a spot rings that spot.
      const card = page.locator('.mtile[data-spot]').first();
      await card.scrollIntoViewIfNeeded();
      await card.hover();
      await page.waitForSelector('.mb-spot.hl, .mb-info:has-text("（")');
    }
    if (phone) {
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(() => document.querySelectorAll('.mtile').length > 24);
    }

    // A spot narrows the list to its maps; 看全部 brings them back.
    await page.evaluate(() => scrollTo(0, 0));
    let spot = page.locator('.mb-wm .mb-spot[data-kind="0"]').first();
    const key = await spot.getAttribute('data-spot');
    if (phone) {
      // A tap opens the map full screen, where the spots are big enough.
      await click(page.locator('.mb-mapbox .zoomable-pic'));
      await page.locator('.zoom-dialog').waitFor();
      spot = page.locator(`.zoom-dialog .mb-spot[data-spot="${key}"]`);
      await spot.locator('.mb-hit').tap({ force: true });
    } else {
      await spot.locator('.mb-hit').click({ force: true });
    }
    await page.waitForFunction((k) => new URL(location.href).searchParams.get('spot') === k, key); await settle();
    const narrowed = await api('/search?kind=map&spot=' + encodeURIComponent(key));
    assert.equal(await page.locator('.mb-total').textContent(), `共 ${num(narrowed.maps.total)} 张`);
    assert.equal(await page.locator('.zoom-dialog').count(), 0, 'picking a spot closes the full-screen map');
    assert.equal(await page.locator('.mb-spot.on').getAttribute('data-spot'), key);
    assert.match(await page.locator('.mb-route').getAttribute('href'), /^\/route\?to=\d+$/, 'the route goes to the chosen place');
    assert.match(await page.locator('.mb-info').textContent(), /看全部$/);
    await click(page.locator('[data-clear-spot]'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('spot')); await settle();

    // A region chip, then the other island.
    await click(page.locator('.mb-chip[data-region=maple]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('region') === 'maple'); await settle();
    assert.equal(await page.locator('.mb-isl').count(), 0, 'an island chip picks the island');
    assert.equal(await page.locator('.mb-wm image.wm-img').getAttribute('href'), all.world.find((r) => r.id === 'MapleIsland').image_url);
    assert.equal(await page.locator('.mb-total').textContent(), `共 ${num(all.map_regions.find((f) => f.key === 'maple').count)} 张`);
    await click(page.locator('.mb-chip[data-region=rest]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('region') === 'rest'); await settle();
    await click(page.locator('.mb-isl [data-island=maple]'));
    await page.waitForFunction(() => new URL(location.href).searchParams.get('island') === 'maple'); await settle();
    assert.equal(new URL(page.url()).searchParams.get('region'), 'rest', 'the island does not change the chip');

    // Back steps through the choices, then a map and back keeps the list.
    await page.goBack(); await page.waitForFunction(() => new URL(location.href).searchParams.get('region') === 'rest'); await settle();
    await page.goto(origin + '/search?kind=map');
    await page.locator('[data-map-browser] .mtile').first().waitFor(); await settle();
    if (phone) await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    else await page.locator('.mb-right').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('.mtile').length > 24);
    const before = await tiles();
    const far = page.locator('.mtile').nth(before - 2);
    await far.scrollIntoViewIfNeeded();
    const farId = await far.getAttribute('data-map');
    await click(far);
    await page.waitForURL(/\/map\//);
    await page.goBack();
    await page.locator(`.mtile[data-map="${farId}"]`).waitFor();
    assert(await tiles() >= before, 'the loaded cards come back');
    assert(await page.locator(`.mtile[data-map="${farId}"]`).evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }), 'scrolled back to it');

    // Old world map links land here.
    await page.goto(origin + '/world?map=10001000');
    await page.locator('.mb-spot.on').waitFor({ state: 'attached' });
    assert.equal(new URL(page.url()).pathname, '/search');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${tag}: chips, cards, scrolling in the box, hover, spot filter, islands, old /world links`);
  }
} finally {
  await browser.close();
}
