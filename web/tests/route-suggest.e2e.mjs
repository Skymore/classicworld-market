// The map page's links on one row, map views without the scene/minimap
// switch, and the route page's map and monster suggestions, against the
// built React pages with an isolated server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const streams = new Set(), catalog = [], images = [];
const json = (res, data) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const ref = (id, zh, en) => ({ id, names: { zh, en } });
const HENESYS = ref(10001000, '射手村', 'Henesys'), TOWN = ref(10000000, '蘑菇村', 'Mushroom Town');
const SCENE = '/web/images/scenes/10004140.webp', MINIMAP = '/web/images/minimaps/10002031.png';
// The minimap of the maps that have a scene: never drawn, so never requested.
const UNDER_SCENE = '/web/images/minimaps/10004140.png';
const view = (scene) => ({
  width: 1000, height: 600, shown_width: 600, shown_height: 360, icon: 60,
  image_url: scene ? UNDER_SCENE : MINIMAP,
  scene: scene ? { url: SCENE, x: 0, y: 0, width: 1000, height: 600, px: 1000 } : null,
  spawns: [{ mob_id: 100100, x: 500, y: 400, mob_time: 0 }],
  portals: [{ x: 100, y: 500, to: TOWN, portal_type: null }],
  npcs: [{ npc: { id: 7, names: { zh: '希娜', en: 'Sera' } }, x: 300, y: 500 }],
  player_spawn: null,
});
const maps = [
  { ...HENESYS, street: { zh: '金银岛', en: 'Victoria Road' } },
  { ...ref(10001100, '射手村民宅', 'Henesys Townstreet'), street: { zh: '金银岛', en: 'Victoria Road' } },
  { ...ref(10001200, '射手训练场Ⅰ', 'Henesys Hunting Ground I'), street: { zh: '金银岛', en: 'Victoria Road' } },
  { ...TOWN, street: { zh: '彩虹岛', en: 'Maple Island' },
    hint: { zh: '通往 蘑菇镇 - 西入口', en: 'Next to Mushroom Town - West Entrance' } },
  // A second map of the same name: the server's hint tells the two apart.
  { ...ref(10000200, '蘑菇村', 'Mushroom Town'), street: { zh: '彩虹岛', en: 'Maple Island' },
    hint: { zh: '通往 蘑菇村村民家', en: 'Next to Mushroom Town Townstreet' } },
  { ...ref(10000100, '蘑菇山', 'Mushroom Garden'), street: { zh: '彩虹岛', en: 'Maple Island' } },
];
const mobs = [
  { ...ref(120100, '蘑菇仔', 'Shroom'), level: 3, image_id: null },
  { ...ref(1210102, '花蘑菇', 'Orange Mushroom'), level: 8, image_id: null },
];
function snapshot(target) {
  const kind = target.pathname.split('/')[1], id = Number(target.pathname.split('/').at(-1));
  const q = target.searchParams;
  if (kind === 'map') {
    const scene = id !== 10002031;
    return { kind, page: {
      map: { id, names: { zh: '第1军营', en: 'Camp 1' }, street: { zh: '金银岛', en: 'Victoria Road' }, is_town: false, mob_rate: 1 },
      return_map: ref(10002000, '勇士部落', 'Perion'), world_spot: 'WorldMap001.img:10', from_henesys: null,
      view: view(scene), mobs: [{ mob: mobs[0], spawn_count: 1 }], npcs: [], exits: [], entrances: [], quests_given: [], quests_hunted: [],
    } };
  }
  if (kind === 'route') {
    const mobMode = q.get('mode') === 'mob' || q.has('mob');
    const step = (i) => ({ from: ref(20000 + i, `第${i}站`, `Stop ${i}`), to: ref(20001 + i, `第${i + 1}站`, `Stop ${i + 1}`), kind: 'portal', portal_name: 'east00', exit: { x: 900, y: 500 }, arrival: { x: 100, y: 500 }, exit_hidden: false, npc: null, view: view(i !== 3) });
    const found = { from: HENESYS, to: TOWN, steps: Array.from({ length: 6 }, (_, i) => step(i)), overview: null };
    return { kind, page: {
      from_input: q.get('from') || '', to_input: q.get('to') || '', mob_input: q.get('mob') || '', mob_mode: mobMode, taxi: false,
      outcome: q.get('to') ? { Found: found } : 'Form',
    } };
  }
  const text = q.get('q') || '';
  const hit = (row) => row.names.zh.includes(text) || row.names.en.toLowerCase().includes(text.toLowerCase());
  return { kind: 'search', page: { query: text, kind: q.get('kind'), region: '', area: '', areas: [], filters: {}, offset: 0,
    items: { rows: [], more: false },
    mobs: { rows: q.get('kind') === 'mob' ? mobs.filter(hit) : [], more: false },
    maps: { rows: q.get('kind') === 'map' ? maps.filter(hit) : [], more: false } } };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname === '/api/v1/catalog/page') {
    catalog.push(url.searchParams.get('url'));
    return json(res, snapshot(new URL(url.searchParams.get('url'), 'http://localhost')));
  }
  if (url.pathname === '/api/v1/account') return json(res, { signed_in: false });
  if (url.pathname.startsWith('/api/')) return json(res, {});
  if (url.pathname.startsWith('/web/images/')) images.push(url.pathname);
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' }[path.extname(file)] || 'text/html; charset=utf-8';
    res.setHeader('Content-Type', type);
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const lastRoute = () => [...catalog].reverse().find((u) => u.startsWith('/route?'));
try {
  browser = await chromium.launch();
  // Map page: three links on one row at phone and desktop widths, no scene switch.
  for (const width of [320, 360, 390, 1280]) {
    const phone = width < 641;
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/map/10004140?lang=zh');
    await page.locator('[data-react-catalogue=map] .map-actions').waitFor();
    const row = await page.locator('.map-actions').evaluate((el) => {
      const box = el.getBoundingClientRect(), kids = [...el.children].map((c) => c.getBoundingClientRect());
      return { tops: new Set(kids.map((k) => Math.round(k.top))).size, inside: kids.every((k) => k.left >= box.left - 0.5 && k.right <= box.right + 0.5), labels: [...el.children].map((c) => c.innerText.replace(/\s+/g, ' ')), scroll: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(row.tops, 1, `${width}px: the map links share one row`);
    assert(row.inside && !row.scroll, `${width}px: the links stay inside the page`);
    assert.equal(row.labels[0], '从射手村怎么走');
    assert.equal(row.labels[1], '回城点 勇士部落');
    assert.equal(row.labels[2], phone ? '世界地图' : '在世界地图上看');
    assert.equal(await page.locator('.map-actions .btn.primary').count(), 1, 'the route link stays the red one');
    // A map with a scene shows it; the toolbar keeps only the layer toggles.
    await page.locator('figure.mapvis .mv-scene img').waitFor();
    assert.equal(await page.locator('figure.mapvis .mv-img').count(), 0, 'no minimap under the scene');
    assert.equal(await page.locator('.mv-seg').count(), 0);
    assert.deepEqual(await page.locator('.mv-tools button').evaluateAll((b) => b.map((x) => x.firstChild.textContent.trim())), ['怪物', '传送口', 'NPC']);
    assert.equal(await page.getByRole('button', { name: '小地图' }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A map without a scene: the minimap is its only picture.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(origin + '/map/10002031');
    await page.locator('figure.mapvis .mv-img').waitFor();
    assert.equal(await page.locator('figure.mapvis .mv-scene').count(), 0);
    assert.equal(await page.locator('.mv-seg').count(), 0);
    await context.close();
  }
  // Route steps after the first: an empty background until near the screen, then the scene.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    images.length = 0;
    await page.goto(origin + `/route?from=10001000&to=10000000`);
    await page.locator('.steps .step figure.mapvis').first().waitFor();
    await page.locator('.steps .step figure.mapvis').first().locator('.mv-scene img').waitFor();
    const figures = page.locator('.steps .step figure.mapvis');
    assert.equal(await figures.count(), 6);
    const last = figures.nth(5);
    assert.equal(await last.locator('.mv-scene, .mv-img').count(), 0, 'a far step shows only its background');
    assert.equal(await last.locator('.mv-bg').count(), 1);
    assert(!images.includes(UNDER_SCENE), 'deferred steps never load the minimap first');
    await last.scrollIntoViewIfNeeded();
    await last.locator('.mv-scene img').waitFor();
    assert.equal(await last.locator('.mv-img').count(), 0);
    // The step without a scene still shows its minimap.
    await figures.nth(3).scrollIntoViewIfNeeded();
    await figures.nth(3).locator('.mv-img').waitFor();
    assert.equal(await page.locator('.steps .mv-img').count(), 1, 'only the scene-less step draws the minimap');
    assert(!images.includes(UNDER_SCENE));
    await context.close();
  }
  // Route form on a phone: suggestions while typing, arrow keys, Enter, taps.
  {
    const context = await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/route?lang=zh');
    await page.locator('[data-react-catalogue=route] .route-form').waitFor();
    catalog.length = 0;
    const from = page.locator('.route-form input[name=from]');
    assert.equal(await from.evaluate((el) => getComputedStyle(el).fontSize), '16px', 'phone fields are 16px');
    await from.tap();
    await page.keyboard.type('射手');
    const fromList = page.locator('.place-field').first().locator('[role=listbox]');
    await fromList.locator('[role=option]').first().waitFor();
    const options = await fromList.locator('[role=option]').allInnerTexts();
    assert.equal(options.length, 3, 'only matching maps');
    assert(options[0].includes('射手村') && options[0].includes('Henesys'), 'Chinese and English names');
    assert(catalog.some((u) => u.startsWith('/search?') && new URLSearchParams(u.split('?')[1]).get('kind') === 'map'), 'map fields search maps only');
    const geometry = await page.locator('.place-field').first().locator('.quick-search').evaluate((box) => {
      const r = box.getBoundingClientRect(), dock = document.querySelector('.dock')?.getBoundingClientRect();
      return { bottom: r.bottom, limit: Math.min(innerHeight, dock && dock.height ? dock.top : innerHeight) };
    });
    assert(geometry.bottom <= geometry.limit + 0.5, `the list ends above the dock (${geometry.bottom} > ${geometry.limit})`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    const selected = fromList.locator('[aria-selected=true]');
    assert.equal(await selected.count(), 1);
    assert.equal(await selected.getAttribute('id'), await from.getAttribute('aria-activedescendant'));
    assert((await selected.innerText()).includes('射手村'));
    await page.keyboard.press('Enter');
    assert.equal(await from.inputValue(), '射手村');
    assert(await fromList.isHidden(), 'Enter chooses and closes the list');
    assert.equal(lastRoute(), undefined, 'choosing does not submit the form');
    const to = page.locator('.route-form input[name=to]');
    await to.tap();
    await page.keyboard.type('蘑菇');
    const toList = page.locator('.place-field').nth(1).locator('[role=listbox]');
    const towns = toList.getByRole('option', { name: /蘑菇村/ });
    await towns.nth(1).waitFor();
    assert.deepEqual((await towns.allInnerTexts()).map((t) => (t.includes('西入口') ? 'west' : t.includes('村民家') ? 'east' : t)),
      ['west', 'east'], 'maps of one name show what tells them apart');
    await towns.filter({ hasText: '西入口' }).tap();
    assert.equal(await to.inputValue(), '蘑菇村');
    assert(await toList.isHidden());
    await page.locator('.route-form button[type=submit]').tap();
    await page.waitForFunction(() => document.querySelector('.steps .step'));
    assert.equal(lastRoute(), '/route?from=10001000&to=10000000', 'the query uses the chosen maps');
    // Escape closes; typing again reopens.
    await to.tap();
    await to.fill('');
    await page.keyboard.type('蘑菇');
    await toList.locator('[role=option]').first().waitFor();
    await page.keyboard.press('Escape');
    assert(await toList.isHidden());
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Monster mode on a desktop: suggestions are monsters, chosen with the mouse.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(origin + '/route?mode=mob&lang=zh');
    await page.locator('[data-react-catalogue=route] input[name=mob]').waitFor();
    const mob = page.locator('.route-form input[name=mob]');
    await mob.click();
    await page.keyboard.type('蘑菇');
    const list = page.locator('.place-field').nth(1).locator('[role=listbox]');
    await list.locator('[role=option]').first().waitFor();
    assert.deepEqual((await list.locator('[role=option] b').allInnerTexts()), ['蘑菇仔', '花蘑菇']);
    assert((await list.locator('[role=option]').nth(1).innerText()).includes('Lv.8'));
    await list.getByRole('option', { name: /花蘑菇/ }).click();
    assert.equal(await mob.inputValue(), '花蘑菇');
    assert(await mob.evaluate((el) => document.activeElement === el), 'focus stays in the field');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 50 && !lastRoute()?.includes('mob='); i++) await page.waitForTimeout(100);
    const query = new URLSearchParams(lastRoute().split('?')[1]);
    assert.equal(query.get('mob'), '1210102', 'the query uses the chosen monster');
    await context.close();
  }
  console.log('PASS map links on one row (320/360/390/1280), scene-only map views, deferred route steps, route suggestions (keys, taps, mouse, phone fit)');
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await new Promise((resolve) => server.close(resolve));
}
