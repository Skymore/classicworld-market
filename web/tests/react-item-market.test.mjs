import assert from 'node:assert/strict';
import test from 'node:test';
import {tierBounds,makeLadder,offerGroups,hasBonus,groupEquipmentVariants} from '../../frontend/src/lib/item-market.ts';
test('React price ladder matches the established iron-ore tiers and counts each quote and sale once',()=>{
 const prices=Array.from({length:100},(_,i)=>300+i*3);const tiers=tierBounds(prices);assert(tiers.length>=6&&tiers.length<=10);assert(tiers.some(tier=>tier.lo===400&&tier.hi===449));
 const market={days:[{},{}],listings:[{unit_price:400},{unit_price:449},{unit_price:500}],sale_points:[{day:0,price:410},{day:1,price:500}]};const ladder=makeLadder(market);assert.equal(ladder.tiers.reduce((n,tier)=>n+tier.listings,0),3);assert.equal(ladder.grid.flat().reduce((a,b)=>a+b,0),2);assert.equal(ladder.grid[ladder.index(410)][0],1);assert.equal(ladder.grid[ladder.index(500)][1],1);
});
// The same fixtures as tier_bounds_match_the_browser in server/.../bestiary/pages/market.rs.
test('React price bands match the server: middle 80% of prices, 1-2-5 steps when skewed',()=>{
 const pairs=prices=>tierBounds(prices).map(tier=>[tier.lo,tier.hi]);
 const stars=[...Array.from({length:70},(_,i)=>1700+i*10),...Array.from({length:25},(_,i)=>2500+i*100),...Array.from({length:5},(_,i)=>17500+i*1000)];
 assert.deepEqual(pairs(stars),[[0,1499],[1500,1999],[2000,2499],[2500,2999],[3000,3499],[3500,3999],[4000,4499],[4500,null]],'far-off listings no longer widen every band');
 const gear=[...Array.from({length:60},(_,i)=>900+i*10),...Array.from({length:40},(_,i)=>5000+i*5000)];
 assert.deepEqual(pairs(gear),[[0,1999],[2000,4999],[5000,9999],[10000,19999],[20000,49999],[50000,99999],[100000,null]]);
 const tail=[...Array.from({length:60},(_,i)=>2000+i*10),...Array.from({length:30},(_,i)=>3000+i*100),...Array.from({length:15},(_,i)=>8000+i*1000)];
 assert.deepEqual(pairs(tail),[[0,1999],...[2,3,4,5,6,7,8].map(k=>[k*1000,k*1000+999]),[9000,null]],'a long tail stays in the open top band');
});
test('React channel groups use fresh minimums, retain unknown locations and switch to observed time independently of price',()=>{
 const now=Date.now()/1000;const rows=[{shop:'old',channel:1,room:1,unit_price:1,seen_at:now-60*3600},{shop:'fresh',channel:1,room:2,unit_price:100,seen_at:now-300},{shop:'other',channel:2,room:1,unit_price:50,seen_at:now-600},{shop:'unknown',channel:null,room:null,unit_price:2,seen_at:now-60}];
 const price=offerGroups(rows,false,now);assert.deepEqual(price.map(group=>group.key),['2','1','unknown']);assert.equal(price[1].price,100);assert.deepEqual(offerGroups(rows,true,now).map(group=>group.key),['unknown','1','2']);assert.equal(price.reduce((n,group)=>n+group.rows.length,0),4);
});
test('React equipment bonuses use captured instance stats without inventing values from the catalogue',()=>{
 assert.equal(hasBonus(null,[['weapon_attack',17]]),false);assert.equal(hasBonus({stats:[{key:'weapon_attack',value:18}],enhancements:0},[['weapon_attack',17]]),true);assert.equal(hasBonus({stats:[{key:'weapon_attack',value:17}],enhancements:0},[['weapon_attack',17]]),false);assert.equal(hasBonus({stats:[],enhancements:1},[]),false);
 for(const key of ['weapon_defense','magic_defense','pdd','mdd'])assert.equal(hasBonus({stats:[{key,value:50}],enhancements:1},[[key,10]]),false);
 assert.equal(hasBonus({stats:[{key:'weapon_defense',value:50},{key:'dex',value:3}],enhancements:0},[['dex',2]]),true);
});

test('equipment groups ignore defence and enhancement counts but retain upgrade slots and actual offer values',()=>{
 const variant=(id,dex,def,magic,enhancements=0,remaining_upgrades=7)=>({id,stats:[{key:'dex',value:dex},{key:'weapon_defense',value:def},{key:'magic_defense',value:magic}],enhancements,remaining_upgrades});
 const rows=[{variant:variant(1,2,10,5),unit_price:100},{variant:variant(2,2,20,9),unit_price:50},{variant:variant(3,3,10,5),unit_price:80},{variant:variant(4,2,10,5,1),unit_price:90},{variant:variant(5,2,10,5,0,6),unit_price:90},{variant:null}];
 rows[1].variant.stats.reverse();
 const before=structuredClone(rows),groups=groupEquipmentVariants(rows);
 assert.equal(groups.length,3);assert.equal(groups[0].offers.length,3);
 assert.deepEqual(groups[0].offers.map(row=>row.variant.id),[1,2,4]);
 assert.equal(groups[0].variant.enhancements,0);assert.equal(groups[0].variant.maxEnhancements,1);
 assert.equal(groups[2].variant.remaining_upgrades,6,'remaining upgrade slots still separate groups');
 assert.equal(Math.min(...groups[0].offers.map(row=>row.unit_price)),50);
 assert.deepEqual(groups[0].variant.stats.find(stat=>stat.key==='weapon_defense'),{key:'weapon_defense',value:10,maxValue:20});
 assert.deepEqual(groups[0].variant.stats.find(stat=>stat.key==='magic_defense'),{key:'magic_defense',value:5,maxValue:9});
 assert.deepEqual(rows,before,'grouped ranges never overwrite the individual captured stats');
 assert.deepEqual(groupEquipmentVariants([]),[]);
});
