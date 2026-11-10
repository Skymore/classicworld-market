import json
import struct
import tempfile
import time
import unittest
from pathlib import Path
from market_inventory import Inventory, read_inventory, snapshot


def record(slot, item, quantity):
    data = bytearray(43)
    struct.pack_into('<HBIB', data, 0, slot, 2, item, 0)
    data[8:16] = bytes.fromhex('008005bb46e61702')
    data[16:20] = b'\xff'*4
    data[20] = 1
    struct.pack_into('<H', data, 21, quantity)
    return data


def character():
    # Synthetic protocol fixture: no real character, identifiers or raw capture.
    data = bytearray(600)
    struct.pack_into('<H', data, 0, 0x1a9)
    data[14:24] = bytes.fromhex('00000000000100000000')
    data[229] = 1
    struct.pack_into('<Q', data, 341, 54321)
    struct.pack_into('<6H', data, 353, 30, 35, 30, 40, 150, 300)
    data += record(2, 2000001, 100) + record(5, 2000001, 89) + record(7, 2000003, 8) + bytes(2)
    data += record(1, 3010000, 1) + bytes(2)
    data += record(1, 4000000, 15) + bytes(2)
    data += struct.pack('<HBI', 1, 2, 5000024) + bytes(100)
    return data


def update(*ops):
    return struct.pack('<HBBIB', 0x72, 1, 0, len(ops), 0) + b''.join(ops)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.inventory = Inventory()
        self.inventory.observe(character(), 'one')
        self.assertIsNotNone(self.inventory.view())

    def quantities(self):
        return {i['item_id']: i['quantity'] for i in self.inventory.view()['items']}

    def test_snapshot_totals_and_boundaries(self):
        self.assertEqual(self.quantities()[2000001], 189)
        self.assertEqual(self.inventory.view()['mesos'], 54321)
        for data in (character()[:690], character()+character()[600:], bytes(1400)):
            with self.assertRaises((ValueError, struct.error)):
                snapshot(data)

    def test_multiple_skill_point_books_shift_inventory_fields(self):
        data=character()
        data[229]=2
        data[235:235]=struct.pack('<BI',2,3)
        self.inventory.observe(data,'second-book')
        self.assertEqual(self.quantities()[2000001],189)
        self.assertEqual(self.inventory.view()['mesos'],54321)
        data[235]=0  # Duplicate book must not produce a usable balance.
        self.inventory.observe(data,'bad-books')
        self.assertIsNone(self.inventory.view())

    def test_verified_move_and_quantity_update(self):
        self.inventory.observe(update(struct.pack('<BBhh', 2, 2, 2, 7)), 'one')
        self.assertEqual(self.quantities()[2000001], 189)
        self.inventory.observe(update(struct.pack('<BBhH', 1, 2, 7, 89), struct.pack('<BBhH', 1, 2, 5, 100)), 'one')
        self.assertEqual(self.quantities()[2000001], 189)
        self.inventory.observe(update(struct.pack('<BBh', 3, 2, 7)), 'one')
        self.assertEqual(self.quantities()[2000001], 100)
        self.inventory.observe(update(bytes([0, 2])+record(9, 2000002, 20)), 'one')
        self.assertEqual(self.quantities()[2000002], 20)

    def test_unknown_partial_and_wrong_session(self):
        self.inventory.observe(update(struct.pack('<BBhH', 1, 2, 2, 20)), 'other')
        self.assertEqual(self.quantities()[2000001], 189)
        self.inventory.observe(update(struct.pack('<BBhH', 1, 2, 2, 20), b'\xff'), 'one')
        self.assertEqual(self.inventory.view()['categories'], [])
        self.assertEqual(self.inventory.view()['mesos'], 54321)
        self.inventory.observe(character(), 'two')
        self.inventory.invalidate('one')
        self.assertIsNotNone(self.inventory.view())
        self.inventory.invalidate('two')
        self.assertIsNone(self.inventory.view())

    def test_rechargeable_records_keep_complete_bag_boundaries(self):
        for item in (2070003,2330000):
            data=character()
            data[600:600]=record(1,item,800)+bytes.fromhex('ba814e1b00000000')
            self.inventory.observe(data,'ammo')
            self.assertEqual(self.quantities()[item],800)
            self.assertEqual(self.quantities()[2000001],189)
            self.assertEqual(self.inventory.view()['categories'],[2,3,4])
            self.inventory.observe(update(bytes([0,2])+record(8,item,700)+bytes(8)),'ammo')
            self.assertEqual(self.quantities()[item],1500)

    def test_empty_rechargeable_slots_keep_all_three_bags_decodable(self):
        for item in (2070000,2330000):
            data=character()
            # Match the observed structure: ordinary stacks, two exhausted
            # rechargeable slots with serials, then an ordinary stack.
            pos=600+2*43
            data[pos:pos]=record(6,item,0)+bytes.fromhex('ba814e1b00000000')
            data[pos+51:pos+51]=record(7,item,0)+bytes.fromhex('bb814e1b00000000')
            struct.pack_into('<H',data,pos+102,9)
            self.inventory.observe(data,'empty-ammo')
            self.assertEqual(self.inventory.view()['categories'],[2,3,4])
            self.assertEqual(self.quantities()[item],0)
            self.assertEqual(self.quantities()[2000001],189)
            self.assertEqual(self.quantities()[2000003],8)
            self.assertEqual(self.quantities()[4000000],15)

    def test_rechargeable_quantity_can_reach_zero_and_be_recharged(self):
        for item in (2070000,2330000):
            self.inventory.observe(character(),'one')
            self.inventory.observe(update(bytes([0,2])+record(8,item,3)+bytes(8)),'one')
            self.inventory.observe(update(struct.pack('<BBhH',1,2,8,0)),'one')
            self.assertEqual(self.quantities()[item],0)
            self.assertEqual(self.inventory.view()['categories'],[2,3,4])
            self.inventory.observe(update(struct.pack('<BBhh',2,2,8,9)),'one')
            self.inventory.observe(update(struct.pack('<BBhH',1,2,9,1000)),'one')
            self.assertEqual(self.quantities()[item],1000)

    def test_zero_ordinary_stack_and_truncated_ammo_are_still_invalid(self):
        data=character();struct.pack_into('<H',data,621,0)
        with self.assertRaises(ValueError):snapshot(data)
        self.inventory.observe(update(struct.pack('<BBhH',1,2,2,0)),'one')
        self.assertEqual(self.inventory.view()['categories'],[])
        self.inventory.observe(character(),'two')
        self.inventory.observe(update(bytes([0,2])+record(8,2070000,0)),'two')
        self.assertEqual(self.inventory.view()['categories'],[])

    def test_cash_pet_refresh_does_not_clear_tracked_bags(self):
        pet=bytes([3])+struct.pack('<I',5000007)+bytes([1])+bytes(69)
        refresh=update(struct.pack('<BBh',3,5,7),struct.pack('<BBh',0,5,7)+pet)
        self.assertEqual(len(refresh),92)
        self.inventory.observe(refresh,'one')
        self.assertEqual(self.quantities()[2000001],189)
        # A mixed-bag or malformed envelope must not be mistaken for a pet refresh.
        broken=bytearray(refresh);broken[14]=2
        self.inventory.observe(broken,'one')
        self.assertEqual(self.inventory.view()['categories'],[])

    def test_unknown_bag_layout_keeps_independently_decoded_currency(self):
        data=character();data[602]=9
        self.inventory.observe(data,'partial')
        self.assertEqual(self.inventory.view()['categories'],[])
        self.assertEqual(self.inventory.view()['mesos'],54321)
        self.inventory.observe(bytes.fromhex('7e0000000100000400')+struct.pack('<Q',54000)+bytes(2),'partial')
        self.assertEqual(self.inventory.view()['mesos'],54000)

    def test_unknown_stat_clears_balance(self):
        self.inventory.observe(bytes.fromhex('7e0000000100040000')+struct.pack('<H', 1700)+bytes(2), 'one')
        self.assertEqual(self.inventory.view()['mesos'], 54321, 'HP updates do not change currency')
        self.inventory.observe(bytes.fromhex('7e0000000100000000010100'), 'one')
        self.assertEqual(self.inventory.view()['mesos'], 54321)
        self.inventory.observe(bytes.fromhex('7e0000000100000400')+struct.pack('<Q', 54252)+bytes(2), 'one')
        self.assertEqual(self.inventory.view()['mesos'], 54252)
        self.inventory.observe(bytes.fromhex('7e000001')+bytes(44), 'one')
        self.assertIsNone(self.inventory.view()['mesos'])

    def test_dead_reader_and_disconnected_game(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)
            for stamp, connected, expected in [(time.time(), True, True), (time.time()-30, True, False), (time.time(), False, False)]:
                (p/'inventory_state.json').write_text(json.dumps(dict(alive_at=stamp, holdings=self.inventory.view())))
                self.assertEqual(read_inventory(p, connected) is not None, expected)


