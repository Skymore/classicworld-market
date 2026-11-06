import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const source = async name => 'data:text/javascript,' + encodeURIComponent(await readFile(new URL(`../js/lib/${name}.js`, import.meta.url), 'utf8'));
const filters = await source('item-offer-filters'), groups = await source('quote-groups');
const code = (await readFile(new URL('../js/lib/watch-reminders.js', import.meta.url), 'utf8'))
  .replace(/'\.\/item-offer-filters\.js\?v=[^']+'/, JSON.stringify(filters))
  .replace(/'\.\/quote-groups\.js\?v=[^']+'/, JSON.stringify(groups));
const { normalizeReminder, reminderSelection, matchingReminders, notificationEligibility, watchGroups } = await import('data:text/javascript,' + encodeURIComponent(code));
const { combinedNotifications, readSettings } = await import(await source('watchlist-core'));
const item = 2000000, gear = 1452003;
const row = (id, price, patch = {}) => ({ id, item_id: item, unit_price: price, stock: 5, observed: 110, ...patch });
const rows = Array.from({ length: 10 }, (_, index) => row(String(index), (index + 1) * 100));

test('quantity settings preserve explicit unlimited and reject invalid limits',()=>{
  for(const limit of [0,1,9999,-1,10000,true]){
    const saved=readSettings({getItem:()=>JSON.stringify({[item]:{buyLimit:limit}})},[item]);
    assert.equal(saved[item].buyLimit,[0,1,9999].includes(limit)?limit:undefined);
  }
});
test('groups use OR, notifications use their own toggles, deleting last group matches nothing',()=>{
  const settings={[item]:{groups:[{id:'a',name:'A',cap:200,notify:false},{id:'b',name:'B',cap:300,notify:true}]}};
  assert.equal(matchingReminders(rows,[item],settings).length,3);
  assert.equal(notificationEligibility({listings:rows},[item],settings,{}).size,3);
  settings[item].groups.pop();
  assert.equal(matchingReminders(rows,[item],settings).length,2);
  assert.equal(notificationEligibility({listings:rows},[item],settings,{}).size,0);
  settings[item].groups=[];
  assert.equal(matchingReminders(rows,[item],settings).length,0);
  assert.deepEqual(watchGroups(settings[item]),[]);
  const restored=readSettings({getItem:()=>JSON.stringify(settings)},[item]);
  assert.deepEqual(restored[item].groups,[]);
  assert.equal(watchGroups({cap:100,notify:false})[0].cap,100);
});

