import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WATCH_VERIFY_ORIGIN || 'http://127.0.0.1:18766';
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
try {
  for (const width of [375,1280]) {
    const page=await browser.newPage({viewport:{width,height:900},isMobile:width<640,hasTouch:width<640});
    const errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>requests.push(new URL(r.url()).pathname));
    await page.addInitScript(()=>{
      localStorage.setItem('lang','zh');
      localStorage.setItem('watchlist','[2000000]');
      localStorage.setItem('watchlist_settings','{"2000000":{"cap":0,"notify":true}}');
      localStorage.setItem('watch.listCollapsed','true');
      window.desktopNotifications=[];
      window.documentIdentity=Math.random();
      window.Notification=class{static permission='granted';constructor(title,options){window.desktopNotifications.push(options.tag);}};
    });
    // A direct catalogue link must start the same watch engine as the homepage.
    const shared=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/watchlist/listings');
    await page.goto(origin+'/item/2000000?lang=zh');
    assert.equal((await shared).status(),200);
    await page.locator('[data-react-catalogue="item"]').waitFor();
    const identity=await page.evaluate(()=>window.documentIdentity);
    await page.locator('[data-nav-key="watch"]:visible').click();
    await page.locator('[data-watch-collapse]').waitFor();
    assert.equal(await page.locator('#watch-list').isVisible(),false);
    assert.equal(await page.locator('.watch-page [data-notification-state]').count(),0,'Watch says nothing while notifications work');
    // The controls live in 我的 → 通知.
    await page.locator('[data-account-link]:visible').click();
    await page.locator('[data-setting=notifications] summary').click();
    await page.locator('[data-notification-test]').click();
    assert((await page.evaluate(()=>window.desktopNotifications)).includes('watch-notification-test'));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('[data-nav-key="home"]:visible').click();
    await page.locator('[data-item-row]:visible').first().waitFor();
    await Promise.all([
      page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/watchlist/listings'),
      page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))),
    ]);
    assert.equal(await page.evaluate(()=>window.documentIdentity),identity);
    assert.deepEqual(errors,[]);
    await page.close();
    console.log(`PASS ${origin} ${width}px: direct item-page watch feed, visible collapsed-list permission/test control, price-page updates and preserved document`);
  }
} finally { await browser.close(); }