if __name__ == '__main__':
    unittest.main()


def gear(slot, item, stats=((16, 59), (1, 3)), upgrades=7):
    # Synthetic equipment record in the current CW layout (no real character data).
    data = bytearray(struct.pack('<hBIB', slot, 1, item, 0))
    data += bytes.fromhex('008005bb46e61702') + b'\xff'*4 + b'\x01'
    data += struct.pack('<I', sum(1 << bit for bit, _ in stats))
    data += b''.join(struct.pack('<H', value) for _, value in sorted(stats))
    data += struct.pack('<I', 0x40001) + bytes([upgrades, 255]) + bytes(100)
    return bytes(data)


def geared():
    base = character()
    worn = gear(1, 1002043, ((10, 18),)) + gear(11, 1452001)
    bag = gear(1, 1302000, ((16, 17),), 5) + gear(3, 1040002, ((1, 2), (10, 20))) + bytes(2)
    return base[:368] + worn + bytes(2) + bag + bytes(16) + base[600:]


class EquipmentBagTests(unittest.TestCase):
    def setUp(self):
        self.inventory = Inventory()
        self.inventory.observe(geared(), 'one')

    def bag(self):
        return {e['slot']: (e['item_id'], {s['key']: s['value'] for s in e['stats']}, e['remaining_upgrades'])
                for e in self.inventory.view()['equipment']}

    def test_snapshot_reads_worn_and_bag_with_stats(self):
        self.assertEqual(self.bag(), {1: (1302000, {'weapon_attack': 17}, 5),
                                      3: (1040002, {'dex': 2, 'weapon_defense': 20}, 7)})
        self.assertEqual(sorted(self.inventory.worn), [1, 11])
        # Ordinary bags are unchanged by the equipment sections.
        self.assertEqual(self.inventory.view()['categories'], [2, 3, 4])

    def test_equip_unequip_remove_and_add(self):
        self.inventory.observe(update(struct.pack('<BBhh', 2, 1, 1, -11)), 'one')
        self.assertEqual(self.bag()[1][0], 1452001)
        self.assertEqual(self.inventory.worn[11]['item_id'], 1302000)
        self.inventory.observe(update(struct.pack('<BBh', 3, 1, 3)), 'one')
        self.assertEqual(sorted(self.bag()), [1])
        self.inventory.observe(update(struct.pack('<BB', 0, 1) + gear(5, 1060002, ((4, 9),))), 'one')
        self.assertEqual(self.bag()[5], (1060002, {'hp': 9}, 7))
        self.assertIsNotNone(self.inventory.slots)

    def test_unbounded_equipment_add_rejects_the_update(self):
        add = struct.pack('<BB', 0, 1) + gear(6, 1060002)
        self.inventory.observe(update(add, struct.pack('<BBh', 3, 1, 1)), 'one')
        self.assertIsNone(self.inventory.slots)
        self.assertNotIn('equipment', self.inventory.view() or {})

    def test_unrecognised_sections_leave_equipment_unknown(self):
        data = bytearray(geared())
        data[368+17] ^= 0xff  # break the first record's ffffffff marker
        inventory = Inventory(); inventory.observe(bytes(data), 'one')
        self.assertIsNotNone(inventory.slots)
        self.assertNotIn('equipment', inventory.view())
