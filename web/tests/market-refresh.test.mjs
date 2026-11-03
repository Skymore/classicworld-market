import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const realtimeSource = await readFile(new URL('../js/lib/realtime.js', import.meta.url), 'utf8');
let instance = 0;
async function loadRealtime() {
  return import('data:text/javascript,' + encodeURIComponent(realtimeSource + `\n// instance ${instance++}`));
}

test('market events: ids are kept only when every merged event names its items', async () => {
  const { marketChange, mergeMarketChanges } = await loadRealtime();
  assert.deepEqual(marketChange('{"ids":[1,2]}'), { ids: [1, 2] });
  assert.deepEqual(marketChange('{}'), {});
  assert.deepEqual(marketChange(''), {});
  assert.deepEqual(marketChange('{"ids":[1.5]}'), {});
  assert.deepEqual(marketChange(JSON.stringify({ ids: Array.from({ length: 201 }, (_, i) => i) })), {});
  assert.deepEqual(mergeMarketChanges(null, { ids: [1] }), { ids: [1] });
  assert.deepEqual(mergeMarketChanges({ ids: [1, 2] }, { ids: [2, 3] }), { ids: [1, 2, 3] });
  assert.deepEqual(mergeMarketChanges({ ids: [1] }, {}), {});
  assert.deepEqual(mergeMarketChanges({}, { ids: [1] }), {});
  assert.deepEqual(mergeMarketChanges({ ids: Array.from({ length: 150 }, (_, i) => i) }, { ids: Array.from({ length: 60 }, (_, i) => 1000 + i) }), {});
});

test('market events reach subscribers at most every 3 s and wait while the page is hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const listeners = new Map(), streams = [];
  const original = { document: globalThis.document, EventSource: globalThis.EventSource, CustomEvent: globalThis.CustomEvent };
  globalThis.document = {
    visibilityState: 'visible', documentElement: { dataset: {}, lang: 'zh' }, querySelectorAll: () => [],
    dispatchEvent() {}, addEventListener: (type, fn) => listeners.set(type, fn),
  };
  globalThis.CustomEvent = class extends Event {};
  globalThis.EventSource = class {
    constructor() { this.handlers = {}; streams.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
  };
  t.after(() => Object.assign(globalThis, original));
  const { subscribeMarket } = await loadRealtime();
  const seen = [];
  const stop = subscribeMarket((change) => seen.push(change));
  const market = (data) => streams[0].handlers.market({ data });
  market('{"ids":[1]}');
  t.mock.timers.tick(0);
  assert.deepEqual(seen, [{ ids: [1] }], 'the first event goes out at once');
  market('{"ids":[2]}');
  t.mock.timers.tick(1000);
  market('{"ids":[3]}');
  t.mock.timers.tick(1500);
  assert.equal(seen.length, 1, 'events within 3 s wait');
  t.mock.timers.tick(500);
  assert.deepEqual(seen.at(-1), { ids: [2, 3] }, 'and arrive merged');
  t.mock.timers.tick(5000);
  document.visibilityState = 'hidden';
  market('{}');
  t.mock.timers.tick(10_000);
  assert.equal(seen.length, 2, 'nothing while hidden');
  document.visibilityState = 'visible';
  listeners.get('visibilitychange')();
  t.mock.timers.tick(0);
  assert.deepEqual(seen.at(-1), {}, 'one catch-up once shown');
  t.mock.timers.tick(10_000);
  assert.equal(seen.length, 3);
  stop();
  assert.equal(streams[0].closed, true);
});

test('lists the browser may cache revalidate through it, not with a page-held ETag', async () => {
  const code = (await readFile(new URL('../js/lib/api.js', import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, 'const subscribeMarket=()=>()=>{};\n');
  const { getJson } = await import('data:text/javascript,' + encodeURIComponent(code + '\n// browser cache'));
  const original = globalThis.fetch, requests = [];
  let etag = '"v1"', parsed = 0;
  globalThis.fetch = async (url, options) => {
    requests.push(options);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ etag }))); controller.close(); } });
    const response = new Response(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache', 'Content-Type': 'application/json' } });
    const json = response.json.bind(response);
    response.json = () => { parsed++; return json(); };
    return response;
  };
  try {
    const url = '/api/v1/market?view=list&hours=72';
    const first = await getJson(url);
    assert.equal(first.changed, true);
    const second = await getJson(url);
    assert.equal(requests[1].headers['If-None-Match'], undefined, 'the browser adds its own validator');
    assert.equal(requests[1].cache, 'no-cache');
    assert.equal(second.changed, false, 'the same ETag means the same data');
    assert.equal(second.data, first.data);
    assert.equal(parsed, 1, 'an unchanged body is not parsed again');
    etag = '"v2"';
    const third = await getJson(url);
    assert.equal(third.changed, true);
    assert.deepEqual(third.data, { etag: '"v2"' });
  } finally { globalThis.fetch = original; }
});
