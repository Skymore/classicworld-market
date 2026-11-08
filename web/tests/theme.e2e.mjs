// Exercise actual page responses with module execution held until after paint.
// THEME_TEST_ORIGIN points at a candidate or the public deployment.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.THEME_TEST_ORIGIN || 'http://127.0.0.1:18766';
const colors = { dark: 'rgb(20, 25, 34)', light: 'rgb(230, 225, 214)' };
const browser = await chromium.launch({ args: ['--lang=zh-CN'],  channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const mobile of [true, false]) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({
        viewport: { width: mobile ? 375 : 1280, height: 812 },
        isMobile: mobile, hasTouch: mobile, colorScheme: theme === 'dark' ? 'light' : 'dark',
      });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(saved => {
        if (!sessionStorage.getItem('theme-test-seeded')) {
          localStorage.setItem('uiTheme', saved);
          sessionStorage.setItem('theme-test-seeded', '1');
        }
        window.themeFrames = [];
        function sample() {
          const html = document.documentElement;
          if (html && document.body && getComputedStyle(html).getPropertyValue('--page')) {
            window.themeFrames.push({ theme: html.dataset.theme, color: getComputedStyle(html).backgroundColor });
          }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }, theme);
      let releaseModules, moduleGate;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('.js') && url.pathname !== '/web/js/lib/boot.js') await moduleGate;
        if (route.request().resourceType() === 'image') return route.abort();
        return route.continue();
      });
      try {
        for (const path of ['/account', '/search?kind=item', '/item/2000000', '/web/download.html', '/collect/']) {
          moduleGate = new Promise(resolve => { releaseModules = resolve; });
          const response = await page.goto(origin + path, { waitUntil: 'commit' });
          assert.equal(response.status(), 200, path);
          await page.waitForFunction(() => window.themeFrames?.length >= 4);
          const beforeModules = await page.evaluate(() => ({
            ready: document.documentElement.dataset.ready,
            frames: window.themeFrames,
            scheme: getComputedStyle(document.documentElement).colorScheme,
          }));
          assert.equal(beforeModules.ready, undefined, 'modules must still be held');
          assert(beforeModules.frames.every(frame => frame.theme === theme && frame.color === colors[theme]), `${path}: wrong theme before module execution`);
          assert.equal(beforeModules.scheme, theme, 'native controls follow the chosen theme');
          releaseModules();
          if (path === '/collect/') {
            await page.locator('[data-account-link]').first().waitFor({ state: 'attached' });
            {await page.locator('[data-theme-toggle]:visible').first().click();await page.locator(await page.evaluate(()=>document.documentElement.dataset.theme==='dark'?'[data-theme-choice=light]':'[data-theme-choice=dark]')).click();}
            await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme === 'dark' ? 'light' : 'dark');
            {await page.locator('[data-theme-toggle]:visible').first().click();await page.locator(await page.evaluate(()=>document.documentElement.dataset.theme==='dark'?'[data-theme-choice=light]':'[data-theme-choice=dark]')).click();}
          } else if (path === '/web/download.html') {
            await page.locator('.download-page').waitFor();
          } else {
            await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
            if (path.startsWith('/search') || path.startsWith('/item/')) await page.locator('#site-react-shell').waitFor({ state: 'attached' });
          }
          if (path !== '/collect/') {
            assert(await page.evaluate(expected => window.themeFrames.every(frame => frame.theme === expected), theme), `${path}: theme changed while modules loaded`);
          }
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
        }
        assert.deepEqual(errors, []);
        // A shared URL updates the saved preference on SSR and survives a link navigation.
        const next = theme === 'dark' ? 'light' : 'dark';
        await page.goto(origin + '/search?kind=item&theme=' + next);
        await page.locator('#site-react-shell').waitFor({ state: 'attached' });
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
        assert.equal(await page.evaluate(() => localStorage.getItem('uiTheme')), next);
        await page.locator('a[href="/account"]:visible').first().click();
        await page.waitForURL('**/account');
        await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), next);
        await page.reload();
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), next);
        await page.goBack();
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), next);
        console.log(`PASS ${mobile ? 'phone' : 'desktop'} ${theme}: first paint, delayed modules, native controls, shared links, navigation, reload and back`);
      } finally { releaseModules?.(); await page.close(); }
    }
  }
} finally { await browser.close(); }
