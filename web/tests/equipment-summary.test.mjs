import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/lib/equipment-summary.js',import.meta.url),'utf8');
const {equipmentSummary}=await import('data:text/javascript,'+encodeURIComponent(source));
test('different equipment offers keep their captured values and remaining zero slots',()=>{
 const row={item_id:1072128,equipment:{status:'candidate',stats:[{key:'weapon_defense',value:18},{key:'dex',value:2}],remaining_upgrades:0,enhancements:1}};
 assert.equal(equipmentSummary(row),'敏捷 +2 · 物理防御 +18 · 强化成功 +1 · 可升级 0');
 assert.equal(equipmentSummary({...row,equipment:{...row.equipment,stats:[{key:'dex',value:4}]}}),'敏捷 +4 · 强化成功 +1 · 可升级 0');
 assert.match(equipmentSummary(row,true),/DEX \+2/);
});
test('missing or unsupported captured values never fall back to catalogue defaults',()=>{
 assert.equal(equipmentSummary({item_id:1072128,equipment:{status:'unsupported'},base_stats:{dex:10}}),'');
 assert.equal(equipmentSummary({item_id:4010001}),'');
 assert.equal(equipmentSummary({item_id:1072128,equipment:{status:'candidate',stats:[{key:'<script>',value:99},{key:'dex',value:'3'}]}}),'');
});

test('decorations and empty captured equipment do not gain an attribute placeholder',()=>{
 assert.equal(equipmentSummary({item_id:1002001,equipment:null}), '');
 assert.equal(equipmentSummary({item_id:1022001,equipment:{status:'candidate',stats:[{key:'dex',value:0}],remaining_upgrades:0}}), '');
});
