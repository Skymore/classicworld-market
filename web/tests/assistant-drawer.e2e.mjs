// AI assistant drawer: square launcher, drawer next to a page, full screen on phones,
// and the page being viewed sent with the question until removed. No model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const now = Date.now();
const snapshot = {kind:'item', page:{
  item:{id:4010001,name_zh:'青铜母矿',name_en:'Bronze Ore',category:'其他'},
  stats:null,droppers:[],npc_offers:[],npc_sell:null,
  market:{as_of:new Date(now).toISOString(),base_stats:[],days:[],listing_days:[],sale_points:[],sales:[],expired_listings:[],
    listings:Array.from({length:30},(_,i)=>({shop:`Shop ${i}`,channel:i%40+1,room:i%22+1,unit_price:100+i,stock:1,seen_at:new Date(now).toISOString(),variant:null}))},
}};
const requests = [];
const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/v1/events') { res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write(': ready\n\n'); return; }
  if (url.pathname === '/api/v1/catalog/page') return json(res, snapshot);
  if (url.pathname === '/api/v1/account') return json(res, {signed_in:false});
  if (url.pathname === '/api/v1/market/period-default') return json(res, {default_hours:'72'});
  if (url.pathname === '/api/v1/agent/stream') {
    let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
    res.writeHead(200, {'Content-Type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1'});
    const send = (value) => res.write('data: ' + JSON.stringify(value) + '\n\n');
    send({type:'start',messageId:'answer-'+requests.length});send({type:'text-start',id:'a'});
    send({type:'text-delta',id:'a',delta:'青铜母矿现在最低 100。也可以看[铁矿石](/item/4011000)。'});send({type:'text-end',id:'a'});
    send({type:'finish',messageMetadata:{state:'complete'}});return res.end('data: [DONE]\n\n');
  }
  if (url.pathname.startsWith('/api/')) return json(res, {});
  if (url.pathname.startsWith('/web/')) {
    const file = path.resolve(root, '.' + url.pathname.slice(4));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); } return;
  }
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(path.join(root, 'index.html')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--lang=zh-CN'], channel: process.env.PLAYWRIGHT_CHANNEL || undefined});
try {
  // Desktop: launcher, drawer under the header, page context, toggle from the nav.
  {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/item/4010001?lang=zh');
    await page.locator('[data-react-catalogue="item"]').waitFor();
    const fab = page.locator('[data-assistant-open]'), drawer = page.locator('[data-assistant-drawer]');
    assert.equal(await drawer.count(), 0, 'the assistant loads only when opened');
    assert.equal(await page.locator('.dnav [data-nav-key=agent] svg').count(), 0, 'the header entry is text only');
    assert.equal(await fab.locator('svg').count(), 1, 'the launcher carries the icon');
    const box = await fab.boundingBox(), width = await page.evaluate(() => document.querySelector('.dhead').getBoundingClientRect().right); // excludes the scrollbar gutter
    assert.deepEqual([box.width, box.height, width - box.x - box.width, 900 - box.y - box.height], [56, 56, 24, 24], 'square launcher sits bottom right');
    await fab.click();
    const input = drawer.locator('textarea'); await input.waitFor();
    assert.equal(await fab.count(), 0, 'the launcher hides while the drawer is open');
    const head = await page.locator('.dhead').boundingBox(), panel = await drawer.boundingBox();
    assert.deepEqual([panel.y, panel.x + panel.width, panel.width, panel.y + panel.height], [head.y + head.height, width, 420, 900], 'drawer fills the right edge under the header');
    assert.equal(await input.evaluate((node) => node === document.activeElement), true, 'desktop focuses the question box');
    const chip = drawer.locator('[data-page-context=item]');
    assert.equal((await chip.textContent()).trim(), '关于本页：青铜母矿');
    await input.fill('这个现在多少钱？'); await drawer.locator('button[type=submit]').click();
    await drawer.locator('.chat-assistant').filter({hasText: '最低 100'}).waitFor();
    assert.deepEqual(requests[0].page, {kind:'item', id:4010001, label:'青铜母矿'}, 'the viewed item goes with the question');
    assert.equal(await drawer.locator('.chat-assistant .chat-message-label').textContent(), 'AI 助手');
    await chip.locator('button').click();
    assert.equal(await chip.count(), 0, 'the page can be removed from the question');
    await input.fill('那铁矿石呢？'); await drawer.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-assistant-drawer] .chat-assistant').length === 2);
    assert.equal(requests[1].page, undefined, 'a removed page is not sent');
    assert.equal(await drawer.locator('[aria-label="在整页打开"]').count(), 0, 'guest chats are not saved, so they cannot move to the full page');
    await drawer.getByRole('button', {name: '关闭'}).click();
    assert.equal(await drawer.isHidden(), true); await fab.waitFor();
    const nav = page.locator('.dnav [data-nav-key=agent]');
    assert.equal(await nav.getAttribute('aria-expanded'), 'false');
    await nav.click(); await input.waitFor();
    assert.equal(new URL(page.url()).pathname, '/item/4010001', 'the nav opens the drawer in place');
    assert.equal(await drawer.locator('.chat-assistant').count(), 2, 'the conversation survives closing the drawer');
    assert.equal(await nav.getAttribute('aria-expanded'), 'true');
    await nav.click(); assert.equal(await drawer.isHidden(), true, 'the nav also closes it');
    await page.goto(origin + '/agent?lang=zh'); await page.locator('[data-agent-chat]').waitFor();
    assert.equal(await page.locator('[data-assistant-open], [data-assistant-drawer]').count(), 0, 'the full page replaces the launcher and drawer');
    assert.equal(await page.locator('[data-agent-chat] h1').textContent(), 'AI 助手');
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Phone: the dock tab opens the assistant full screen, over the dock.
  {
    const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/item/4010001?lang=zh');
    await page.locator('[data-react-catalogue="item"]').waitFor();
    assert.equal(await page.locator('[data-assistant-open]').isVisible(), false, 'phones use the dock, not a floating button');
    const tab = page.locator('.dock [data-nav-key=agent]');
    assert.equal((await tab.textContent()).trim(), 'AI 助手');
    await tab.click();
    const drawer = page.locator('[data-assistant-drawer]'); await drawer.locator('textarea').waitFor();
    assert.deepEqual(Object.values(await drawer.boundingBox()), [0, 0, 390, 844], 'full screen');
    assert.equal(await page.evaluate(() => document.elementFromPoint(195, 820).closest('[data-assistant-drawer]') !== null), true, 'the sheet covers the dock');
    assert.equal(await drawer.locator('textarea').evaluate((node) => node === document.activeElement), false, 'no keyboard pops up on open');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const item = () => new URL(page.url()).pathname, marked = () => page.evaluate(() => !!history.state?.assistant);
    // The system back button closes the sheet and stays on the page.
    await page.evaluate(() => history.back());
    await drawer.waitFor({state: 'hidden'});
    assert.equal(item(), '/item/4010001', 'back closes the assistant, not the page');
    // The close button takes its history entry with it.
    await tab.click(); await drawer.locator('textarea').waitFor();
    assert.equal(await marked(), true);
    await drawer.getByRole('button', {name: '关闭'}).click();
    await drawer.waitFor({state: 'hidden'});
    await page.waitForFunction(() => !history.state?.assistant);
    // A link in an answer shows its page; back returns to the assistant, then to the page.
    await tab.click(); await drawer.locator('textarea').fill('青铜母矿多少钱？');
    await drawer.locator('button[type=submit]').click();
    // Phones preview an item link first; the preview sits above the assistant.
    const link = drawer.locator('.chat-assistant a[href="/item/4011000"]'), peek = page.locator('.item-peek');
    const state = () => page.evaluate(() => [!!history.state?.assistant, !!history.state?.preview]);
    await link.click(); await peek.waitFor();
    assert.equal(await peek.evaluate((node) => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'the item preview is above the assistant');
    // Back closes the preview first and leaves the assistant open.
    await page.evaluate(() => history.back());
    await peek.waitFor({state: 'hidden'});
    await page.waitForFunction(() => !history.state?.preview);
    assert.equal(await drawer.isVisible(), true, 'back closes the preview, not the assistant');
    assert.deepEqual(await state(), [true, false]);
    // Closing the preview takes its history entry with it.
    await link.click(); await peek.waitFor();
    await peek.locator('.peek-close').click(); await peek.waitFor({state: 'hidden'});
    await page.waitForFunction(() => !history.state?.preview);
    assert.equal(await drawer.isVisible(), true);
    // Following the preview's link replaces its entry and shows the page.
    await link.click(); await peek.locator('.peek-footer a').click();
    await drawer.waitFor({state: 'hidden'}); await peek.waitFor({state: 'hidden'});
    await page.waitForURL((url) => url.pathname === '/item/4011000');
    await page.evaluate(() => history.back());
    await drawer.locator('textarea').waitFor();
    assert.equal(item(), '/item/4010001');
    assert.equal(await drawer.locator('.chat-assistant').count(), 1, 'the conversation is still there');
    await page.evaluate(() => history.back());
    await drawer.waitFor({state: 'hidden'});
    assert.equal(item(), '/item/4010001');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('assistant drawer e2e passed');
} finally {
  await browser.close(); server.closeAllConnections?.(); server.close();
}
