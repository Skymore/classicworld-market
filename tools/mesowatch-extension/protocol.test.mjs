import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// No package.json needed by the Chrome module worker.
const code = await readFile(new URL('protocol.js', import.meta.url), 'utf8');
const {allowedURL, readMarketJSON} = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

test('market reads cannot fetch account APIs or another origin', () => {
  assert.ok(allowedURL('https://meso.watch/data/list.json'));
  assert.ok(allowedURL('https://meso.watch/data/markets/Classic%20World/item/basil_04010001.json'));
  for (const url of ['https://meso.watch/api/me','https://evil.test/data/list.json',
    'https://meso.watch/data/list.json?x=1']) assert.equal(allowedURL(url),false);
});

test('challenge pages never become snapshots', async () => {
  globalThis.location = {origin:'https://meso.watch'};
  globalThis.fetch = async () => new Response('challenge',{status:403,headers:{'content-type':'text/html'}});
  assert.deepEqual(await readMarketJSON('https://meso.watch/data/list.json'),{status:403,type:'text/html'});
});

test('same-origin browser credentials are retained', async () => {
  globalThis.location = {origin:'https://meso.watch'};
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.cache,'no-cache');
    return new Response('{"items":[]}',{headers:{'content-type':'application/json'}});
  };
  assert.equal((await readMarketJSON('https://meso.watch/data/list.json')).text,'{"items":[]}');
});
