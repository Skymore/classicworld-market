import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/lib/quote-groups.js',import.meta.url),'utf8');
const {mergeShopOffers:merge}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const offer={id:'a',shop_key:'actual-shop-key',visit_id:'visit',world:'world',source:'packet',slot:1,item_id:5680001,unit_price:40000,bundle:1,stock:1,observed:12345,shop:'cheap',location:{channel:20,room:9}};
const second={...offer,id:'b',slot:2,stock:3};
const original=JSON.stringify([offer,second]);
const [group]=merge([offer,second]);
assert.equal(group.stock,4);assert.equal(group.unit_price,40000);assert.equal(group.id,'a');assert.equal(group.merged_count,2);assert.deepEqual(group.merged_ids,['a','b']);
assert.equal(JSON.stringify([offer,second]),original,'does not mutate raw observations');
assert.equal(merge([offer,{...offer}])[0].stock,1,'one slot never counts twice');
for(const difference of [{shop_key:'another-shop'},{visit_id:'another-visit'},{observed:12346},{world:'elsewhere'},{source:'screen'},{item_id:5680002},{unit_price:45000},{bundle:2},{unit_basis:'set'}])
 assert.equal(merge([offer,{...second,...difference}]).length,2,JSON.stringify(difference));
for(const missing of ['shop_key','visit_id','slot','observed','bundle']){const row={...second};delete row[missing];assert.equal(merge([offer,row]).length,2,'missing '+missing);}
assert.equal(merge([offer,{...second,stock:null}])[0].stock,null,'unknown stock remains unknown');
assert.equal(merge([{...offer,stock:null},second])[0].stock,null);
const gear={...offer,item_id:1452003,equipment:{status:'candidate',stats:[{key:'weapon_attack',value:50}],remaining_upgrades:7,enhancements:0,unknown_fields:[]}};
assert.equal(merge([gear,{...gear,id:'b',slot:2}])[0].stock,2);
assert.equal(merge([gear,{...gear,slot:2,equipment:{...gear.equipment,remaining_upgrades:6}}]).length,2,'different upgrades');
assert.equal(merge([gear,{...gear,slot:2,equipment:{...gear.equipment,stats:[{key:'weapon_attack',value:51}]}}]).length,2,'different attributes');
for(const equipment of [null,{status:'unsupported'},{...gear.equipment,unknown_fields:['raw']}]){
 const row={...gear,equipment};assert.equal(merge([row,{...row,slot:2}]).length,2,'unknown gear stays separate');
}
assert.equal(merge([{...offer,seen_at:'2026-10-24T00:00:00.000001Z'},{...second,seen_at:'2026-10-24T00:00:00.000002Z'}]).length,2,'preserves observation precision');
console.log('PASS quote grouping: exact shop/snapshot/item/price/attributes, summed stocks, duplicate slots, unknown gear and immutable inputs');
