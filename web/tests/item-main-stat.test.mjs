import assert from 'node:assert/strict';
import test from 'node:test';
import { mainStat } from '../../frontend/src/lib/item-market.ts';

test('equipment main stat follows the item type and its job', () => {
  assert.equal(mainStat(1302010), 'weapon_attack', 'swords: weapon attack');
  assert.equal(mainStat(1452005), 'weapon_attack', 'bows: weapon attack');
  assert.equal(mainStat(1372006), 'magic_attack', 'wands: magic attack');
  assert.equal(mainStat(1382002), 'magic_attack', 'staves: magic attack');
  assert.equal(mainStat(1040032, 1), 'str', 'warrior top: STR');
  assert.equal(mainStat(1051013, 8), 'luk', 'thief overall: LUK');
  assert.equal(mainStat(1072031, 2), 'int', 'magician shoes: INT');
  assert.equal(mainStat(1002081, 4), 'dex', 'bowman hat: DEX');
  for (const [id, mask] of [[1002081, 0], [1040000, 9], [1050000, null], [1060000, 16]])
    assert.equal(mainStat(id, mask), null, 'all-job, multi-job, unknown or pirate armour has none');
  for (const id of [1082000, 1102000, 1092002, 1032007, 1112222, 1012000, 1022000, 1702022, 1802000])
    assert.equal(mainStat(id, 1), null, 'gloves, capes, shields, accessories, cash weapons and pet gear have none');
  assert.equal(mainStat(2000000), null, 'not equipment');
});
