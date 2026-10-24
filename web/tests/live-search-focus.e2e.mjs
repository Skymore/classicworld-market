// Verify focus calls directly: a desktop browser does not render iOS pickers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let requests = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/web/')) {
    const file = path.resolve(root, '.' + url.pathname.slice(4));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try { res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(file)); }
    catch { res.writeHead(404); return res.end(); }
  }
  if (url.pathname !== '/search') { res.writeHead(404); return res.end(); }
  requests++;
  const region = url.searchParams.get('region') || '', area = url.searchParams.get('area') || '';
  const option = (value, title, selected) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${title}</option>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>Catalogue</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
    <form class="finder in-page" id="catalog-search" action="/search"><input type="search" name="q"><input type="hidden" name="kind" value="map"></form>
    <div data-search-results><div class="place-tools">
      <label>地区<select name="region" form="catalog-search">${option('', '全部地区', region)}${option('orbis', '天空之城', region)}${option('victoria', '金银岛', region)}</select></label>
      <label>区域<select name="area" form="catalog-search" ${region ? '' : 'disabled'}>${option('', '全部区域', area)}${region ? option(region + '-town', '城镇', area) + option(region + '-field', '野外', area) : ''}</select></label>
      <button type="button" data-place-reset>重置</button></div>
      <div class="catalogue-tools"><label>职业<select name="job" form="catalog-search">${option('0', '所有职业', url.searchParams.get('job') || '0')}${option('1', '战士', url.searchParams.get('job'))}</select></label>
        <input type="number" name="min_level" form="catalog-search"><input type="number" name="max_level" form="catalog-search"><button type="button"><span data-filter-summary></span></button>
      </div><p data-result-state>${region}|${area}</p></div>
    <script type="module">import {bindLiveSearch} from '/web/js/lib/live-search.js';bindLiveSearch();document.documentElement.dataset.ready='1';</script>
    </body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [true, false]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 375 : 1280, height: 812 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.selectFocusCalls = [];
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) {
        if (this.matches('.place-tools select,.catalogue-tools select')) window.selectFocusCalls.push(this.name);
        return focus.apply(this, args);
      };
    });
    await page.goto(origin + '/search?kind=map');
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    const callCount = () => page.evaluate(() => window.selectFocusCalls.length);
    const waitForResult = value => page.waitForFunction(expected => document.querySelector('[data-result-state]').textContent === expected && !document.querySelector('[data-search-results]').hasAttribute('aria-busy'), value);
    async function choose(name, value, keyboard = false) {
      const select = page.locator(`select[name=${name}]`);
      // Establish the same focus and input modality as an open native picker.
      await select.focus();
      await select.dispatchEvent(keyboard ? 'keydown' : 'pointerdown', keyboard ? { key: 'ArrowDown' } : { pointerType: mobile ? 'touch' : 'mouse' });
      const before = await callCount();
      await select.selectOption(value);
      return before;
    }
    let before = await choose('region', 'orbis');
    await waitForResult('orbis|');
    assert.equal(await callCount(), before, 'pointer selection must not refocus the replacement region menu');
    assert.equal(await page.locator('select[name=area]').isEnabled(), true);
    assert.deepEqual(await page.locator('select[name=area] option').evaluateAll(els => els.map(el => el.value)), ['', 'orbis-town', 'orbis-field']);
    before = await choose('area', 'orbis-town');
    await waitForResult('orbis|orbis-town');
    assert.equal(await callCount(), before, 'pointer selection must not refocus the replacement area menu');
    before = await choose('region', 'victoria', true);
    await waitForResult('victoria|');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'region');
    assert.equal(await callCount(), before + 1, 'keyboard navigation retains focus after results refresh');
    assert.equal(await page.locator('select[name=area]').inputValue(), '');
    // Pointer input after keyboard input must switch focus restoration off.
    before = await choose('area', 'victoria-field');
    await waitForResult('victoria|victoria-field');
    assert.equal(await callCount(), before);
    before = await choose('job', '1');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('job') === '1');
    assert.equal(await callCount(), before, 'preserved catalogue selects must not be refocused for pointer input either');
    const resetStart = requests;
    await page.locator('[data-place-reset]').click();
    await waitForResult('|');
    assert.equal(await page.locator('select[name=area]').isDisabled(), true);
    assert.equal(requests, resetStart + 1, 'a selection/reset triggers only one results request');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'touch' : 'mouse'}: region/area selects do not refocus, keyboard focus remains, dependent areas and reset work`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
