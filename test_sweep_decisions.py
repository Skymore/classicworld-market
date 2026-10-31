"""Ticket #6: captured stock, rules, disabled buying and reason persistence."""
import json
import unittest
import test_collector_sweep as fixtures
from sweep_purchase import PurchasePreparationSkipped
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


if __name__=='__main__':
    import unittest
    unittest.main()