test('presets use only the server cutoff, keep ties and ignore a saved manual cap', () => {
  const tied = [...rows, row('tie',100)];
  const setting = { cap: 1, reminder: { percentile: '10' } };
  const reference = { rows: tied, percentiles: { [item]: { '10': 100, '25': 300, '50': 500 } } };
  assert.equal(reminderSelection(tied,item,setting,reference).cap,100);
  assert.equal(reminderSelection(tied,item,setting,reference).rows.length,2);
  assert.equal(reminderSelection(rows,item,{reminder:{percentile:'25'}},reference).cap,300);
  assert.equal(reminderSelection(rows,item,{reminder:{percentile:'50'}},reference).cap,500);
  assert.equal(reminderSelection(rows,item,{cap:125}).cap,125);
  assert.equal(reminderSelection(rows,item,setting).ready,false,'no server cutoff: nothing is computed locally');
});
test('server percentiles cover prices beyond the response limit and personal feeds use the shared baseline', () => {
  const reference={rows,percentiles:{[item]:{'10':100}}};
  assert.deepEqual(reminderSelection([row('high',1000),row('low',100)],item,{reminder:{percentile:'10'}},reference).rows.map(r=>r.id),['low']);
  assert.equal(reminderSelection(rows.slice(7),item,{reminder:{percentile:'50'}},{percentiles:{[item]:{'50':500}}}).rows.length,0);
});
test('advanced filters are independent per item and do not change the percentile baseline', () => {
  const all=[...rows,...rows.map(r=>({...r,item_id:2000001}))];
  const settings={[item]:{reminder:{percentile:'50',minPrice:250,minStock:5}},2000001:{cap:150}};
  assert.deepEqual(matchingReminders(all,[item,2000001],settings,{percentiles:{[item]:{'50':500}}}).map(r=>[r.item_id,r.unit_price]),[[item,300],[item,400],[item,500],[2000001,100]]);
  assert.equal(reminderSelection(rows,item,{cap:100,reminder:{minPrice:500}}).rows.length,0,'a lower bound above the cap must not swap the bounds');
  assert.equal(reminderSelection(rows,item,{cap:0}).rows.length,0);
  const normalized=normalizeReminder({percentile:'75',hours:'1',maxPrice:1,minPrice:500});
  assert.equal(normalized.minPrice,500);assert.equal(normalized.percentile,'all');assert(!('hours' in normalized));assert(!('maxPrice' in normalized));
});
test('expired and sold-out quotes are excluded; known and unknown stock remain distinct', () => {
  const offers=[row('known',100),row('unknown',200,{stock:null}),row('empty',1,{stock:0}),row('expired',1,{invalidated_at:111})];
  assert.deepEqual(reminderSelection(offers,item,{reminder:{stock:'unknown'}}).rows.map(r=>r.id),['unknown']);
  assert.deepEqual(reminderSelection(offers,item,{reminder:{stock:'known',minStock:5}}).rows.map(r=>r.id),['known']);
});
test('equipment conditions use captured stats, combine with AND and ignore defence-only bonus rolls', () => {
  const eq=(attack,str,def=20)=>({status:'candidate',stats:[{key:'weapon_attack',value:attack},{key:'str',value:str},{key:'weapon_defense',value:def}]});
  const offers=[row('base',100,{item_id:gear,equipment:eq(42,0,30)}),row('bonus',200,{item_id:gear,equipment:eq(45,2)}),row('partial',300,{item_id:gear,equipment:eq(45,0)}),row('missing',400,{item_id:gear})];
  const reference={baseStats:{[gear]:[['weapon_attack',42],['str',0],['weapon_defense',20]]}};
  assert.deepEqual(reminderSelection(offers,gear,{reminder:{equipment:'bonus'}},reference).rows.map(r=>r.id),['bonus','partial']);
  assert.deepEqual(reminderSelection(offers,gear,{reminder:{stats:[{stat:'weapon_attack',min:45},{stat:'str',min:2}]}},reference).rows.map(r=>r.id),['bonus']);
  assert.deepEqual(reminderSelection(offers,gear,{reminder:{equipment:'missing'}},reference).rows.map(r=>r.id),['missing']);
});
test('notifications use complete grouped stock and filtered rows are seen without delivery or replay', () => {
  const raw=row('slot-1',100,{stock:3,shop_key:'shop',visit_id:'visit',slot:1,bundle:1});
  const full={...raw,stock:6,merged_count:2};
  const packet={listings:[raw,row('high',900)],grouped_listings:[full,row('high',900)]};
  const settings={[item]:{reminder:{percentile:'10',minStock:5}}};
  const eligible=notificationEligibility(packet,[item],settings,{rows,percentiles:{[item]:{'10':100}}});
  assert.equal(eligible.get('slot-1').stock,6);
  const state={shared:new Map(),personal:new Map(),delivered:new Map()};
  const watches=[{item_id:item,max_price:null}];
  const fresh=combinedNotifications(packet.listings,watches,state,100,111,'shared','',eligible);
  assert.deepEqual(fresh.map(r=>r.id),['slot-1']);assert(state.shared.has('high'));assert(!state.delivered.has('high'));
  assert.equal(combinedNotifications(packet.listings,watches,state,100,112,'shared','',new Map(packet.listings.map(r=>[r.id,r]))).length,0);
  assert.equal(combinedNotifications([raw],watches,state,100,112,'personal','me',eligible).length,0);
  const later={...raw,id:'slot-2',slot:2};
  const changed=notificationEligibility({listings:[later,raw]},[item],settings,{rows,percentiles:{[item]:{'10':100}}});
  assert.equal(combinedNotifications([later,raw],watches,state,100,113,'shared','',changed).length,0,'a later raw member or reversed group order must not replay the same group');
});
test('legacy manual settings and new reminder rules survive reading the watch settings', () => {
  const reminder=normalizeReminder({percentile:'25',minStock:10});
  const stored={[item]:{cap:0,notify:false,reminder},[gear]:{cap:12,notify:true}};
  assert.deepEqual(readSettings({getItem:()=>JSON.stringify(stored)},[item,gear]),stored);
});
test('muting suppresses deliveries, retains seen history, and does not replay on unmute', () => {
  const packet={listings:[row('muted',100)]};
  const muted=notificationEligibility(packet,[item],{[item]:{notify:false}},{rows});
  const state={shared:new Map(),personal:new Map(),delivered:new Map()},watches=[{item_id:item,max_price:null}];
  assert.equal(combinedNotifications(packet.listings,watches,state,100,111,'shared','',muted).length,0);
  assert(state.shared.has('muted'));assert(!state.delivered.has('muted'));
  const enabled=notificationEligibility(packet,[item],{}, {rows});
  assert.equal(combinedNotifications(packet.listings,watches,state,100,112,'shared','',enabled).length,0);
});
