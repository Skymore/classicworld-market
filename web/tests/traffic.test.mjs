import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../js/lib/traffic.js', import.meta.url), 'utf8')).replace('export function trackPage', 'function trackPage');
function tracker(options = {}) {
  const events = [], storage = options.storage || new Map();
  const context = vm.createContext({
    crypto: webcrypto, Uint8Array, Date: options.Date || Date,
    document: { referrer: 'https://example.com/find?q=private', visibilityState: 'visible' },
    navigator: options.navigator || {}, innerWidth: 390,
    localStorage: { getItem: key => { if (options.blocked) throw Error(); return storage.get(key); },
      setItem: (key, value) => { if (options.blocked) throw Error(); storage.set(key, value); } },
    fetch: (url, request) => { events.push({ url, request, data: JSON.parse(request.body) }); return options.failed ? Promise.reject(Error()) : Promise.resolve({ ok: true }); },
  });
  vm.runInContext(source, context);
  return { track: path => context.trackPage(path), events, context, storage };
}
test('one view per pathname change, daily browser dedup, first referrer only, no credentials', () => {
  const one = tracker();
  one.track('/'); one.track('/'); one.track('/prices'); one.track('/prices'); one.track('/');
  assert.equal(one.events.length, 3);
  assert.equal(new Set(one.events.map(event => event.data.visitor)).size, 1);
  assert.equal(new Set(one.events.map(event => event.data.event_id)).size, 3);
  assert.equal(one.events[0].data.referrer, 'https://example.com/find?q=private');
  assert.equal(one.events[1].data.referrer, '');
  assert.equal(one.events[0].request.credentials, 'omit');
  const two = tracker({ storage: one.storage }); two.track('/');
  assert.equal(two.events[0].data.visitor, one.events[0].data.visitor);
});
test('daily identifier rotation and blocked storage fallback', () => {
  const storage = new Map([['cwm.traffic.daily.v1', JSON.stringify({ day: '2000-01-01', id: 'a'.repeat(32) })]]);
  const one = tracker({ storage }); one.track('/');
  assert.notEqual(one.events[0].data.visitor, 'a'.repeat(32));
  const two = tracker({ blocked: true }); two.track('/'); two.track('/prices');
  assert.equal(two.events.length, 2); assert.equal(two.events[0].data.visitor, two.events[1].data.visitor);
});
test('privacy preferences suppress tracking and recording failures do not interrupt navigation', async () => {
  for (const navigator of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
    const one = tracker({ navigator }); one.track('/'); assert.equal(one.events.length, 0);
  }
  const one = tracker({ failed: true }); assert.doesNotThrow(() => one.track('/'));
  await new Promise(resolve => setImmediate(resolve));
});
