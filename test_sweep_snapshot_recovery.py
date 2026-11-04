import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from sweep_purchaser_windows import WindowsPurchaser, ordered_snapshot
from sweep_purchase import PurchaseResult, PurchaseOrder


class SnapshotRecoveryTests(unittest.TestCase):
    def test_split_inventory_slots_preserve_display_order_and_stock(self):
        def row(slot, stock):
            return dict(item_id=2000003, category=2, slot=slot,
                        price_mesos_candidate=190, bundle_quantity_candidate=1,
                        available_quantity_candidate=stock)
        raw = dict(session='test', time=time.time(), shop_id=42, title='Potions',
                   market_location=dict(room=10, channel=16),
                   owner=dict(character_id=1, name='Seller', parser='cw_shop_owner_v1'),
                   items=[row(29, 1), row(29, 99), row(17, 100)])
        order = SimpleNamespace(shop_id=42, owner='Seller', room=10, channel=16,
                                category=2, slot=17, item_id=2000003, price=190,
                                bundle=1, equipment=None)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'shop.json'
            path.write_text(json.dumps(raw), encoding='utf8')
            title, rows, target = ordered_snapshot(path, order)
            self.assertEqual([r['stock'] for r in rows], [1,99,100])
            self.assertEqual(target, 2)
            order.slot=29
            self.assertEqual(ordered_snapshot(path, order)[2], 0)
            order.price=191
            with self.assertRaises(ValueError): ordered_snapshot(path, order)

    def test_invalid_snapshot_before_input_returns_skip_and_diagnostic(self):
        order=PurchaseOrder('r',2000003,'Blue Potion',2,17,190,1,1,None,42,'Seller',10,16,20,lambda:True)
        factory=Mock()
        trace=Mock()
        with patch('sweep_purchaser_windows.ordered_snapshot', side_effect=ValueError('stale')):
            result=WindowsPurchaser(input_factory=factory)._buy(order, SimpleNamespace(capture_file='bad'), trace)
        self.assertEqual(result, PurchaseResult('not_bought', reason='listing_unverified'))
        factory.assert_not_called()
        trace.check.assert_called_once_with(stage='snapshot', error_type='ValueError', detail='stale')

if __name__=='__main__': unittest.main()
