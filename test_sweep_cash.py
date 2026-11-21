"""Cash warning can complete a purchase without an ordinary inventory delta."""
from dataclasses import replace
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sweep_purchase import PurchaseHalt, PurchaseResult
from sweep_purchaser_windows import WindowsPurchaser, inventory_position
from test_sweep_equipment import cash_order
from test_sweep_screen import Page, ScriptedInput, ScriptedReader


class CashReader(ScriptedReader):
    def dialog(self, image):
        if self.frame(image)['kind'] == 'cash_confirm':
            return 'cash_confirm', None
        return super().dialog(image)


class CashReceiptTests(unittest.TestCase):
    def run_buy(self, *, after=None, inventory=True, closed=False, order=None):
        # No cash category in either snapshot, matching the real collector.
        frames = [Page(kind='shop', balance=3264579),
                  Page(kind='shop', selected=True, balance=3264579),
                  Page(kind='cash_confirm'),
                  Page(kind='closed' if closed else 'shop', balance=3144579)]
        self.control = ScriptedInput(frames)
        self.now = 0
        def pause(seconds):
            self.now += seconds
        def read():
            state = dict(session='s', revision=10, mesos=3264579, categories=[2, 3, 4], items=[])
            if self.control.index == 3:
                state.update(revision=11, mesos=3144579)
                state.update(after or {})
            return state
        window = SimpleNamespace(capture_file='visit.json', pause=pause, bounds=(0, 0, 1366, 768),
            capture=lambda: ('raw', (0, 0, 1366, 768)),
            vision=SimpleNamespace(window_markers=lambda raw: dict(owner=False, leave=False)))
        buyer = WindowsPurchaser(CashReader(frames), lambda _: self.control, lambda: self.now)
        order = replace(order or cash_order(), deadline=1, inventory=read if inventory else None)
        with patch('sweep_purchaser_windows.ordered_snapshot',
                   return_value=('Potions', [{'stock': 1}]*8, 2)):
            return buyer.buy(order, window)

    def test_single_coupon_direct_warning_settles_exact_packet_debit(self):
        self.assertEqual(self.run_buy(), PurchaseResult('bought', 1, 120000))
        self.assertEqual(self.control.actions, [(535, 321), (604, 252), (735, 431)])

    def test_direct_cash_purchase_that_closes_store_settles(self):
        self.assertEqual(self.run_buy(closed=True), PurchaseResult('bought', 1, 120000, 'shop_closed'))
        self.assertEqual(self.control.actions.count((735, 431)), 1)

    def test_missing_stale_cross_session_and_wrong_debit_remain_unknown(self):
        for changes in ({'inventory': False}, {'after': {'session': 'new'}},
                        {'after': {'revision': 10}}, {'after': {'mesos': 3264579}},
                        {'after': {'mesos': 3144578}}):
            with self.subTest(changes=changes), self.assertRaises(PurchaseHalt) as caught:
                self.run_buy(**changes)
            self.assertEqual(caught.exception.result.status, 'unknown')
            self.assertEqual(self.control.actions.count((735, 431)), 1)

    def test_missing_cash_bag_does_not_allow_bulk_or_wrong_category_receipts(self):
        state = dict(session='s', revision=1, mesos=1000000, categories=[2, 3, 4], items=[])
        for changes in ({'quantity': 2}, {'bundle': 2}, {'item_id': 2000002}, {'category': 4}):
            order = cash_order(inventory=lambda: state, **changes)
            position = inventory_position(order)
            # An ordinary decoded category may yield a count, never a debit-only receipt.
            self.assertTrue(position is None or position[3] is not None)


if __name__ == '__main__':
    unittest.main()
