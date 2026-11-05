"""Single-piece equipment purchases: unique row, exact total, packet debit."""
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
import struct
import unittest

from market_inventory import Inventory
from sweep_purchase import PurchaseHalt, PurchaseOrder, PurchaseResult
from sweep_purchase_flow import PurchaseFlow, View
from sweep_purchaser_windows import WindowsPurchaser, inventory_position
from sweep_screen import Reader, Row
from test_sweep_screen import Page, ScriptedInput, ScriptedReader

KNIFE = 1332005
EQUIPMENT = dict(status='candidate', stats=[dict(key='attack', value=20)])


def knife_order(**changes):
    order = PurchaseOrder('r1', KNIFE, 'Coconut Knife', 1, 7, 4900, 1, 1, EQUIPMENT,
                          1512, 'Nyangkkun', 5, 16, 20, lambda: True)
    return replace(order, **changes)


class EquipmentPurchaseTests(unittest.TestCase):
    def setUp(self):
        self.now = 0

    def run_buy(self, frames, order, inventory=None):
        self.control = ScriptedInput(frames)
        window = SimpleNamespace(capture_file='visit.json', pause=lambda seconds: None)
        buyer = WindowsPurchaser(ScriptedReader(frames), lambda window: self.control, lambda: self.now)
        if inventory is not None:
            order = replace(order, inventory=inventory)
        with patch('sweep_purchaser_windows.ordered_snapshot',
                   return_value=('Potions', [{'stock': 1}]*8, 2)):
            return buyer.buy(order, window)

    def packet(self, before=10000, after=5100):
        def read():
            final = self.control.index == len(self.control.frames)-1
            # The equipment bag is undecoded: ordinary bags may even be lost.
            return dict(session='s', revision=9 if final else 4, mesos=after if final else before,
                        categories=[], items=[])
        return read

    def test_direct_total_prompt_buys_one_piece_from_packet_debit(self):
        frames = [Page(kind='shop', balance=10000), Page(kind='shop', selected=True, balance=10000),
                  Page(kind='confirm', number=4900), Page(kind='shop', selected=True, balance=5100)]
        self.assertEqual(self.run_buy(frames, knife_order(), self.packet()),
                         PurchaseResult('bought', 1, 4900))
        self.assertEqual(self.control.actions, [(535, 321), (604, 252), (735, 421)])

    def test_quantity_prompt_is_still_typed_and_read_back(self):
        frames = [Page(kind='shop', balance=10000), Page(kind='shop', selected=True, balance=10000),
                  Page(kind='quantity'), Page(kind='quantity', number=1),
                  Page(kind='confirm', number=4900), Page(kind='shop', selected=True, balance=5100)]
        self.assertEqual(self.run_buy(frames, knife_order(), self.packet()),
                         PurchaseResult('bought', 1, 4900))
        self.assertIn(('quantity', 1), self.control.actions)

    def test_wrong_total_is_cancelled_without_confirming(self):
        frames = [Page(kind='shop', balance=10000), Page(kind='shop', selected=True, balance=10000),
                  Page(kind='confirm', number=49000), Page(kind='shop', balance=10000)]
        self.assertEqual(self.run_buy(frames, knife_order(), self.packet()),
                         PurchaseResult('not_bought', reason='price_changed'))
        self.assertNotIn((735, 421), self.control.actions)

    def test_debit_without_exact_price_never_becomes_a_receipt(self):
        frames = [Page(kind='shop', balance=10000), Page(kind='shop', selected=True, balance=10000),
                  Page(kind='confirm', number=4900), Page(kind='shop', selected=True, balance=10000)]
        self.now = 0
        order = knife_order(deadline=3)
        clock = iter(range(1000))
        self.control = None
        with self.assertRaises(PurchaseHalt) as caught:
            control = ScriptedInput(frames)
            self.control = control
            window = SimpleNamespace(capture_file='visit.json', pause=lambda seconds: None)
            buyer = WindowsPurchaser(ScriptedReader(frames), lambda window: control, lambda: next(clock)*.1)
            with patch('sweep_purchaser_windows.ordered_snapshot', return_value=('Potions', [{'stock': 1}]*8, 2)):
                buyer.buy(replace(order, inventory=self.packet(after=9000)), window)
        self.assertEqual(caught.exception.result.status, 'unknown')
        self.assertEqual(control.actions.count((735, 421)), 1)

    def test_more_than_one_piece_or_bundle_is_refused_before_input(self):
        for order in (knife_order(quantity=2), knife_order(bundle=2)):
            frames = [Page(kind='shop')]
            self.assertEqual(self.run_buy(frames, order), PurchaseResult('not_bought', reason='error'))
            self.assertEqual(self.control.actions, [])

    def test_equipment_position_is_balance_only(self):
        state = dict(session='s', revision=3, mesos=700, categories=[], items=[])
        self.assertEqual(inventory_position(knife_order(inventory=lambda: state)), ('s', 3, 700, None))
        potion = knife_order(item_id=2000001, category=2, equipment=None, inventory=lambda: state)
        self.assertIsNone(inventory_position(potion))


