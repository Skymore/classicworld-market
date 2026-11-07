// Web Push on the website (WEB_PUSH.md), with stubbed service worker, PushManager,
// Notification and push API. The page is served as http://market.test (mapped to
// 127.0.0.1 and treated as secure) because 127.0.0.1 is the collector's local
// gateway, which never offers push.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const shots = process.env.WEB_PUSH_SCREENSHOT_DIR;
const { mergeShopOffers } = await import('data:text/javascript,' + encodeURIComponent(await readFile(path.join(root, 'js/lib/quote-groups.js'), 'utf8')));

const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
const keyBytes = [4, ...Buffer.from(jwk.x, 'base64url'), ...Buffer.from(jwk.y, 'base64url')];
const PUBLIC_KEY = Buffer.from(keyBytes).toString('base64url');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/fixture-endpoint';
const CSRF = 'csrf-fixture-token';
const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const now = () => Date.now() / 1000;
const products = [{ item_id: 2000000, name_zh: '测试药水', name_en: 'Test Potion', category: '消耗品', typical: 100 }];
const offer = (id, unit_price) => ({ id, item_id: 2000000, unit_price, stock: 5, bundle: 1, observed: now(), shop: id, location: { channel: 3, room: 2 } });

let state, posts, streams = new Set(), revision = 0;
function reset(patch = {}) {
  state = { signedIn: true, enabled: true, subscriptions: [], nextId: 7, testError: null, shared: [], ...patch };
  posts = [];
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const account = () => state.signedIn
  ? { signed_in: true, public_id: 'p'.repeat(24), username: 'maple', has_password: true, google_enabled: false, nickname: '枫叶玩家', csrf: CSRF, stats: {} }
  : { signed_in: false, google_enabled: false };
const watchRecords = () => [{ kind: 'watch', key: '2000000', value: { cap: 100, notify: true, position: 0 }, version: 1 }];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, action = url.pathname.replace('/api/v1/account/', '');
    posts.push({ action, body, csrf: req.headers['x-csrf-token'] });
    if (action === 'logout') { state.signedIn = false; state.subscriptions = []; return json(res, { ok: true }); }
    // A password change replaces every session, and their subscriptions go with them.
    if (action === 'password') { state.subscriptions = []; return json(res, { ok: true }); }
    if (action === 'data') return json(res, { records: watchRecords() });
    if (!action.startsWith('push/')) return json(res, { ok: true });
    if (!state.signedIn) return json(res, { error: 'login_required' }, 401);
    if (req.headers['x-csrf-token'] !== CSRF) return json(res, { error: 'invalid_request' }, 403);
    if (action === 'push/subscribe') {
      const id = state.nextId++;
      state.subscriptions = [...state.subscriptions.filter(row => row.endpoint !== body.endpoint), { id, endpoint: body.endpoint, label: body.label, lang: body.lang, created_at: new Date().toISOString(), last_sent_at: null }];
      return json(res, { id });
    }
    if (action === 'push/unsubscribe') { state.subscriptions = state.subscriptions.filter(row => row.id !== body.id && row.endpoint !== body.endpoint); return json(res, { ok: true }); }
    if (action === 'push/test') {
      if (state.testError === 'push_expired') { state.subscriptions = state.subscriptions.filter(row => row.id !== body.id); return json(res, { error: 'push_expired' }, 410); }
      return json(res, { ok: true });
    }
    return json(res, { error: 'invalid_request' }, 400);
  }
  if (url.pathname === '/api/v1/account') return json(res, account());
  if (url.pathname === '/api/v1/account/data') return state.signedIn ? json(res, { records: watchRecords() }) : json(res, { error: 'login_required' }, 401);
  if (url.pathname === '/api/v1/account/devices') return json(res, { devices: [] });
  if (url.pathname === '/api/v1/account/push') return state.signedIn ? json(res, { subscriptions: state.subscriptions.map(({ endpoint, ...row }) => row) }) : json(res, { error: 'login_required' }, 401);
  if (url.pathname === '/api/v1/push/config') return json(res, state.enabled ? { enabled: true, public_key: PUBLIC_KEY } : { enabled: false });
  if (url.pathname === '/api/v1/market') return json(res, { products, as_of: now() });
  if (url.pathname === '/api/v1/market/period-default') return json(res, { default_hours: 'all' });
  if (url.pathname === '/api/v1/watchlist/catalog') return json(res, { items: products, presets: [] });
  if (url.pathname === '/api/v1/watchlist/listings') {
    const grouped = mergeShopOffers(state.shared);
    return json(res, { listings: state.shared, grouped_listings: grouped.map(({ merged_ids, ...row }) => row), percentile_caps: {}, base_stats: {}, generated_at: now(), revision, truncated: false });
  }
  if (url.pathname.startsWith('/api/')) return json(res, {});
  const file = url.pathname.startsWith('/web/') ? path.resolve(root, '.' + url.pathname.slice(4)) : path.join(root, 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  try { res.setHeader('Content-Type', types[path.extname(file)] || 'text/html; charset=utf-8'); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://market.test:${server.address().port}`;
const lastPush = () => posts.filter(row => row.action.startsWith('push/')).at(-1);
const emit = () => { revision++; for (const stream of streams) stream.write('event: market\ndata: {}\n\n'); };

/** Browser capabilities for one context. The stub keeps its state in localStorage across navigations. */
function stub({ worker = true, pushManager = true, notification = true, permission = 'default' }) {
  return page => page.addInitScript(({ worker, pushManager, notification, permission, ENDPOINT }) => {
    if (!localStorage.getItem('stub.seeded')) {
      localStorage.setItem('stub.seeded', '1');
      localStorage.setItem('stub.permission', permission);
      localStorage.setItem('uiLang', 'zh');
      localStorage.setItem('watchlist', '[2000000]');
      localStorage.setItem('watchlist_settings', JSON.stringify({ 2000000: { cap: 100, notify: true } }));
      localStorage.setItem('watch.listCollapsed', 'true');
    }
    const log = window.pushLog = { shown: [], constructed: [], subscribed: [], registered: [], requests: 0, unsubscribed: 0, toasts: 0 };
    document.addEventListener('market-toast', () => log.toasts++);
    delete Navigator.prototype.serviceWorker;
    delete window.PushManager;
    delete window.Notification;
    if (notification) window.Notification = class {
      static get permission() { return localStorage.getItem('stub.permission'); }
      static async requestPermission() { log.requests++; localStorage.setItem('stub.permission', 'granted'); return 'granted'; }
      constructor(title, options) { log.constructed.push({ title, ...options }); }
    };
    if (pushManager) window.PushManager = function PushManager() {};
    if (!worker) return;
    const subscription = endpoint => ({
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: 'BPnN2bh2ZYUkPKb0jq7bfwA', auth: 'tBHItJI5svbpez7KI4CCXg' } }),
      unsubscribe: async () => { log.unsubscribed++; localStorage.removeItem('stub.subscription'); return true; },
    });
    const registration = {
      scope: location.origin + '/', active: { state: 'activated' },
      pushManager: {
        getSubscription: async () => { const endpoint = localStorage.getItem('stub.subscription'); return endpoint ? subscription(endpoint) : null; },
        subscribe: async options => {
          log.subscribed.push({ userVisibleOnly: options.userVisibleOnly, key: Array.from(options.applicationServerKey) });
          localStorage.setItem('stub.subscription', ENDPOINT);
          return subscription(ENDPOINT);
        },
      },
      showNotification: async (title, options) => { log.shown.push({ title, ...options }); },
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      register: async (url, options) => { log.registered.push([url, options?.scope]); return registration; },
      ready: Promise.resolve(registration), getRegistration: async () => registration,
      addEventListener() {}, removeEventListener() {},
    } });
  }, { worker, pushManager, notification, permission, ENDPOINT });
}

