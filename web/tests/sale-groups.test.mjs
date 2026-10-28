import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/lib/sale-groups.js',import.meta.url),'utf8');
const {mergeShopSales:merge}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const sale={id:'a',item_id:2000003,kind:'sold_out',quantity:100,sale_price:190,sale_unit_price:190,bundle:1,unit_basis:'item',source:'packet',shop:'1111',location:{channel:22,map_id:910000010,room:10},time:1793152700.5,previous_time:1793152400.25,variant:'standard'};
const six=Array.from({length:6},(_,i)=>({...sale,id:'s'+i}));
const original=JSON.stringify(six);
const [group,...rest]=merge(six);
assert.equal(rest.length,0);assert.equal(group.quantity,600);assert.equal(group.merged_count,6);assert.equal(group.id,'s0');
assert.equal(JSON.stringify(six),original,'does not mutate raw sales');
assert.equal(merge([sale])[0].merged_count,1);
// Different quantities per slot still add up; an unknown quantity makes the total unknown.
assert.equal(merge([sale,{...sale,id:'b',quantity:40}])[0].quantity,140);
const found={...sale,kind:'found_sold',quantity:null,previous_time:null};
const [unknown]=merge([found,{...found,id:'b'},{...found,id:'c'}]);
assert.equal(unknown.quantity,null);assert.equal(unknown.merged_count,3);
assert.equal(merge([sale,{...sale,id:'b',quantity:null}])[0].quantity,null);
for(const difference of [{shop:'other'},{location:{channel:23,map_id:910000010,room:10}},{time:1793152760.5},{previous_time:1793152100},{kind:'drop'},{item_id:2000002},{sale_price:195,sale_unit_price:195},{bundle:2},{source:'screen'},{variant:'other'}])
 assert.equal(merge([sale,{...sale,id:'b',...difference}]).length,2,JSON.stringify(difference));
assert.equal(merge([{...sale,shop:null,location:null},{...sale,id:'b',shop:null,location:null}]).length,2,'no shop, no merge');
// Gear: identical known attributes merge, anything else stays one row per piece.
const gear={...sale,item_id:1082002,quantity:1,variant:'v1',equipment:{status:'candidate',stats:[{key:'weapon_defense',value:20}],remaining_upgrades:5,unknown_fields:[]}};
assert.equal(merge([gear,{...gear,id:'b'}])[0].quantity,2);
assert.equal(merge([gear,{...gear,id:'b',variant:'v2',equipment:{...gear.equipment,stats:[{key:'weapon_defense',value:21}]}}]).length,2,'different attributes');
for(const equipment of [null,{status:'unsupported',stats:[]},{...gear.equipment,unknown_fields:['raw']}]){
 const row={...gear,equipment};assert.equal(merge([row,{...row,id:'b'}]).length,2,'unknown gear stays separate');
}
console.log('PASS sale grouping: one shop visit, price, kind and item; summed or unknown quantities; gear only when identical');
