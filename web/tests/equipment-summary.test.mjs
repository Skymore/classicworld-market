import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/lib/equipment-summary.js',import.meta.url),'utf8');
const {equipmentSummary}=await import('data:text/javascript,'+encodeURIComponent(source));
test('different equipment offers keep their captured values and remaining zero slots',()=>{
 const row={item_id:1072128,equipment:{status:'candidate',stats:[{key:'weapon_defense',value:18},{key:'dex',value:2}],remaining_upgrades:0,enhancements:1}};
 assert.equal(equipmentSummary(row),'敏 +2 · 物防 +18 · 强化 +1 · 可升 0');
 assert.equal(equipmentSummary({...row,equipment:{...row.equipment,stats:[{key:'dex',value:4}]}}),'敏 +4 · 强化 +1 · 可升 0');
 assert.match(equipmentSummary(row,true),/DEX \+2/);
});
test('missing or unsupported captured values never fall back to catalogue defaults',()=>{
 assert.equal(equipmentSummary({item_id:1072128,equipment:{status:'unsupported'},base_stats:{dex:10}}),'');
 assert.equal(equipmentSummary({item_id:4010001}),'');
 assert.equal(equipmentSummary({item_id:1072128,equipment:{status:'candidate',stats:[{key:'<script>',value:99},{key:'dex',value:'3'}]}}),'');
});

test('compact Chinese attribute names remain consistent across all captured stats',()=>{
 const keys=['weapon_attack','magic_attack','str','dex','int','luk','weapon_defense','magic_defense','hp','mp','accuracy','avoid','speed','jump'];
 assert.equal(equipmentSummary({item_id:1072128,equipment:{status:'candidate',stats:keys.map(key=>({key,value:1})),remaining_upgrades:7}}),'物攻 +1 · 魔攻 +1 · 力 +1 · 敏 +1 · 智 +1 · 运 +1 · 物防 +1 · 魔防 +1 · HP +1 · MP +1 · 命中 +1 · 回避 +1 · 移速 +1 · 跳跃 +1 · 可升 7');
});

test('decorations and empty captured equipment do not gain an attribute placeholder',()=>{
 assert.equal(equipmentSummary({item_id:1002001,equipment:null}), '');
 assert.equal(equipmentSummary({item_id:1022001,equipment:{status:'candidate',stats:[{key:'dex',value:0}],remaining_upgrades:0}}), '');
});
