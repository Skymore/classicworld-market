import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin=process.env.FILTER_TEST_ORIGIN || 'http://127.0.0.1:18767';
const shots=process.env.FILTER_SCREENSHOTS;
if(shots)await mkdir(shots,{recursive:true});
const browser=await chromium.launch({ args: ['--lang=zh-CN'], channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try {
  const thumbColors=[];
  for(const width of [1440,800,375,320])for(const theme of ['light','dark']) {
    const page=await browser.newPage({viewport:{width,height:width===320?700:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(theme=>{localStorage.setItem('uiTheme',theme);localStorage.setItem('uiLang','zh');},theme);
    await page.goto(origin+'/prices?job=bowman&lmin=40&lmax=50&lang=zh');
    await page.locator('[data-item-row]:visible').first().waitFor();
    await page.locator('[data-filter-btn]').click();
    const layout=await page.locator('.level-presets .chip').evaluateAll(nodes=>nodes.map(node=>{
      const r=node.getBoundingClientRect();
      return {top:Math.round(r.top),left:r.left,right:r.right,width:r.width,clipped:node.scrollWidth>node.clientWidth};
    }));
    const rows=[...new Set(layout.map(r=>r.top))];
    assert.equal(rows.length,width>640?1:2,'preset row count');
    if(width<=640)assert.deepEqual(rows.map(top=>layout.filter(r=>r.top===top).length),[4,3]);
    assert(layout.every(r=>r.width>=44&&!r.clipped&&r.left>=0&&r.right<=width),'labels and touch targets fit');
    const scroll=await page.locator('.fpanel').evaluate(el=>({
      width:getComputedStyle(el,'::-webkit-scrollbar').width,
      buttons:getComputedStyle(el,'::-webkit-scrollbar-button').display,
      thumb:getComputedStyle(el,'::-webkit-scrollbar-thumb').backgroundColor,
      track:getComputedStyle(el,'::-webkit-scrollbar-track').backgroundColor,
      max:el.scrollHeight-el.clientHeight,
    }));
    assert.equal(scroll.width,'8px');assert.equal(scroll.buttons,'none');
    assert.notEqual(scroll.thumb,scroll.track);thumbColors.push(scroll.thumb);
    if(scroll.max>0){
      await page.locator('.fpanel').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      assert(await page.locator('.fpanel').evaluate(el=>el.scrollTop>0));
    }
    await page.locator('.level-presets').scrollIntoViewIfNeeded();
    assert(await page.locator('[data-apply]').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
    assert(await page.locator('.ui-dialog-close').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(shots)await page.screenshot({path:path.join(shots,`layout-${width}-${theme}.png`)});
    assert.deepEqual(errors,[]);await page.close();
    console.log(`PASS ${width}px ${theme}: ${rows.length} level row(s), unclipped labels, 8px scrollbar, no arrows, fixed actions and close`);
  }
  assert.notEqual(thumbColors[0],thumbColors[1],'thumb adapts to light and dark');
  // Both the SPA and server-rendered/standalone pages share the global styles.
  const page=await browser.newPage();
  for(const route of ['/','/item/2000000?lang=zh','/search?kind=item&lang=zh','/web/download.html']){
    await page.goto(origin+route);
    await page.locator('link[href^="/web/react/style.css"]').first().waitFor({state:'attached'});
    await page.waitForFunction(()=>getComputedStyle(document.documentElement,'::-webkit-scrollbar').width==='8px');
    assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el,'::-webkit-scrollbar-button').display),'none');
    console.log(`PASS global scrollbar ${route}`);
  }
  await page.close();
} finally {await browser.close();}
