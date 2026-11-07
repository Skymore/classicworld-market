import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.REACT_VERIFY_ORIGIN || 'http://127.0.0.1:18766';
const screenshots = process.env.REACT_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const mobile of [true, false]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: mobile ? 375 : 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme === 'dark' ? 'light' : 'dark' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => { if (!sessionStorage.getItem('react-live-seeded')) { localStorage.setItem('uiTheme', value); localStorage.setItem('uiLang', 'zh'); sessionStorage.setItem('react-live-seeded', '1'); } window.reactDocumentId = Math.random(); }, theme);
    await page.goto(origin + '/prices?hours=all&lang=zh');
    await page.locator('[data-item-row]:visible').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.reactApp), '1');
    if (mobile) assert(await page.locator('.dock a').evaluateAll(links => { const boxes=links.map(link=>link.getBoundingClientRect()); return boxes.length===5&&boxes.every(box=>Math.abs(box.top-boxes[0].top)<1&&box.right<=innerWidth&&box.bottom<=innerHeight); }), 'five mobile navigation entries fit on one row');
    const identity = await page.evaluate(() => { window.savedHeader = document.querySelector('.ptop'); return window.reactDocumentId; });
    const color = theme === 'dark' ? '#232b38' : '#f3e7c9';
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sheet').trim()), color);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `prices-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
    await page.locator('[data-nav-key=home]:visible').click(); await page.locator('.hero h1').waitFor();
    await page.locator('.react-prices [data-item-row]:visible').first().waitFor();
    assert.equal(await page.evaluate(() => window.reactDocumentId), identity);
    assert(await page.evaluate(() => window.savedHeader === document.querySelector('.ptop')));
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `home-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
    for (const [key, selector] of [['watch', '[data-search]'], ['tools', '.tools-page h1']]) {
      await page.locator(`[data-nav-key=${key}]:visible`).click(); await page.locator(selector).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      if (key === 'tools') assert.equal(await page.locator(selector).textContent(), '工具');
    }
    await page.locator('[data-account-link]:visible').click(); await page.locator('[data-account]').waitFor();
    assert.equal(await page.locator('.dnav a[aria-current],.dock a[aria-current]').count(), 0, 'account must not select a market navigation tab');
    await page.goto(origin + '/contributors?lang=zh'); await page.locator('[data-board=week]').waitFor();
    await page.locator('[data-nav-key=dex]:visible').click();
    await page.locator('#site-react-shell').waitFor({ state: 'attached' });
    await page.locator('[data-nav-key=tools]:visible').waitFor();
    assert.equal(await page.locator('[data-nav-key=tools]:visible').textContent(), '工具');
    await page.locator('[data-react-catalogue=search] [data-search-results]').waitFor();
    assert(await page.locator('#search-item').count(), 'catalogue results render in React');
    await page.goto(origin + '/item/2000000?hours=all&lang=zh');
    await page.locator('#site-react-shell').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    assert(await page.locator('.item-stall').count(), 'item content remains server rendered');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `item-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
    const next = theme === 'dark' ? 'light' : 'dark';
    await page.locator('[data-theme-toggle]:visible').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), next);
    await page.reload(); await page.locator('#site-react-shell').waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), next);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    assert.deepEqual(errors, []);
    console.log(`PASS ${origin} ${mobile ? 'phone' : 'desktop'} ${theme}: live prices/home/watch/collect/account/catalogue/item, original tokens, persistent shell, reload and theme`);
    await page.close();
  }
} finally { await browser.close(); }
