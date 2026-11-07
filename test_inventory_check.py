import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from inventory_check import InventoryChecker, InventoryCheckError


class Window:
    """Only the scanner's guarded pause; the check must never send input."""
    def __init__(self):
        self.elapsed = 0

    def pause(self, duration):
        self.elapsed += duration


def current(**changes):
    packet = dict(session='current', revision=3, categories=[2, 3, 4], mesos=737594,
                  items=[dict(item_id=4010101, quantity=3)])
    packet.update(changes)
    return packet


class InventoryCheckTests(unittest.TestCase):
    def check(self, packets, reason='scan_start', expected=None):
        window = Window()
        folder = tempfile.mkdtemp()
        values = iter(packets)
        last = [None]
        def read(_):
            last[0] = next(values, last[0])
            return last[0]
        with patch('inventory_check.read_inventory', side_effect=read):
            result = InventoryChecker(folder, clock=lambda: window.elapsed).run(window, reason, expected)
        return result, window, folder

    def test_complete_packet_confirms_without_opening_the_inventory(self):
        packet = current()
        result, window, folder = self.check([packet])
        self.assertEqual(result, packet)
        self.assertEqual(window.elapsed, 0)
        self.assertFalse(hasattr(window, 'keys'))
        self.assertIn('confirmed', (Path(folder)/'sweep/inventory-checks.jsonl').read_text())

    def test_purchase_waits_for_the_updated_packet(self):
        expected = dict(item_id=4010101, quantity=3, mesos=737594)
        stale = current(mesos=800000, items=[dict(item_id=4010101, quantity=2)])
        result, window, _ = self.check([stale, stale, current()], 'purchase', expected)
        self.assertEqual(result['mesos'], 737594)
        self.assertGreater(window.elapsed, 0)
        self.assertLess(window.elapsed, 1)

    def test_incomplete_stale_or_mismatched_data_never_confirms(self):
        expected = dict(item_id=4010101, quantity=3, mesos=737594)
        for bad in (dict(session=None), dict(revision=0), dict(categories=[2]), dict(mesos=None),
                    dict(mesos=737593), dict(items=[dict(item_id=4010101, quantity=2)])):
            with self.subTest(bad=bad), self.assertRaises(InventoryCheckError):
                self.check([current(**bad)], 'purchase', expected)

    def test_missing_startup_snapshot_reconnects_but_purchase_requires_attention(self):
        from free_market_route import PositionSyncError
        for reason, error in [('scan_start', PositionSyncError), ('purchase', InventoryCheckError)]:
            with self.subTest(reason=reason), self.assertRaises(error):
                self.check([None], reason, dict(item_id=1, quantity=1, mesos=1) if reason == 'purchase' else None)

    def test_startup_focus_loss_preserves_recoverable_input_exception(self):
        for failure in (RuntimeError('Game lost foreground; stopped'), InterruptedError('Request cancelled')):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                window = Window()
                def interrupted_pause(duration): raise failure
                window.pause = interrupted_pause
                with patch('inventory_check.read_inventory', return_value=None), \
                        self.assertRaises(type(failure)) as caught:
                    InventoryChecker(folder, clock=lambda: 0).run(window)
                self.assertIs(caught.exception, failure)

    def test_post_purchase_interruption_still_requires_attention(self):
        with tempfile.TemporaryDirectory() as folder:
            window = Window()
            def interrupted_pause(duration): raise RuntimeError('Game lost foreground; stopped')
            window.pause = interrupted_pause
            with patch('inventory_check.read_inventory', return_value=None), self.assertRaises(InventoryCheckError):
                InventoryChecker(folder, clock=lambda: 0).run(window, 'purchase', dict(item_id=1, quantity=1, mesos=1))


if __name__ == '__main__':
    unittest.main()
