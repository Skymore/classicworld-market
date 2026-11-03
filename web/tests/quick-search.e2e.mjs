// Real React home/header search, item previews and SSE with an isolated server.
// Model Safari's blur-before-click sequence: tapped links need not receive focus.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.QUICK_SEARCH_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const nativeReact = process.env.QUICK_SEARCH_REACT !== '0';
const limit = Number(process.env.QUICK_SEARCH_LIMIT || 6);
const streams = new Set();
const now = Date.now() / 1000;
let generation = 0;
let marketReads = 0;
const json = (res, data) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const searchRows = `<div data-search-results>
  ${Array.from({ length: 7 }, (_, i) => `<a class="drow" href="/item/${2048000 + i}"><span class="t"><b>宠物装备移动速度卷轴 ${i + 1}</b><small class="name-secondary">Pet Equip Speed Scroll ${i + 1}</small></span></a>`).join('')}
  <a class="drow" href="/mob/100100"><span class="t"><b>蜗牛</b></span></a>
  <a class="drow" href="/map/100000000"><span class="t"><b>射手村</b></span></a>
</div>`;
function snapshot(target) {
  const kind = target.pathname.split('/')[1], id = Number(target.pathname.split('/').at(-1));
  const names = { zh: '宠物装备移动速度卷轴', en: 'Pet Equip Speed Scroll' };
  if (kind === 'item') return { kind, page: { item: { id, name_zh: names.zh, name_en: names.en, category: '消耗品' }, stats: null, droppers: [], npc_offers: [], npc_sell: 25, market: { as_of: new Date().toISOString(), base_stats: [], days: [], sale_points: [], listings: [], sales: [] } } };
  if (kind === 'mob') return { kind, page: { mob: { id, names, level: 1, hp: 15, exp: 3 }, spawns: [], drops: [] } };
  if (kind === 'map') return { kind, page: { map: { id, names, is_town: true }, return_map: null, mobs: [], npcs: [], exits: [], entrances: [] } };
  return { kind: 'search', page: { query: target.searchParams.get('q') || '', kind: null, region: '', area: '', areas: [], filters: {}, offset: 0, items: { rows: Array.from({ length: 7 }, (_, i) => ({ id: 2048000 + i, names })), more: false }, mobs: { rows: [{ id: 100100, names }], more: false }, maps: { rows: [{ id: 100000000, names }], more: false } } };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/v1/catalog/page') return json(res, snapshot(new URL(url.searchParams.get('url'), 'http://localhost')));
    let body = {};
    if (url.pathname === '/api/v1/account') body = { signed_in: false };
    if (url.pathname === '/api/v1/market/period-default') body = { default_hours: 'all' };
    if (['/api/v1/market','/api/v1/market/overview','/api/v1/market/selected'].includes(url.pathname)) {
      marketReads++;
      body = { as_of: now + generation, products: [], product_count: 0, changes: [], busy: [] };
    }
    if (url.pathname === '/api/v1/sales/recent') {
      body = { generated_at: now + generation, sales: [] };
    }
    if (url.pathname === '/api/v1/dex/counts') body = { mobs: 1, maps: 1 };
    return json(res, body);
  }
  if (url.pathname === '/search') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(searchRows);
  }
  if (/^\/(item|mob|map)\//.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(url.searchParams.get('part') === 'preview'
      ? `<div class="peek-content" data-preview-item="${id}"><h2>Pet Equip Speed Scroll</h2><footer class="peek-footer"><a href="/item/${id}">Full details</a></footer></div>`
      : '<h1>Full detail page</h1>');
  }
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  if (nativeReact) for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/prices?hours=all&lang=zh');
    const input = page.locator('[data-q]');
    await input.focus();
    await page.waitForFunction(() => document.documentElement.dataset.liveConnection === 'connected');
    await input.evaluate(node => { window.savedPriceInput = node; });
    const cdp = await page.context().newCDPSession(page);
    for (const [drafts, committed] of [[['b', 'ba', 'bai', 'baig', 'baigong'], '白宫'], [['n', 'na', 'nage'], '那个']]) {
      const before = await input.inputValue();
      for (const text of drafts) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await input.inputValue(), before + text, 'composition replaces its previous draft without duplicating pinyin');
        assert.equal(new URL(page.url()).searchParams.get('q') || '', before, 'do not publish uncommitted IME text to the route');
      }
      const reads = marketReads;
      generation++;
      for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
      const deadline = Date.now() + 10000;
      while (marketReads === reads && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert(marketReads > reads, 'SSE refetches market data during composition');
      await page.waitForFunction(expected => [...document.querySelectorAll('[data-fresh]')].some(node => Number(node.dataset.asOf) === expected), now + generation).catch(async error => {
        console.error({ route, generation, marketReads, errors, page: await page.locator('body').innerText() });
        throw error;
      });
      assert.equal(await input.inputValue(), before + drafts.at(-1), 'SSE preserves the active composition');
      assert(await input.evaluate(node => node === window.savedPriceInput && node === document.activeElement), 'SSE preserves the composing input and focus');
      await cdp.send('Input.insertText', { text: committed });
      await page.waitForURL(url => url.searchParams.get('q') === before + committed);
      assert.equal(await input.inputValue(), before + committed, 'commit only the chosen Chinese text');
    }
    await input.fill('红色药水');
    await page.waitForURL(url => url.searchParams.get('q') === '红色药水');
    await page.locator('[data-clear-price-filters="everything"]').click();
    await page.waitForFunction(() => document.querySelector('[data-q]').value === '');
    await input.fill('Potion');
    await page.waitForURL(url => url.searchParams.get('q') === 'Potion');
    await input.fill('');
    await page.waitForURL(url => !url.searchParams.has('q'));
    await page.evaluate(() => {
      history.pushState(null, '', '/?hours=all&lang=zh&q=蜗牛');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForFunction(() => document.querySelector('[data-q]').value === '蜗牛');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-q]').value === '');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'} prices: native IME replacement/commit, repeated Chinese composition, SSE, plain typing, clear and history`);
  }
  for (const [mobile, route] of [[true, '/'], [false, '/'], [false, '/watch']]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, isMobile: mobile, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // The header search box, on a page with market data that refreshes from SSE.
    if (route === '/watch') await page.addInitScript(() => localStorage.setItem('watchlist', '[2048000]'));
    const finder = page.locator(route === '/' ? '.hero form.finder' : '.dhead form.finder');
    const input = finder.locator('input[name=q]');
    const box = finder.locator('.quick-search');
    async function search() {
      // A pointer left where a result row reappears opens the desktop hover
      // preview over that row before the next press.
      await page.mouse.move(0, 0);
      await page.goto(origin + route + '?hours=all&lang=zh');
      const answer = page.waitForResponse(response => {
        const url = new URL(response.url());
        const target = nativeReact && url.pathname === '/api/v1/catalog/page'
          ? new URL(url.searchParams.get('url'), origin) : url;
        return target.pathname === '/search' && target.searchParams.get('q') === 'Speed pet';
      });
      await input.fill('Speed pet');
      await (await answer).finished();
      await box.locator('.quick-row').first().waitFor();
      await page.waitForFunction(() => document.querySelector('.quick-search:not([hidden])')?.getAttribute('aria-busy') !== 'true');
      assert.equal(await box.locator('.quick-row[href*="/item/"]').count(), limit, 'show the configured number of item suggestions');
      assert.equal(await box.locator('.quick-row').count(), limit + 2, 'keep monster and map suggestions too');
      await page.waitForFunction(() => document.documentElement.dataset.liveConnection === 'connected');
    }
    async function refresh() {
      const reads = marketReads;
      generation++;
      for (const stream of streams) stream.write('event: market\ndata: {}\n\n');
      await page.waitForFunction(expected => [...document.querySelectorAll('[data-fresh]')].some(node => Number(node.dataset.asOf) === expected), now + generation);
      assert(marketReads > reads, 'the background SSE refresh must run');
    }
    async function pressWithoutLinkFocus(link) {
      await link.scrollIntoViewIfNeeded();
      const bounds = await link.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      // Safari may blur the input without focusing the tapped anchor. Hold the
      // pointer down across a task boundary, as on a real touch screen.
      await page.evaluate(() => document.addEventListener('mousedown', event => event.preventDefault(), { once: true, capture: true }));
      await page.mouse.down();
      await input.evaluate(node => node.blur());
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    }

    await search();
    await input.evaluate(node => { window.savedInput = node; });
    await box.locator('.quick-row').first().evaluate(node => { window.savedRow = node; });
    await refresh();
    assert(await input.evaluate(node => node === window.savedInput && node === document.activeElement), 'SSE preserves the input and focus');
    assert(await box.locator('.quick-row').first().evaluate(node => node === window.savedRow), 'SSE preserves the suggested row');
    await pressWithoutLinkFocus(box.locator('.quick-row').first());
    assert.equal(await box.isVisible(), true, 'blur must not hide the link before its click');
    await refresh();
    await page.mouse.up();
    if (mobile) {
      const popup = page.locator('#item-quick-preview');
      await popup.locator('[data-preview-item="2048000"]').waitFor();
      await refresh();
      assert.equal(await popup.isVisible(), true, 'SSE preserves a selected search result preview');
      await popup.locator('.peek-footer a').click();
    }
    await page.waitForURL(url => url.pathname === '/item/2048000');
    if (nativeReact) await page.locator('[data-react-catalogue=item]').waitFor();
    else assert.equal(await page.locator('h1').textContent(), 'Full detail page');

    // Finishing an IME composition on blur must not replace the pressed row.
    await search();
    await input.dispatchEvent('compositionstart');
    await pressWithoutLinkFocus(box.locator('.quick-row').first());
    await input.dispatchEvent('compositionend');
    assert.equal(await box.locator('.quick-row').count(), limit + 2, 'IME completion must preserve the pressed result');
    await page.mouse.up();
    if (mobile) await page.locator('#item-quick-preview [data-preview-item="2048000"]').waitFor();
    else await page.waitForURL(url => url.pathname === '/item/2048000');

    for (const destination of ['/mob/100100', '/map/100000000', '/search']) {
      await search();
      const link = box.locator(destination === '/search' ? '.quick-more' : `a[href$="${destination}"]`);
      await pressWithoutLinkFocus(link);
      assert.equal(await box.isVisible(), true);
      await page.mouse.up();
      await page.waitForURL(url => url.pathname === destination);
      if (destination === '/search') assert.equal(new URL(page.url()).searchParams.get('q'), 'Speed pet');
    }

    await search();
    if (mobile) {
      await box.locator('.quick-row').first().tap();
      await page.locator('#item-quick-preview [data-preview-item="2048000"]').waitFor();
      await page.locator('#item-quick-preview .peek-close').click();
      await search();
      await box.locator('.quick-row[href*="/item/"]').last().tap();
      await page.locator('#item-quick-preview [data-preview-item="2048005"]').waitFor();
      await page.locator('#item-quick-preview .peek-close').click();
      await search();
      await page.setViewportSize({ width: 390, height: 520 });
      await page.waitForFunction(() => {
        const box = document.querySelector('.hero .quick-search').getBoundingClientRect();
        return box.bottom <= visualViewport.offsetTop + visualViewport.height - 10;
      });
      const more = box.locator('.quick-more');
      assert(await more.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), 'all-results stays visible above the reduced viewport edge');
      await more.tap();
      await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === 'Speed pet');
      await search();
      await pressWithoutLinkFocus(more);
      const pressedPosition = await more.boundingBox();
      await page.setViewportSize({ width: 390, height: 700 });
      assert.deepEqual(await more.boundingBox(), pressedPosition, 'keyboard dismissal must not move a link under the finger');
      await page.mouse.up();
      await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === 'Speed pet');
      await page.setViewportSize({ width: 390, height: 844 });
      await search();
    }
    // A canceled touch and an ordinary blur still dismiss the dropdown.
    await input.fill('Speed pet');
    await box.locator('.quick-row').first().waitFor();
    await box.locator('.quick-row').first().dispatchEvent('pointerdown', { button: 0, pointerType: 'touch' });
    await input.evaluate(node => node.blur());
    await box.locator('.quick-row').first().dispatchEvent('pointercancel', { pointerType: 'touch' });
    await box.waitFor({ state: 'hidden' });
    await input.focus();
    await box.locator('.quick-row').first().waitFor();
    await input.evaluate(node => node.blur());
    await box.waitFor({ state: 'hidden' });
    await input.focus();
    await box.locator('.quick-row').first().waitFor();
    await page.keyboard.press('ArrowDown');
    assert(await box.locator('.quick-row').first().evaluate(node => node === document.activeElement));
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'hidden' });
    await input.focus();
    await box.locator('.quick-row').first().waitFor();
    await page.mouse.click(5, 5);
    await box.waitFor({ state: 'hidden' });

    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'phone' : 'desktop'} ${route}: six suggestions per kind, blur/IME/SSE selection, detail/all-results links, touch cancellation, keyboard and dismissal`);
  }
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
