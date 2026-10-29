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
        self.assertIsNone(self.inventory.view())
        self.inventory.observe(character(), 'two')
        self.inventory.invalidate('one')
        self.assertIsNotNone(self.inventory.view())
        self.inventory.invalidate('two')
        self.assertIsNone(self.inventory.view())

    def test_unknown_stat_clears_balance(self):
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
