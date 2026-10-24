import assert from 'node:assert/strict';
import test from 'node:test';
import {tierBounds,makeLadder,offerGroups,hasBonus} from '../../frontend/src/lib/item-market.ts';
test('React price ladder matches the established iron-ore tiers and counts each quote and sale once',()=>{
 const prices=Array.from({length:100},(_,i)=>300+i*3);const tiers=tierBounds(prices);assert(tiers.length>=6&&tiers.length<=10);assert(tiers.some(tier=>tier.lo===400&&tier.hi===449));
 const market={days:[{},{}],listings:[{unit_price:400},{unit_price:449},{unit_price:500}],sale_points:[{day:0,price:410},{day:1,price:500}]};const ladder=makeLadder(market);assert.equal(ladder.tiers.reduce((n,tier)=>n+tier.listings,0),3);assert.equal(ladder.grid.flat().reduce((a,b)=>a+b,0),2);assert.equal(ladder.grid[ladder.index(410)][0],1);assert.equal(ladder.grid[ladder.index(500)][1],1);
});
test('React channel groups use fresh minimums, retain unknown locations and switch to observed time independently of price',()=>{
 const now=Date.now()/1000;const rows=[{shop:'old',channel:1,room:1,unit_price:1,seen_at:now-60*3600},{shop:'fresh',channel:1,room:2,unit_price:100,seen_at:now-300},{shop:'other',channel:2,room:1,unit_price:50,seen_at:now-600},{shop:'unknown',channel:null,room:null,unit_price:2,seen_at:now-60}];
 const price=offerGroups(rows,false,now);assert.deepEqual(price.map(group=>group.key),['2','1','unknown']);assert.equal(price[1].price,100);assert.deepEqual(offerGroups(rows,true,now).map(group=>group.key),['unknown','1','2']);assert.equal(price.reduce((n,group)=>n+group.rows.length,0),4);
});
test('React equipment bonuses use captured instance stats without inventing values from the catalogue',()=>{
 assert.equal(hasBonus(null,[['weapon_attack',17]]),false);assert.equal(hasBonus({stats:[{key:'weapon_attack',value:18}],enhancements:0},[['weapon_attack',17]]),true);assert.equal(hasBonus({stats:[{key:'weapon_attack',value:17}],enhancements:0},[['weapon_attack',17]]),false);assert.equal(hasBonus({stats:[],enhancements:1},[]),true);
});
