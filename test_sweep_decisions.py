"""Ticket #6: captured stock, rules, disabled buying and reason persistence."""
import json
import time
import unittest
from types import SimpleNamespace
import test_collector_sweep as fixtures
from sweep_purchase import PurchasePreparationSkipped, PurchaseResult
from test_collector_sweep import plan


class DecisionTests(unittest.TestCase):
    setUp = fixtures.EngineTests.setUp
    tearDown = fixtures.EngineTests.tearDown
    make = fixtures.EngineTests.make
    settings = fixtures.EngineTests.settings
    joined = fixtures.EngineTests.joined
    capture = fixtures.EngineTests.capture
    def decisions(self):
        return [json.loads(line) for line in (self.engine.home/'decisions.jsonl').read_text(encoding='utf-8').splitlines()]

    def test_ticket_prices_and_mixed_sold_out_rows_with_unlimited_order(self):
        for iid,price,stock in [(2000001,130,565),(2000002,280,60)]:
            self.engine=self.make();self.settings()
            p=plan(item=iid,limit=1000);p['watches'][0]['groups'][0]['cap']=price
            self.server.invite(plan=p);self.engine.poll()
            rows=[dict(item_id=iid,slot=slot,price_mesos_candidate=price,bundle_quantity_candidate=1,
                       available_quantity_candidate=count) for slot,count in [(1,0),(2,stock)]]
            before=len(self.server.named('reserve'))
            self.engine.on_shop_open(self.capture(items=rows),'window')
            request=self.server.named('reserve')[before:]
            self.assertEqual(len(request),1)
            self.assertEqual(request[0]['location']['slot'],2)
            self.assertGreater(request[0]['quantity'],0,'max_order=0 removes only the per-order limit')
            reasons={e['reason'] for e in self.decisions()}
            self.assertTrue({'sold_out','rule_matched','bought'} <= reasons)

    def test_disabled_capture_is_logged_without_reservation_or_input(self):
        self.engine.idle_rules={'watches':[{'item_id':2000001}]}
        c=self.capture(items=[dict(item_id=2000001,slot=1,price_mesos_candidate=130,
            bundle_quantity_candidate=1,available_quantity_candidate=565)])
        self.engine.collector_event(dict(type='captured',file=c['file']))
        self.assertIn('buying_disabled',[e['reason'] for e in self.decisions()])
        self.assertEqual(self.server.named('reserve'),[])

    def test_rule_miss_and_duplicate_both_explain_why(self):
        self.joined()
        c=self.capture()
        self.engine.on_shop_open(c,'window');self.engine.on_shop_open(c,'window')
        over=self.capture(items=[dict(item_id=1002000,slot=3,price_mesos_candidate=101,
            bundle_quantity_candidate=1,available_quantity_candidate=10)])
        self.engine.on_shop_open(over,'window')
        reasons={e['reason'] for e in self.decisions()}
        self.assertTrue({'already_attempted','rule_not_matched'} <= reasons)

    def test_reservation_network_failure_is_logged_without_buying(self):
        self.joined();self.server.down.add('reserve')
        self.engine.on_shop_open(self.capture(),'window')
        self.assertIn('reservation_unreachable',[e['reason'] for e in self.decisions()])

    def test_local_prepare_failure_can_retry_but_missing_reservation_response_cannot(self):
        self.joined();c=self.capture()
        self.purchaser.prepare=lambda window:False
        self.engine.on_shop_open(c,'window')
        self.assertEqual(self.server.named('reserve'),[])
        self.purchaser.prepare=lambda window:True
        self.server.down.add('reserve')
        self.engine.on_shop_open(c,'window')
        self.server.down.clear()
        self.engine.on_shop_open(c,'window')
        self.assertEqual(len(self.server.named('reserve')),1)

    def test_unrecognized_read_only_preparation_skips_then_allows_next_visit(self):
        self.joined();capture=self.capture()
        def unsupported(window):raise PurchasePreparationSkipped('listing_unverified')
        self.purchaser.prepare=unsupported
        self.engine.on_shop_open(capture,'window')
        self.assertEqual(self.server.named('reserve'),[])
        self.assertEqual(self.server.named('leave'),[])
        self.assertEqual(self.purchaser.orders,[])
        self.assertTrue(self.engine.buying())
        self.assertIn('prepare_skipped',[row['reason'] for row in self.decisions()])
        self.assertEqual(self.decisions()[-1]['reason'],'listing_unverified')
        self.purchaser.prepare=lambda window:True
        self.engine.on_shop_open(capture,'window')
        self.assertEqual(len(self.server.named('reserve')),1)