let browser;
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const log = page => page.evaluate(() => window.pushLog);
// Controls live in 我的 → 通知; its header shows the state. Watch keeps a one-line pointer.
const bar = page => page.locator('[data-setting=notifications] .watch-notification-bar');
const meta = page => page.locator('[data-setting=notifications] summary small');
const pointer = page => page.locator('.watch-page .watch-notification-bar');
async function fits(page, label) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no horizontal overflow`);
}
async function shot(page, name, viewport) {
  if (!shots) return;
  await page.screenshot({ path: path.join(shots, `${name}-${viewport}.png`) });
}
async function open(viewport, capabilities, userAgent) {
  const mobile = viewport === 'phone';
  const context = await browser.newContext({
    viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile,
    userAgent: userAgent || (mobile ? UA.android : UA.windows),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await stub(capabilities)(page);
  return { page, context, errors };
}
async function watchState(page, expected) {
  await page.goto(origin + '/account?lang=zh#notifications');
  await page.locator(`[data-setting=notifications][open] [data-notification-state="${expected}"]`).waitFor({ state: "attached" });
}
// The watch page names the problem and links to 我的 → 通知, with no controls of its own.
async function pointsToSettings(page, expected, text) {
  await page.goto(origin + '/watch?lang=zh');
  await pointer(page).and(page.locator(`[data-notification-state="${expected}"]`)).waitFor();
  assert.equal(await pointer(page).locator('.watch-notification-state').innerText(), text);
  assert.equal(await pointer(page).locator('a[href="/account#notifications"]').count(), 1);
  assert.equal(await pointer(page).locator('button').count(), 0);
}
async function alertOnce(page, id) {
  const before = (await log(page)).toasts;
  state.shared = [offer(id, 60)];
  emit();
  await page.waitForFunction(count => window.pushLog.toasts > count, before);
  await page.waitForTimeout(200);
  const seen = await log(page);
  while (await page.locator('[data-toast-close]').count()) await page.locator('[data-toast-close]').first().click();
  return seen;
}

try {
  if (shots) await mkdir(shots, { recursive: true });
  browser = await chromium.launch({ args: ['--lang=zh-CN'], 
    // The headless shell ignores the secure-origin flag; full Chromium honours it.
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chromium',
    args: ['--host-resolver-rules=MAP market.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${origin}`],
  });
  for (const viewport of ['desktop', 'phone']) {
    // Signed out: status text only.
    reset({ signedIn: false });
    let { page, context, errors } = await open(viewport, {});
    await pointsToSettings(page, 'signed-out', '登录后可开启推送');
    assert(await page.evaluate(() => isSecureContext), 'market.test is treated as a secure origin');
    await page.waitForFunction(() => window.pushLog.registered.length);
    assert.deepEqual((await log(page)).registered, [['/sw.js', '/']], 'the worker registers after load');
    await fits(page, 'signed out'); await shot(page, 'signed-out', viewport);
    await page.goto(origin + '/watch?lang=zh&embed=1');
    await page.waitForFunction(() => document.documentElement.dataset.embed === '1');
    await frames(page);
    assert.deepEqual((await log(page)).registered, [], 'embedded pages never register the worker');
    assert.deepEqual(errors, []); await context.close();

    // iOS Safari outside a Home Screen app has no PushManager.
    reset();
    ({ page, context, errors } = await open(viewport, { worker: true, pushManager: false, notification: false }, viewport === 'phone' ? UA.iphone : UA.ipad));
    await watchState(page, 'home-screen');
    assert.equal(await meta(page).innerText(), '在 Safari 点分享 → 添加到主屏幕，从主屏幕打开后开启');
    assert.equal(await bar(page).locator('button').count(), 0);
    await fits(page, 'iOS'); await shot(page, 'ios-home-screen', viewport);
    assert.deepEqual(errors, []); await context.close();

    // A browser without a worker or PushManager. Alerts fall back to new Notification.
    reset();
    ({ page, context, errors } = await open(viewport, { worker: false, pushManager: false, permission: 'granted' }));
    await watchState(page, 'unsupported');
    assert.equal(await meta(page).innerText(), '此浏览器不支持推送');
    assert.equal(await bar(page).locator('button').count(), 0);
    await fits(page, 'unsupported'); await shot(page, 'unsupported', viewport);
    let seen = await alertOnce(page, 'fallback-offer');
    assert.deepEqual(seen.constructed.map(row => [row.tag, row.data.url, row.icon]), [['fallback-offer', '/item/2000000', '/web/icons/icon-192.png']]);
    assert.deepEqual(errors, []); await context.close();

    // The server has no push key.
    reset({ enabled: false });
    ({ page, context, errors } = await open(viewport, {}));
    await watchState(page, 'unsupported');
    assert.equal(await meta(page).innerText(), '此浏览器不支持推送');
    assert.equal(await bar(page).locator('button').count(), 0, 'no button while the server has push off');
    await fits(page, 'server off'); await shot(page, 'server-disabled', viewport);
    assert.deepEqual(errors, []); await context.close();

    // Blocked in site settings.
    reset();
    ({ page, context, errors } = await open(viewport, { permission: 'denied' }));
    await watchState(page, 'blocked');
    assert.equal(await meta(page).innerText(), '已被阻止，请在浏览器或系统设置里允许');
    assert.equal(await bar(page).locator('button').count(), 0);
    await pointsToSettings(page, 'blocked', '已被阻止，请在浏览器或系统设置里允许');
    await fits(page, 'blocked'); await shot(page, 'blocked', viewport);
    assert.deepEqual(errors, []); await context.close();

    // Off -> on -> test -> alert without a page notification -> off.
    reset();
    ({ page, context, errors } = await open(viewport, {}));
    await watchState(page, 'off');
    assert.equal(await page.evaluate(() => window.pushLog.requests), 0, 'permission is never requested automatically');
    await fits(page, 'off'); await shot(page, 'off', viewport);
    await page.locator('[data-push-enable]').click();
    await page.locator('[data-notification-state="on"]').waitFor();
    seen = await log(page);
    assert.equal(seen.requests, 1);
    assert.deepEqual(seen.subscribed, [{ userVisibleOnly: true, key: keyBytes }]);
    const subscribe = posts.filter(row => row.action === 'push/subscribe');
    assert.deepEqual(subscribe, [{ action: 'push/subscribe', csrf: CSRF, body: {
      endpoint: ENDPOINT, keys: { p256dh: 'BPnN2bh2ZYUkPKb0jq7bfwA', auth: 'tBHItJI5svbpez7KI4CCXg' },
      label: viewport === 'phone' ? 'Android Chrome' : 'Windows Edge', lang: 'zh',
    } }]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('push.subscription')).id), 7);
    assert.equal(await meta(page).innerText(), '推送已开启');
    await page.locator('[data-push-test]').click();
    await bar(page).getByText('已发送测试推送').waitFor();
    assert.deepEqual(lastPush(), { action: 'push/test', csrf: CSRF, body: { id: 7 } });
    await fits(page, 'on'); await shot(page, 'on', viewport);
    seen = await alertOnce(page, 'pushed-offer');
    assert.deepEqual([seen.shown, seen.constructed], [[], []], 'a subscribed browser leaves system notifications to push');
    await page.reload();
    await page.locator('[data-notification-state="on"]').waitFor();
    await page.locator('[data-push-disable]').click();
    await page.locator('[data-notification-state="off"]').waitFor();
    assert.deepEqual(lastPush(), { action: 'push/unsubscribe', csrf: CSRF, body: { id: 7 } });
    assert.equal((await log(page)).unsubscribed, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('push.subscription')), null);
    // Off but allowed: watch alerts use the worker's showNotification (Android needs it).
    seen = await alertOnce(page, 'page-offer');
    assert.deepEqual(seen.shown.map(row => [row.title, row.tag, row.data.url, row.badge]), [['关注物品有新报价', 'page-offer', '/item/2000000', '/web/icons/badge-96.png']]);
    assert.deepEqual(seen.constructed, []);
    // An expired subscription found by the test button turns push off.
    await page.locator('[data-push-enable]').click();
    await page.locator('[data-notification-state="on"]').waitFor();
    state.testError = 'push_expired';
    await page.locator('[data-push-test]').click();
    await page.locator('[data-notification-state="off"]').waitFor();
    assert.equal(await bar(page).locator('[role=status]').innerText(), '推送已失效，请重新开启');
    await shot(page, 'expired', viewport);
    assert.deepEqual(errors, []); await context.close();

    // Account page: list, current browser, removal, then sign-out unsubscribes first.
    reset();
    ({ page, context, errors } = await open(viewport, {}));
    await watchState(page, 'off');
    await page.locator('[data-push-enable]').click();
    await page.locator('[data-notification-state="on"]').waitFor();
    state.subscriptions.unshift({ id: 3, endpoint: 'https://web.push.apple.com/other', label: 'iPhone', lang: 'zh', created_at: new Date(Date.now() - 2 * 86400e3).toISOString(), last_sent_at: new Date(Date.now() - 3600e3).toISOString() });
    await page.goto(origin + '/account?lang=zh');
    await page.locator('[data-setting=devices] summary').click();
    await page.locator('[data-push-row="3"]').waitFor();
    assert.match(await page.locator('[data-push-row="3"]').innerText(), /iPhone[\s\S]*开启于 2天前 · 最近推送 1小时前/);
    assert.match(await page.locator('[data-push-row="7"] b').innerText(), /^(Android Chrome|Windows Edge) · 这台浏览器$/);
    assert.equal(await page.locator('[data-push-row="3"] [data-push-current]').count(), 0);
    await fits(page, 'account push list');
    await page.locator('[data-push-list]').evaluate(list => list.scrollIntoView({ block: 'center' }));
    await shot(page, 'account-push-list', viewport);
    await page.locator('[data-push-remove="3"]').click();
    await page.locator('[data-push-row="3"]').waitFor({ state: 'detached' });
    assert.deepEqual(lastPush(), { action: 'push/unsubscribe', csrf: CSRF, body: { id: 3 } });
    assert.equal((await log(page)).unsubscribed, 0, 'removing another device keeps this browser subscribed');
    // Changing the password here keeps push on for this browser: the same endpoint is registered again.
    await page.locator('[data-setting=security] > summary').click();
    await page.locator('#account-current-password').fill('a long unique maple passphrase');
    await page.locator('[data-setting=security] details > summary').click();
    await page.locator('[data-password] [name=password]').fill('another long maple passphrase');
    await page.locator('[data-password] [name=confirm_password]').fill('another long maple passphrase');
    await page.locator('[data-password] button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('push.subscription') || 'null')?.id === 8);
    assert.deepEqual(lastPush().action, 'push/subscribe');
    assert.equal(lastPush().body.endpoint, ENDPOINT);
    await page.locator('[data-push-row="8"] [data-push-current]').waitFor();
    const before = posts.length;
    await page.locator('[data-logout]').click();
    await page.locator('[data-auth]').waitFor();
    assert.deepEqual(posts.slice(before).filter(row => row.action !== 'data').map(row => [row.action, row.body]), [['push/unsubscribe', { id: 8 }], ['logout', {}]], 'unsubscribe runs before sign-out');
    assert.equal((await log(page)).unsubscribed, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('push.subscription')), null);
    assert.deepEqual(errors, []); await context.close();

    // Removing this browser from the account page unsubscribes it locally too.
    reset();
    ({ page, context, errors } = await open(viewport, {}));
    await watchState(page, 'off');
    await page.locator('[data-push-enable]').click();
    await page.locator('[data-notification-state="on"]').waitFor();
    await page.goto(origin + '/account?lang=zh');
    await page.locator('[data-setting=devices] summary').click();
    await page.locator('[data-push-remove="7"]').click();
    await page.locator('[data-push-list]').waitFor({ state: 'detached' });
    assert.equal((await log(page)).unsubscribed, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('push.subscription')), null);
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS web push: signed out, iOS home screen, unsupported, server off, blocked, enable/test/disable, expired test, push suppresses page notifications, worker and fallback notifications, account push list, sign-out unsubscribe, desktop and phone widths');
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
