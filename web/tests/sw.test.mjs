// web/sw.js runs in a fake worker global: push shows a notification, a click
// focuses or opens a same-origin page, and there is no fetch handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readFile(path.join(web, 'sw.js'), 'utf8');
const ORIGIN = 'https://mxd.ruit.me';

function worker(windows = []) {
  const handlers = {}, shown = [], opened = [], calls = [];
  // Values made inside the vm realm have other prototypes; compare plain copies.
  const plain = value => JSON.parse(JSON.stringify(value));
  const self = {
    location: new URL(ORIGIN + '/sw.js'),
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: async () => calls.push('skipWaiting'),
    registration: { showNotification: async (title, options) => shown.push(plain({ title, options })) },
    clients: {
      claim: async () => calls.push('claim'),
      matchAll: async options => { calls.push(['matchAll', plain(options)]); return windows; },
      openWindow: async url => { opened.push(url); return null; },
    },
  };
  vm.runInNewContext(source, { self, URL, console });
  return { handlers, shown, opened, calls };
}
async function dispatch(handler, event) {
  const pending = [];
  handler({ ...event, waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
}
const pushEvent = payload => ({
  data: payload === undefined ? null : { json: () => JSON.parse(payload), text: () => payload },
});
function windowClient(url, { focused = false, navigateFails = false } = {}) {
  const client = {
    url, focused, log: [],
    async focus() { client.log.push('focus'); return client; },
    async navigate(next) {
      client.log.push(['navigate', next]);
      if (navigateFails) throw new TypeError('not controlled');
      client.url = next;
      return client;
    },
  };
  return client;
}
function click(url) {
  const notification = { data: url === undefined ? undefined : { url }, closed: false, close() { this.closed = true; } };
  return { notification };
}

test('registers lifecycle, push and click handlers, but no fetch handler', async () => {
  const { handlers, calls } = worker();
  assert.deepEqual(Object.keys(handlers).sort(), ['activate', 'install', 'notificationclick', 'push']);
  handlers.install({});
  await dispatch(handlers.activate, {});
  assert.deepEqual(calls, ['skipWaiting', 'claim']);
});

test('push shows the payload with icon, badge, tag and url', async () => {
  const { handlers, shown } = worker();
  const payload = { title: '关注提醒', body: '红色药水 · 41 · 库存 100 · 12频道 3洞 · 店名', url: '/item/2000000', tag: 'watch-2000000', icon: '/web/icons/icon-192.png' };
  await dispatch(handlers.push, pushEvent(JSON.stringify(payload)));
  assert.deepEqual(shown, [{
    title: '关注提醒',
    options: { body: payload.body, icon: '/web/icons/icon-192.png', badge: '/web/icons/badge-96.png', data: { url: '/item/2000000' }, tag: 'watch-2000000', renotify: true },
  }]);
});

test('push without data or with bad JSON still shows a notification', async () => {
  const { handlers, shown } = worker();
  await dispatch(handlers.push, pushEvent(undefined));
  await dispatch(handlers.push, pushEvent('not json'));
  assert.deepEqual(shown.map(({ title, options }) => [title, options.body, options.data.url, 'tag' in options]), [
    ['枫叶市集', '', '/watch', false],
    ['枫叶市集', 'not json', '/watch', false],
  ]);
});

test('push keeps urls and icons on this site', async () => {
  const { handlers, shown } = worker();
  await dispatch(handlers.push, pushEvent(JSON.stringify({ title: 'x', url: 'https://evil.example/item/1', icon: 'https://evil.example/a.png' })));
  await dispatch(handlers.push, pushEvent(JSON.stringify({ title: 'y', url: `${ORIGIN}/watch?item=5#watch-matches`, icon: 42 })));
  assert.deepEqual(shown.map(({ options }) => [options.data.url, options.icon]), [
    ['/watch', '/web/icons/icon-192.png'],
    ['/watch?item=5#watch-matches', '/web/icons/icon-192.png'],
  ]);
});

test('click focuses an open site window and navigates it', async () => {
  const other = windowClient(`${ORIGIN}/prices`), active = windowClient(`${ORIGIN}/account`, { focused: true });
  const { handlers, opened, calls } = worker([other, active]);
  const event = click('/item/2000000');
  await dispatch(handlers.notificationclick, event);
  assert.equal(event.notification.closed, true);
  assert.deepEqual(calls, [['matchAll', { type: 'window', includeUncontrolled: true }]]);
  assert.deepEqual(active.log, ['focus', ['navigate', `${ORIGIN}/item/2000000`]]);
  assert.deepEqual(other.log, []);
  assert.deepEqual(opened, []);
});

test('click on a window already showing the page only focuses it', async () => {
  const same = windowClient(`${ORIGIN}/item/7`);
  const { handlers, opened } = worker([windowClient(`${ORIGIN}/`, { focused: true }), same]);
  await dispatch(handlers.notificationclick, click('/item/7'));
  assert.deepEqual(same.log, ['focus']);
  assert.deepEqual(opened, []);
});

test('click opens a window when none is open or navigation is refused', async () => {
  const empty = worker([]);
  await dispatch(empty.handlers.notificationclick, click(undefined));
  assert.deepEqual(empty.opened, [`${ORIGIN}/watch`]);
  const uncontrolled = windowClient(`${ORIGIN}/`, { navigateFails: true });
  const refused = worker([uncontrolled]);
  await dispatch(refused.handlers.notificationclick, click('https://evil.example/x'));
  assert.deepEqual(uncontrolled.log, ['focus', ['navigate', `${ORIGIN}/watch`]]);
  assert.deepEqual(refused.opened, [`${ORIGIN}/watch`]);
});

test('manifest and icons match what the head and worker reference', async () => {
  const manifest = JSON.parse(await readFile(path.join(web, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, '枫叶市集');
  assert.equal(manifest.start_url, '/watch');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  const html = await readFile(path.join(web, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/web\/icons\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="theme-color" content="#3b5f8a">/);
  const icons = [...manifest.icons, { src: '/web/icons/apple-touch-icon.png', sizes: '180x180' }, { src: '/web/icons/badge-96.png', sizes: '96x96' }];
  assert(manifest.icons.some(icon => icon.purpose === 'maskable'));
  for (const icon of icons) {
    const png = await readFile(path.join(web, icon.src.replace(/^\/web\//, '')));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', icon.src);
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
});
