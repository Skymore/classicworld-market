"""Item accounting through the real inventory decoder; synthetic wire data only."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

import grind_protocol as proto
from grind_tracker import Tracker
from market_inventory import Inventory
from test_grind_live import item_message
from test_grind_tracker import Clock, prices, portal
from test_market_inventory import character, update, record


class ItemAccountingTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        data = Path(self.folder.name) / 'grind'
        data.mkdir()
        (data / 'settings.json').write_text(json.dumps(dict(record_frames=False)))
        self.clock = Clock()
        self.tracker = Tracker(self.folder.name, prices(), now=self.clock)
        self.inventory = Inventory()
        self.send(character())
        self.who = self.tracker.characters['s']
        self.who.level, self.who.map_id = 30, 104040000
        # A mapping table is required to distinguish manual and pet requests.
        self.who.table = list(range(900))
        self.who.client_seen = True
        for _ in range(3):
            self.clock.t += 1
            self.tracker.gain(self.who, self.clock(), 100)

    def tearDown(self):
        self.folder.cleanup()

    def send(self, data, after=0):
        self.clock.t += after
        self.inventory.observe(data, 's')
        self.tracker.observe('s', data, self.inventory)

    def quantity(self, slot, count):
        self.send(update(struct.pack('<BBhH', 1, 2, slot, count)))

    def request(self, item=2000001, slot=2, pet=False):
        data = struct.pack('<H', 321 if pet else 73) + (b'\0' if pet else b'')
        data += struct.pack('<IhII', 12345, slot, item, 1)
        self.tracker.observe_client('s', data)

    def total(self, kind, item):
        return sum(e['quantity'] for e in self.who.run.ledger if e['kind'] == kind and e.get('item_id') == item)

    def test_bag_then_message_and_message_then_bag_both_count_once(self):
        self.quantity(2, 102)
        self.assertEqual(self.total('loot', 2000001), 0)
        self.send(item_message(2000001, 2), .01)
        self.send(item_message(2000001, 3), .01)
        self.quantity(2, 105)
        self.assertEqual(self.total('loot', 2000001), 5)
        self.quantity(2, 110)  # no additional pickup proof
        self.assertEqual(self.total('loot', 2000001), 5)
        self.assertEqual(self.total('used', 2000001), 0)

    def test_quantity_budget_covers_split_stacks_without_overcount(self):
        self.send(item_message(2000001, 4))
        self.quantity(2, 102)
        self.quantity(5, 94)  # only two of these five have a pickup receipt
        self.assertEqual(self.total('loot', 2000001), 4)
        self.send(item_message(2000001, 3))
        self.assertEqual(self.total('loot', 2000001), 7)

    def test_late_or_unrelated_messages_do_not_count(self):
        self.quantity(2, 101)
        self.send(item_message(2000003))
        self.send(item_message(2000001), 2.1)
        self.assertEqual(self.total('loot', 2000001), 0)
        self.clock.t += 2.1
        self.quantity(2, 102)
        self.assertEqual(self.total('loot', 2000001), 0)

    def test_snapshot_gap_and_map_change_clear_pending_matches(self):
        for boundary in (character(), update(b'\xff'), portal(104040001)):
            with self.subTest(boundary=boundary[:2].hex()):
                self.send(character())
                self.who.run.status = 'active'
                self.quantity(2, 101)
                self.send(boundary)
                self.send(item_message(2000001))
                self.assertEqual(self.total('loot', 2000001), 0)

    def test_manual_and_pet_potions_require_successful_decrease(self):
        self.request()
        self.assertEqual(self.total('used', 2000001), 0)
        self.quantity(2, 99)
        self.request(pet=True)
        self.quantity(2, 98)
        self.quantity(2, 88)  # dropped / transferred, no use request
        self.assertEqual(self.total('used', 2000001), 2)
        self.send(item_message(2000001, 2))
        self.quantity(2, 90)
        self.assertEqual(self.total('used', 2000001), 2)
        self.assertEqual(self.total('loot', 2000001), 2)

    def test_failed_expired_and_wrong_slot_requests_are_not_uses(self):
        self.request(slot=7)  # that slot holds a different potion
        self.quantity(2, 99)
        self.clock.t += 2.1
        self.request()
        self.clock.t += 2.1
        self.quantity(2, 98)
        self.assertEqual(self.total('used', 2000001), 0)

    def test_server_decrease_can_arrive_before_client_request(self):
        self.quantity(7, 1)
        self.clock.t += 3  # discard this unconfirmed adjustment
        self.send(update(struct.pack('<BBh', 3, 2, 7)))
        self.request(item=2000003, slot=7, pet=True)
        self.assertEqual(self.total('used', 2000003), 1)

    def test_use_proof_does_not_match_another_stack_of_the_same_potion(self):
        self.request(slot=2)
        self.quantity(5, 88)
        self.assertEqual(self.total('used', 2000001), 0)
        self.quantity(2, 99)
        self.assertEqual(self.total('used', 2000001), 1)

    def test_no_client_stream_keeps_inventory_estimate(self):
        self.who.client_seen = False
        self.quantity(2, 99)
        self.assertEqual(self.total('used', 2000001), 1)

    def test_loot_from_paused_interval_does_not_leak_into_resumed_run(self):
        self.who.run.status = 'paused'
        self.quantity(2, 101)
        self.who.run.status = 'active'
        self.send(item_message(2000001))
        self.assertEqual(self.total('loot', 2000001), 0)

    def test_empty_potion_shows_zero_and_unknown_inventory_stays_unknown(self):
        self.request(item=2000003, slot=7, pet=True)
        self.quantity(7, 1)
        self.request(item=2000003, slot=7)
        self.send(update(struct.pack('<BBh', 3, 2, 7)))
        row = self.tracker.summarize(self.who.run, self.clock(), self.who)['consumables'][0]
        self.assertEqual((row['used'], row['remaining'], row['minutes_left']), (2, 0, 0))
        self.send(update(b'\xff'))
        row = self.tracker.summarize(self.who.run, self.clock(), self.who)['consumables'][0]
        self.assertIsNone(row['remaining'])

    def test_moving_stacks_is_neither_loot_nor_use(self):
        self.send(update(struct.pack('<BBhh', 2, 2, 2, 7)))
        self.send(update(struct.pack('<BBhH', 1, 2, 7, 99), struct.pack('<BBhH', 1, 2, 5, 90)))
        self.assertEqual(self.total('used', 2000001), 0)
        self.assertEqual(self.total('loot', 2000001), 0)

    def test_new_stack_and_equipment_keep_pickup_quantity_and_stats(self):
        self.send(update(bytes([0, 2]) + record(9, 2000000, 3)))
        self.send(item_message(2000000, 3))
        piece = dict(stats=[dict(key='weapon_attack', value=3)], remaining_upgrades=5)
        self.tracker.loot(self.who, 1082002, 1, piece, self.clock())
        self.send(item_message(1082002))
        self.assertEqual(self.total('loot', 2000000), 3)
        summary = self.tracker.summarize(self.who.run, self.clock(), self.who)
        self.assertEqual(summary['item_value'], 900000 + 3 * 40)

    def test_malformed_pickup_is_not_a_default_one_item(self):
        rule = proto.verified_profile()['pickup']
        for data in (item_message(2000001)[:9], item_message(2000001, 0),
                     item_message(2000001)[:4] + b'\x02' + item_message(2000001)[5:]):
            self.assertIsNone(proto.pickup(data, rule))


if __name__ == '__main__':
    unittest.main()
