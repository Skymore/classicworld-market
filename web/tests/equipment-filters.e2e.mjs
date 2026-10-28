import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
const origin = process.env.FILTER_TEST_ORIGIN || 'http://127.0.0.1:18767';
const shots = process.env.FILTER_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const fixture = [
  [1002000, '零级帽', '帽子', 0, '弓箭手'],
  [1002001, '二十级帽', '帽子', 20, '弓箭手'],
  [1002002, '三十级帽', '帽子', 30, '弓箭手'],
  [1002003, '四十级帽', '帽子', 40, '弓箭手'],
  [1002004, '五十级通用帽', '帽子', 50, '通用'],
  [1002005, '六十级帽', '帽子', 60, '弓箭手'],
  [1002006, '七十级帽', '帽子', 70, '弓箭手'],
  [1002007, '八十级帽', '帽子', 80, '弓箭手'],
  [1072000, '四十五级鞋', '鞋子', 45, '弓箭手'],
  [1002008, '战士帽', '帽子', 45, '战士'],
].map(([item_id,name_zh,subcategory,level,job]) => ({item_id,name_zh,subcategory,level,
  category:'装备',jobs:[job],typical:100,low:90,sales_window:10,listings:2}));
fixture.push({item_id:2000000,name_zh:'药水',category:'消耗品',level:null,typical:10,sales_window:10});
// Equipment every job can wear has an empty job list in the catalogue.
fixture.push({item_id:1002009,name_zh:'四十八级全职业帽',subcategory:'帽子',level:48,category:'装备',jobs:[],typical:100,low:90,sales_window:20,listings:2});
const ids = page => page.locator('[data-item-row]:visible').evaluateAll(rows => rows.map(row => Number((row.querySelector('a[href^="/item/"]') || row).getAttribute('href').match(/\/item\/(\d+)/)[1])).sort());
try {
  for (const mobile of [false,true]) for (const theme of ['light','dark']) {
    const page = await browser.newPage({viewport:{width:mobile?375:1440,height:900},isMobile:mobile,hasTouch:mobile});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(theme=>{localStorage.setItem('lang','zh');localStorage.setItem('theme',theme);},theme);
    // Exercise the actual data before switching to controlled boundary examples.
    await page.goto(origin+'/prices?job=bowman&lmin=40&lmax=50&lang=zh');
    await page.locator('[data-item-row]:visible').first().waitFor();
    await page.locator('[data-filter-btn]').click();
    assert(await page.locator('[data-apply]').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'apply remains in the viewport while filters scroll');
    const selected=page.locator('[data-job=bowman]');
    assert.equal(await selected.getAttribute('aria-pressed'),'true');
    assert.notEqual(await selected.evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('[data-job=warrior]').evaluate(el=>getComputedStyle(el).backgroundColor));
    assert.deepEqual(await page.locator('[data-lv]').evaluateAll(nodes=>nodes.map(node=>node.dataset.lv)),['0-20','20-30','30-40','40-50','50-60','60-70','70+']);
    if(shots)await page.screenshot({path:path.join(shots,`filters-${mobile?'phone':'desktop'}-${theme}.png`)});
    await page.route('**/api/v1/market?**',route=>route.fulfill({json:{as_of:Date.now()/1000,products:fixture}}));
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('[data-item-row]')?.textContent?.includes('四十'));
    assert.deepEqual(await ids(page),[1002003,1002004,1002009,1072000],'every-job equipment stays with the bowman filter');
    const order=await page.locator('[data-item-row]:visible,[data-shared-head]:visible').evaluateAll(nodes=>nodes.map(node=>node.matches('[data-shared-head]')?'head':(node.querySelector('a[href^="/item/"]')||node).getAttribute('href').match(/\/item\/(\d+)/)[1]));
    const head=order.indexOf('head');
    assert.equal(head,order.length-3,'bowman equipment first, then a heading and the two for every job');
    assert.deepEqual(order.slice(head+1).sort(),['1002004','1002009']);
    assert.match(await page.locator('[data-shared-head]:visible').textContent(),/全职业通用\s*2 件/);
    // The heading folds the shared rows away, stays as the last row, and remembers it.
    const sharedToggle=page.locator('[data-shared-head]:visible [data-shared-toggle]');
    await sharedToggle.click();
    assert.equal(await sharedToggle.getAttribute('aria-expanded'),'false');
    assert.deepEqual(await ids(page),[1002003,1072000],'collapsed hides the equipment for every job');
    assert.notEqual(await page.locator('[data-item-row]:visible,[data-shared-head]:visible').last().getAttribute('data-shared-head'),null,'the heading closes the list');
    await page.reload();await page.locator('[data-shared-head]:visible').waitFor();
    assert.deepEqual(await ids(page),[1002003,1072000],'collapsed stays after a reload');
    await sharedToggle.click();
    assert.equal(await sharedToggle.getAttribute('aria-expanded'),'true');
    assert.deepEqual(await ids(page),[1002003,1002004,1002009,1072000]);
    await page.locator('[data-filter-btn]').click();
    await page.locator('[data-equipment-type=hat]').click();
    assert.equal(await page.locator('[data-equipment-type=hat]').getAttribute('aria-pressed'),'true');
    assert.equal(new URL(page.url()).searchParams.get('type'),'hat');
    assert.equal(new URL(page.url()).searchParams.get('cat'),'equip');
    await page.locator('[data-apply]').click();
    assert.deepEqual(await ids(page),[1002003,1002004,1002009]);
    await page.reload();await page.locator('[data-item-row]:visible').first().waitFor();
    assert.deepEqual(await ids(page),[1002003,1002004,1002009]);
    await page.locator('[data-filter-btn]').click();
    assert.equal(await page.locator('[data-job=bowman]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-equipment-type=hat]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-lv="40-50"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-lv="70+"]').click();
    assert.equal(await page.locator('[data-lmax]').inputValue(),'');
    assert.equal(new URL(page.url()).searchParams.has('lmax'),false);
    await page.locator('[data-apply]').click();
    assert.deepEqual(await ids(page),[1002006,1002007]);
    await page.locator('[data-remove-price-filter=type]').click();
    assert.equal(new URL(page.url()).searchParams.get('job'),'bowman');
    assert.equal(new URL(page.url()).searchParams.get('lmin'),'70');
    await page.locator('[data-filter-btn]').click();
    await page.locator('[data-lv="0-20"]').click();
    await page.locator('[data-apply]').click();
    assert.deepEqual(await ids(page),[1002000,1002001]);
    await page.locator('[data-filter-btn]').click();
    await page.locator('[data-equipment-type=hat]').click();
    await page.locator('[data-filter-reset]').click();
    assert.equal(await page.locator('[data-job=all]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-equipment-type=all]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-lmin]').inputValue(),'');
    await page.locator('[data-apply]').click();
    await page.locator('[data-cats] [data-cat=use]').click();
    assert.deepEqual(await ids(page),[2000000]);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(`PASS ${mobile?'phone':'desktop'} ${theme}: selected styles, type/job/level combinations, URL reload, 0–20, 70+, reset and categories`);
    await page.close();
  }
} finally {await browser.close();}
