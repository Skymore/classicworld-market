import unittest
from dataclasses import replace

from sweep_purchase import PurchaseHalt, PurchaseOrder, PurchaseResult, load_purchaser
from sweep_purchase_flow import Action, Listing, PurchaseFlow, Receipt, View


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.now, self.allowed = 0, True
        self.order = PurchaseOrder('reservation', 2000000, 'Red Potion', 2, 15, 40, 1, 1,
                                   None, 123, 'Seller', 10, 36, 15, lambda: self.allowed)
        self.listing = Listing.from_order(self.order)
        self.shop = View('shop', self.listing, stock=85, mesos=412, shop_verified=True)
        self.flow = PurchaseFlow(self.order, clock=lambda: self.now)

    def to_quantity(self):
        self.assertEqual(self.flow.step(self.shop), Action('select'))
        self.assertIsNone(self.flow.step(self.shop), 'do not repeat a selection click')
        self.assertEqual(self.flow.step(replace(self.shop, selected=True)), Action('buy'))
        self.assertIsNone(self.flow.step(self.shop), 'do not repeat Buy on a stale frame')

    def to_confirm(self):
        self.to_quantity()
        self.assertEqual(self.flow.step(View('quantity', quantity=1)), Action('quantity', 1))
        self.assertIsNone(self.flow.step(View('quantity', quantity=85)))
        self.assertIsNone(self.flow.step(View('quantity')))
        self.assertEqual(self.flow.step(View('quantity', quantity=1)), Action('accept_quantity'))
        self.assertIsNone(self.flow.step(View('quantity', quantity=1)))

    def submitted(self):
        self.to_confirm()
        self.assertEqual(self.flow.step(View('confirm', total=40)), Action('confirm'))
        self.assertIsNone(self.flow.step(View('confirm', total=40)), 'never confirm twice')

    def test_observed_trade_lock_flow_never_reports_bought(self):
        self.submitted()
        self.assertEqual(self.flow.step(View('rejected', reason='trade_locked')), Action('dismiss'))
        self.assertIsNone(self.flow.step(View('rejected', reason='trade_locked')), 'dismiss only once')
        result = self.flow.step(self.shop)
        self.assertEqual(result, PurchaseResult('not_bought', reason='trade_locked'))
        self.assertEqual(self.flow.step(self.shop), result)

    def test_mismatched_listing_including_equipment_is_not_selected(self):
        for key, value in [('price', 41), ('bundle', 2), ('item_id', 2000001), ('slot', 16),
                           ('owner', 'Other'), ('shop_id', 124), ('room', 1), ('channel', 1),
                           ('category', 1), ('equipment', {'str': 1})]:
            with self.subTest(key=key):
                flow = PurchaseFlow(self.order, clock=lambda: self.now)
                result = flow.step(replace(self.shop, listing=replace(self.listing, **{key: value})))
                self.assertEqual(result, PurchaseResult('not_bought', reason='price_changed'))

    def test_price_is_rechecked_after_selection(self):
        self.flow.step(self.shop)
        changed = replace(self.shop, listing=replace(self.listing, price=400), selected=True)
        self.assertEqual(self.flow.step(changed), PurchaseResult('not_bought', reason='price_changed'))

    def test_total_must_match_exactly_before_final_confirmation(self):
        for value in (None, 400, 4, True, 40.0):
            with self.subTest(value=value):
                self.setUp()
                self.to_confirm()
                self.assertEqual(self.flow.step(View('confirm', total=value)), Action('cancel'))
                self.assertEqual(self.flow.step(self.shop), PurchaseResult('not_bought', reason='price_changed'))

    def test_stop_before_submission_cancels_and_waits_for_open_shop(self):
        self.to_confirm()
        self.allowed = False
        self.assertEqual(self.flow.step(View('confirm', total=40)), Action('cancel'))
        self.assertIsNone(self.flow.step(View('confirm', total=40)))
        self.assertEqual(self.flow.step(self.shop), PurchaseResult('not_bought', reason='stopped'))

    def test_unknown_after_submit_stays_unknown_when_stopped(self):
        self.submitted()
        self.allowed = False
        self.assertIsNone(self.flow.step(replace(self.shop, stock=84)), 'stock change is not our receipt')
        self.now = 15
        with self.assertRaises(PurchaseHalt) as caught:
            self.flow.step(self.shop)
        self.assertEqual(caught.exception.result, PurchaseResult('unknown', reason='timeout'))

    def test_focus_loss_and_dispatch_error_never_retry(self):
        self.submitted()
        with self.assertRaises(PurchaseHalt) as caught:
            self.flow.step(View('pending', focused=False))
        self.assertEqual(caught.exception.result.status, 'unknown')
        with self.assertRaises(PurchaseHalt) as caught:
            self.flow.halt()
        self.assertEqual(caught.exception.result.status, 'unknown')
        with self.assertRaises(PurchaseHalt):
            self.flow.step(self.shop)  # Restored focus never resumes a halted attempt.

    def test_multiple_bundles_use_entered_quantity_and_total_not_unit_price(self):
        self.order = replace(self.order, quantity=3, bundle=10)
        self.listing = Listing.from_order(self.order)
        self.shop = replace(self.shop, listing=self.listing)
        self.flow = PurchaseFlow(self.order, clock=lambda: self.now)
        self.to_quantity()
        self.assertEqual(self.flow.step(View('quantity', quantity=1)), Action('quantity', 3))
        self.assertIsNone(self.flow.step(View('quantity', quantity=1)))
        self.assertEqual(self.flow.step(View('quantity', quantity=3)), Action('accept_quantity'))
        self.assertEqual(self.flow.step(View('confirm', total=120)), Action('confirm'))
        self.assertEqual(self.flow.step(replace(self.shop, receipt=Receipt(
            'reservation', self.listing, 3, 120))), PurchaseResult('bought', 3, 120))

    def test_stock_and_readable_balance_are_required(self):
        for view, reason in [(replace(self.shop, stock=0), 'sold_out'),
                             (replace(self.shop, mesos=None), 'error'),
                             (replace(self.shop, mesos=39), 'not_enough_mesos')]:
            flow = PurchaseFlow(self.order, clock=lambda: self.now)
            self.assertEqual(flow.step(view), PurchaseResult('not_bought', reason=reason))

    def test_cleanup_timeout_preserves_confirmed_rejection(self):
        self.submitted()
        self.flow.step(View('rejected', reason='trade_locked'))
        self.now = 15
        with self.assertRaises(PurchaseHalt) as caught:
            self.flow.step(View('rejected', reason='trade_locked'))
        self.assertEqual(caught.exception.result, PurchaseResult('not_bought', reason='trade_locked'))

    def test_receipt_requires_attempt_identity_exact_cost_and_open_shop(self):
        receipt = Receipt('reservation', self.listing, 1, 40)
        for wrong in (replace(receipt, reservation='old'), replace(receipt, spent=41),
                      replace(receipt, quantity=2), replace(receipt, listing=replace(self.listing, slot=22))):
            with self.subTest(receipt=wrong):
                self.setUp()
                self.submitted()
                with self.assertRaises(PurchaseHalt) as caught:
                    self.flow.step(replace(self.shop, receipt=wrong))
                self.assertEqual(caught.exception.result.status, 'unknown')
        self.setUp()
        self.submitted()
        self.allowed = False  # Stopping after a real purchase must not hide its result.
        self.assertEqual(self.flow.step(replace(self.shop, receipt=receipt)), PurchaseResult('bought', 1, 40))

    def test_verified_receipt_with_unknown_dialog_halts_but_preserves_payment(self):
        self.submitted()
        with self.assertRaises(PurchaseHalt) as caught:
            self.flow.step(View('pending', receipt=Receipt('reservation', self.listing, 1, 40)))
        self.assertEqual(caught.exception.result, PurchaseResult('bought', 1, 40))

    def test_default_guard_is_closed_and_native_executor_still_unavailable(self):
        order = replace(self.order, can_buy=PurchaseOrder.__dataclass_fields__['can_buy'].default)
        result = PurchaseFlow(order, clock=lambda: 0).step(self.shop)
        self.assertEqual(result, PurchaseResult('not_bought', reason='stopped'))
        self.assertFalse(load_purchaser().status().ready)


if __name__ == '__main__':
    unittest.main()