class SameShopTests(unittest.TestCase):
    """Issue #6: a verified purchase closes the shop; its other matching rows are re-opened or explained."""
    tearDown = fixtures.EngineTests.tearDown
    make = fixtures.EngineTests.make
    settings = fixtures.EngineTests.settings
    joined = fixtures.EngineTests.joined
    capture = fixtures.EngineTests.capture
    decisions = DecisionTests.decisions

    def rows(self, *slots, stock=2):
        return [dict(item_id=fixtures.ITEM, slot=s, price_mesos_candidate=100, bundle_quantity_candidate=1,
                     available_quantity_candidate=stock) for s in slots]

    def visit(self, name, rows, revisit=None, **capture):
        """One scanner opening: collector event, then the callback with a window like the scanner's."""
        c = self.capture(name, items=rows, **capture)
        self.engine.collector_event(dict(type='captured', file=c['file']))
        return self.engine.on_shop_open(c, SimpleNamespace(capture_file=c['file'], revisit=revisit))

    def reasons(self, slot):
        return [d['reason'] for d in self.decisions() if d.get('slot') == slot]

    def setUp(self):
        fixtures.EngineTests.setUp(self)
        self.joined()
        self.verified = []
        self.purchaser.verify_inventory = lambda window, folder, expected: self.verified.append(window) or True
        guards = []
        def buy(order):
            # The engine-side guards are live for the re-opened capture, as on a first visit.
            guards.append((order.slot, order.visit_current(), order.can_buy(), order.deadline > time.monotonic()))
            return PurchaseResult('bought', order.quantity, order.quantity*order.price)
        self.purchaser.result, self.guards = buy, guards

    def test_second_matching_row_is_bought_after_reopening_the_same_shop(self):
        request = self.visit('shop_a.json', self.rows(1, 2))
        self.assertIs(request.shop_revisit, True)
        self.assertEqual([b['location']['slot'] for b in self.server.named('reserve')], [1])
        self.assertIn('revisit_requested', self.reasons(2))
        self.assertIsNone(self.visit('shop_a2.json', self.rows(2), revisit=request))
        self.assertEqual([b['location']['slot'] for b in self.server.named('reserve')], [1, 2])
        self.assertEqual([s['status'] for s in self.server.named('settle')], ['bought', 'bought'])
        self.assertEqual(len(self.verified), 2, 'every purchase still verifies the backpack')
        self.assertEqual(self.guards, [(1, True, True, True), (2, True, True, True)])
        self.assertEqual([d['reason'] for d in self.decisions()].count('bought'), 2)
        request.ended('reopen_unconfirmed')  # Already delivered: nothing more is logged.
        self.assertNotIn('reopen_unconfirmed', self.reasons(2))

    def test_unconfirmed_reopen_explains_each_waiting_row_once(self):
        other = 2000001
        self.server.run['plan']['watches'].append(dict(item_id=other, limit=10, groups=[fixtures.group()]))
        self.server.run['plan_version'] = 2
        self.engine.poll()
        self.assertTrue(self.engine.buying(), self.engine.message)
        rows = self.rows(1, 2)+[dict(item_id=other, slot=3, price_mesos_candidate=50, bundle_quantity_candidate=1,
                                     available_quantity_candidate=4)]
        request = self.visit('shop_a.json', rows)
        request.ended('reopen_unconfirmed')
        request.ended('scan_stopped')
        self.assertEqual(self.reasons(2).count('reopen_unconfirmed'), 1)
        self.assertEqual(self.reasons(3)[-1], 'reopen_unconfirmed')
        self.assertNotIn('scan_stopped', self.reasons(2)+self.reasons(3))
        self.assertEqual(len(self.server.named('reserve')), 1)

    def test_changed_shop_on_reopen_buys_nothing(self):
        request = self.visit('shop_a.json', self.rows(1, 2))
        self.assertIsNone(self.visit('shop_b.json', self.rows(2), revisit=request, owner=456))
        self.assertEqual(len(self.server.named('reserve')), 1)
        self.assertEqual(self.reasons(2)[-1], 'shop_changed')

    def test_sold_row_and_scanner_moving_on_are_both_explained(self):
        request = self.visit('shop_a.json', self.rows(1, 2, 3))
        self.visit('shop_a2.json', self.rows(3), revisit=request)
        self.assertIn('not_in_reopened_shop', [d.get('detail') for d in self.decisions() if d.get('slot') == 2])
        later = self.visit('shop_a3.json', self.rows(4, 5))  # Bought slot 4; slot 5 waits.
        self.visit('shop_c.json', self.rows(7), owner=789)  # A different shop, no revisit handed back.
        self.assertIsNotNone(later)
        self.assertEqual(self.reasons(5)[-1], 'visit_ended_after_purchase')

    def test_purchases_per_stall_visit_are_bounded(self):
        from collector_sweep import MAX_VISIT_PURCHASES
        self.server.run['plan']['watches'][0]['limit'] = 100
        self.server.run['plan_version'] = 2
        self.engine.poll()
        slots = list(range(1, MAX_VISIT_PURCHASES+2))
        request = None
        for number in range(MAX_VISIT_PURCHASES):
            request = self.visit(f'shop_{number}.json', self.rows(*slots[number:]), revisit=request)
        self.assertIsNone(request)
        self.assertEqual(len(self.server.named('reserve')), MAX_VISIT_PURCHASES)
        self.assertEqual(self.reasons(slots[-1])[-1], 'purchase_limit_per_visit')

    def test_game_rejection_closing_the_shop_is_not_reopened(self):
        self.purchaser.result = lambda order: PurchaseResult('not_bought', reason='shop_closed')
        self.assertIsNone(self.visit('shop_a.json', self.rows(1, 2)))
        self.assertEqual(self.reasons(2)[-1], 'shop_closed')
        self.assertEqual(self.verified, [])


if __name__=='__main__':
    import unittest
    unittest.main()
