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
    try { res.setHeader('Content-Type', file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/javascript'); return res.end(await readFile(file)); }
    catch { res.writeHead(404); return res.end(); }
  }
  if(url.pathname==='/api/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end(': ready\n\n');}
  if(url.pathname==='/api/v1/account'){res.setHeader('Content-Type','application/json');return res.end('{"signed_in":false}');}
  if(url.pathname==='/api/v1/catalog/page'){requests++;const target=new URL(url.searchParams.get('url'),'http://localhost'),region=target.searchParams.get('region')||'',area=target.searchParams.get('area')||'';res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify({kind:'search',page:{query:target.searchParams.get('q')||'',kind:(target.searchParams.get('kind')||'map').replace(/^./,c=>c.toUpperCase()),offset:0,region,area,areas:region?[{region,key:region+'-town',names:{zh:'城镇',en:'Town'}},{region,key:region+'-field',names:{zh:'野外',en:'Field'}}]:[],filters:{job:Number(target.searchParams.get('job'))||0,cat:target.searchParams.get('cat')||''},items:{rows:[],more:false},mobs:{rows:[],more:false},maps:{rows:[{id:10001000,names:{zh:region+'|'+area,en:region+'|'+area}}],more:false}}})),80);}
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end('{}');}
  res.setHeader('Content-Type','text/html');res.end(await readFile(path.join(root,'index.html')));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
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
    const waitForResult = value => page.waitForFunction(expected => document.querySelector('#search-map .catalogue-grid .t b')?.textContent === expected && document.querySelector('[data-react-catalogue]')?.getAttribute('aria-busy') === 'false', value);
    async function choose(name, value, keyboard = false) {
      const select = page.locator(`select[name=${name}]`);
      // Establish the same focus and input modality as an open native picker.
      await select.focus();
      await select.dispatchEvent(keyboard ? 'keydown' : 'pointerdown', keyboard ? { key: 'ArrowDown' } : { pointerType: mobile ? 'touch' : 'mouse' });
      const before = await callCount();
      await select.selectOption(value);
      return before;
    }
    let before = await choose('region', 'maple');
    await waitForResult('maple|');
    assert.equal(await callCount(), before, 'pointer selection must not refocus the replacement region menu');
    assert.equal(await page.locator('select[name=area]').isEnabled(), true);
    assert.deepEqual(await page.locator('select[name=area] option').evaluateAll(els => els.map(el => el.value)), ['', 'maple-town', 'maple-field']);
    before = await choose('area', 'maple-town');
    await waitForResult('maple|maple-town');
    assert.equal(await callCount(), before, 'pointer selection must not refocus the replacement area menu');
    before = await choose('region', 'victoria', true);
    await waitForResult('victoria|');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'region');
    assert.equal(await callCount(), before, 'React preserves the same focused select without another focus call');
    assert.equal(await page.locator('select[name=area]').inputValue(), '');
    // Pointer input after keyboard input must switch focus restoration off.
    before = await choose('area', 'victoria-field');
    await waitForResult('victoria|victoria-field');
    assert.equal(await callCount(), before);
    await page.locator('a.chip[href*="kind=item"]').click();
    await page.locator('.catalogue-filter > summary').click();
    before = await choose('job', '1');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('job') === '1');
    assert.equal(await callCount(), before, 'preserved catalogue selects must not be refocused for pointer input either');
    await page.locator('a.chip[href*="kind=map"]').click();
    await waitForResult('victoria|victoria-field');
    const resetStart = requests;
    await page.locator('[data-place-reset]').click();
    await waitForResult('|');
    assert.equal(await page.locator('select[name=area]').isDisabled(), true);
    assert(requests <= resetStart + 1, 'reset uses the cache or one request, never duplicates');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mobile ? 'touch' : 'mouse'}: region/area selects do not refocus, keyboard focus remains, dependent areas and reset work`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
