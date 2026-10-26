import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.ENHANCEMENT_TEST_ORIGIN||'http://127.0.0.1:18769';
const {calculateMixedEnhancement,enhancementMetadata,enhancementQuote,enhancementBaseOptions}=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../js/lib/enhancement.js',import.meta.url))).toString('base64'));
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try{
 for(const width of [375,1280]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width===375,hasTouch:width===375});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('lang','zh');localStorage.setItem('theme','light');});
  const response=await page.request.get(origin+'/api/v1/enhancement/scrolls/1082000');assert.equal(response.status(),200);
  const records=(await response.json()).scrolls;
  assert(records.some(row=>enhancementMetadata(row).successRate===.1));assert(records.some(row=>enhancementMetadata(row).successRate===.6));
  await page.goto(origin+'/tools/enhancement',{waitUntil:'domcontentloaded'});await page.locator('[data-enhance-total]').waitFor();
  const equipmentResponse=await page.request.get(origin+'/api/v1/item/1082000');const market=await equipmentResponse.json();
  assert.equal(await page.locator('.enhancement-page input[type=number]').count(),1,'market prices cannot be edited');
  for(const level of [25,50,70]){
   await page.locator(`[data-enhance-percentile="${level}"]`).click();
   const expected=enhancementQuote(market,5,level/100);
   assert.equal(Number(await page.locator('#enhance-equipment-price').getAttribute('data-price')),expected);
  }
  const choice=enhancementBaseOptions(market,5).find(row=>row.values.length>1);
  if(choice){
   await page.locator('.enhance-base summary').click();
   await page.getByRole('combobox',{name:'添加底材属性',exact:true}).selectOption(choice.key);
   await page.getByRole('combobox',{name:'原始'+choice.zh,exact:true}).selectOption(String(choice.values[0]));
   const expected=enhancementQuote(market,5,.7,{[choice.key]:choice.values[0]});
   assert.equal(Number(await page.locator('#enhance-equipment-price').getAttribute('data-price')),expected);
   await page.getByRole('button',{name:'清除',exact:true}).click();
  }
  await page.locator('[data-enhance-percentile="50"]').click();
  for(const target of [6,7,10,12]){
   await page.locator('#enhance-target').fill(String(target));await page.locator('[data-enhance-total]').waitFor();
   const input=await page.locator('.enhance-scroll-price output').evaluateAll(nodes=>nodes.map(node=>({id:Number(node.id.replace('enhance-scroll-','')),price:Number(node.dataset.price)})));
   const scrolls=input.filter(row=>row.price>0).map(row=>{const info=enhancementMetadata(records.find(record=>record.item_id===row.id));return{...row,gain:info.effects.find(effect=>effect.key==='incPAD').value,successRate:info.successRate};});
   assert(scrolls.some(row=>row.successRate===.1)&&scrolls.some(row=>row.successRate===.6),'both market quotes are available');
   const expected=calculateMixedEnhancement({equipmentPrice:Number(await page.locator('#enhance-equipment-price').getAttribute('data-price')),slots:5,target,scrolls});
   await page.waitForFunction(value=>Math.abs(Number(document.querySelector('[data-enhance-total]')?.dataset.enhanceTotal)-value)<=1e-7*Math.max(1,value),expected.expectedCost);
  }
  assert.equal(await page.locator('[data-nav-key=tools]:visible').getAttribute('aria-current'),'page');
  // Reproduce the reported iPhone search, including blur before the result click.
  const search=page.locator('.enhance-picker input');await search.fill('Vaul');
  const result=page.locator('[data-enhance-choice="1452006"]');await result.waitFor();
  if(width===375){
   await result.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:1,button:0});
   await search.evaluate(node=>node.blur());
   await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
   assert.equal(await result.count(),1,'the Vaulter result survives mobile blur');
   await result.tap();
  }else await result.click();
  await page.waitForFunction(()=>document.querySelector('.enhance-picker .enhance-selected a')?.getAttribute('href')==='/item/1452006');
  await page.locator('#enhance-scroll-2044501').waitFor();
  assert.match(await page.locator('.enhance-quote').first().textContent(),/7 次/);
  assert.equal(await search.inputValue(),'');assert.equal(await page.locator('.enhance-choices').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  if(process.env.ENHANCEMENT_SCREENSHOTS){await mkdir(process.env.ENHANCEMENT_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.ENHANCEMENT_SCREENSHOTS,`enhancement-live-${width}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS ${origin} ${width}px: real percentile prices, original stats, typed plans and Vaul equipment selection after blur`);
 }
}finally{await browser.close();}
