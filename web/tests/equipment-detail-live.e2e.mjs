// Read-only candidate/public regression using real API data and served assets.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { groupEquipmentVariants } from '../../frontend/src/lib/item-market.ts';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.EQUIPMENT_TEST_ORIGIN || 'http://127.0.0.1:18767';
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome'});
try {
  const probe = await browser.newPage();
  const load = async url => {
    const response = await probe.request.get(origin + '/api/v1/catalog/page?' + new URLSearchParams({url}));
    assert.equal(response.status(),200,url);
    return (await response.json()).page;
  };
  let id = Number(process.env.EQUIPMENT_TEST_ITEM || 0);
  if (!id) {
    const search = await load('/search?' + new URLSearchParams({q:'赤仙白宫',kind:'item'}));
    id = search.items.rows[0]?.id;
  }
  assert(id,'an equipment fixture or real catalogue item is required');
  const parentUrl = `/item/${id}?hours=all&lang=zh`;
  const parent = await load(parentUrl);
  const groups = groupEquipmentVariants(parent.market.listings);
  const group = groups.find(row => row.offers.length > 1) || groups[0];
  assert(group,'the selected item has captured equipment offers');
  const selectedId = group.variant.id;
  const childUrl = parentUrl + '&variant=' + selectedId;
  const child = await load(childUrl);
  const expectedIds = new Set(group.offers.map(row => row.variant.id));
  assert.equal(child.selected_variant.id,selectedId);
  assert(child.market.listings.length && child.market.listings.every(row => expectedIds.has(row.variant?.id)));
  assert(child.market.sales.every(row => row.variant && groupEquipmentVariants([{variant:group.variant},row]).length === 1));
  assert.equal(child.stats.listings_count,child.market.listings.length);
  await probe.close();
  for (const width of [375,1280]) {
    const page = await browser.newPage({viewport:{width,height:900},isMobile:width<640,hasTouch:width<640});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+parentUrl);
    const card=page.locator(`[data-equipment-group][href*="variant=${selectedId}"]`);
    await card.waitFor({state:'attached'});
    if(!await card.isVisible())await page.locator('[data-more=equip]').click();
    await card.click();await page.locator('[data-selected-attributes]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('variant'),String(selectedId));
    assert.equal(await page.locator('.item-peek:visible').count(),0,'attribute links navigate directly on touch devices');
    assert.equal(await page.locator('[data-equipment-group]').count(),1);
    assert.equal(await page.locator('[data-offer-filter-open]').count(),1);
    assert.equal(await page.locator('[data-equipment-stat],[data-bonus-only]').count(),0);
    await page.reload();await page.locator('[data-selected-attributes]').waitFor();
    await page.locator('[data-all-attributes]').click();await page.locator('[data-selected-attributes]').waitFor({state:'detached'});
    await page.locator('[data-offer-filter-open]').click();
    const conditions=group.variant.stats.filter(row=>row.value>0).slice(0,2);
    assert.equal(conditions.length,2,'exercise multiple independent stat conditions');
    for(const condition of conditions){
      await page.locator('[data-stat-add]').click();
      const field=page.locator('[data-stat-row]').last();
      await field.locator('[data-stat-key]').selectOption(condition.key);
      await field.locator('[data-stat-min]').fill(String(condition.value));
    }
    const updated=page.waitForResponse(response=>response.url().includes('/api/v1/catalog/page?')&&decodeURIComponent(response.url()).includes('attributes'));
    await page.locator('[data-offer-apply]').click();
    const selected=(await (await updated).json()).page;
    assert(selected.market.listings.length);
    assert(selected.market.listings.every(row=>conditions.every(condition=>row.variant?.stats.some(stat=>stat.key===condition.key&&stat.value>=condition.value))));
    await page.locator('[data-offer-clear="stat:'+conditions[0].key+'"]').waitFor();
    await page.locator('[data-offer-clear=all]').click();
    if(width<640)await page.locator('[data-tab=sales]').click();
    const panel=page.locator(width<640?'[data-pane=sales]':'.sales-well');
    const sale=panel.locator('[data-sale-stats]').first();
    if(await sale.count()){
      assert(await sale.locator('.sale-equipment').isVisible(),'sale stats are visible without a disclosure');
      assert.equal(await panel.locator('details,summary').count(),0);
    }
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);await page.close();
    console.log(`PASS ${origin} ${width}px item ${id}: real attribute-group API/quotes/sales, direct card navigation/reload, one dialog and multiple stats`);
  }
} finally {await browser.close();}