class EquipmentFlowTests(unittest.TestCase):
    def test_confirm_in_place_of_quantity_is_only_for_one_equipment_piece(self):
        for order, allowed in ((knife_order(), True),
                               (knife_order(item_id=2000001, category=2, equipment=None), False)):
            flow = PurchaseFlow(order, lambda: 0)
            flow.phase = 'quantity'
            view = View('confirm', total=4900)
            if allowed:
                self.assertEqual(flow.step(view).kind, 'confirm')
                self.assertTrue(flow.submitted)
            else:
                with self.assertRaises(PurchaseHalt):
                    flow.step(view)
                self.assertFalse(flow.submitted)


class EquipmentNameTests(unittest.TestCase):
    def test_shop_display_name_matches_target_but_another_name_does_not(self):
        reader = Reader()
        packet = dict(item_id=1041040, price=2999, bundle=1)  # catalog name ends in (F)
        self.assertTrue(reader.row_matches(Row('Green Bennis Chainmail', 1, 2999, True, False), packet, complete=True))
        self.assertTrue(reader.row_matches(Row('Green Bennis Ch...', 1, 2999, True, False), packet, complete=True))
        self.assertFalse(reader.row_matches(Row('Blue Bennis Chainmail', 1, 2999, True, False), packet, complete=True))
        self.assertFalse(reader.row_matches(Row('Green Bennis Chainmail', 1, 2998, True, False), packet, complete=True))
        potion = dict(item_id=2000002, price=280, bundle=1)
        self.assertFalse(reader.row_matches(Row('White Po...', 1, 280, True, False), potion, complete=True))


class EquipmentInventoryTests(unittest.TestCase):
    def inventory(self):
        inventory = Inventory()
        inventory.session = 's'
        inventory.capacities = (24, 24, 24, 24, 24, 24)
        inventory.slots = {(2, 1): (2000001, 10)}
        return inventory

    def add(self, category=1, item=KNIFE, kind=1, count=1):
        body = struct.pack('<BBhBIB', 0, category, 3, kind, item, 0) + bytes(30)
        return bytes.fromhex('7200') + bytes([1, 0]) + struct.pack('<I', count) + b'\x00' + body

    def test_single_equipment_add_keeps_ordinary_bags(self):
        inventory = self.inventory()
        inventory.observe(self.add(), 's')
        self.assertEqual(inventory.slots, {(2, 1): (2000001, 10)})

    def test_other_unsupported_changes_still_clear_ordinary_bags(self):
        for packet in (self.add(item=2000001), self.add(kind=2), self.add(count=2)):
            inventory = self.inventory()
            inventory.observe(packet, 's')
            self.assertIsNone(inventory.slots)


class EquipmentVerifyTests(unittest.TestCase):
    def test_bag_check_is_skipped_only_when_asked(self):
        import sweep_purchaser_windows as windows
        for bag in (True, False):
            buyer = WindowsPurchaser(SimpleNamespace(shop=lambda image: True, dialog=lambda image: (None, None)),
                                     lambda window: SimpleNamespace(move=lambda: None, capture=lambda: 'img',
                                                                    click=lambda x, y: None),
                                     clock=lambda: 0)
            window = SimpleNamespace(pause=lambda seconds: None, bounds=(0, 0, 1366, 768),
                                     capture=lambda: ('raw', (0, 0, 1366, 768)),
                                     vision=SimpleNamespace(window_markers=lambda raw: dict(owner=False, leave=False)))
            with patch('inventory_check.InventoryChecker') as checker, \
                    patch('shop_window_control.game_menu_visible', return_value=False), \
                    patch('shop_window_control.single_button_notice_visible', return_value=False):
                self.assertTrue(buyer.verify_inventory(window, 'folder', None, bag=bag))
            self.assertEqual(checker.called, bag)


if __name__ == '__main__':
    unittest.main()
