import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from inventory_check import InventoryChecker, InventoryCheckError


class Window:
    def __init__(self, opened=False, responsive=True):
        self.opened, self.responsive = opened, responsive
        self.keys, self.elapsed = [], 0

    def capture(self):
        return self.opened, (0, 0, 1366, 768)

    def press(self, key):
        self.keys.append(key)
        if self.responsive:
            self.opened = not self.opened

    def pause(self, duration):
        self.elapsed += duration


class Screen:
    def locate(self, opened):
        return (100, 100, 500) if opened else None


class InventoryCheckTests(unittest.TestCase):
    def test_startup_focus_loss_preserves_recoverable_input_exception(self):
        for failure in (RuntimeError('Game lost foreground; stopped'), InterruptedError('Request cancelled')):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                window = Window()
                def interrupted_pause(duration): raise failure
                window.pause = interrupted_pause
                with self.assertRaises(type(failure)) as caught:
                    InventoryChecker(folder, Screen(), lambda: window.elapsed).run(window)
                self.assertIs(caught.exception, failure)
                self.assertEqual(window.keys, ['i'])

    def test_post_purchase_interruption_still_requires_attention(self):
        with tempfile.TemporaryDirectory() as folder:
            window = Window()
            def interrupted_pause(duration): raise RuntimeError('Game lost foreground; stopped')
            window.pause = interrupted_pause
            with self.assertRaises(InventoryCheckError):
                InventoryChecker(folder, Screen(), lambda: window.elapsed).run(window, 'purchase')

    def test_open_verify_close_and_preserve_purchase_expectation(self):
        packet = dict(categories=[2, 3, 4], mesos=500, items=[dict(item_id=2000001, quantity=40)])
        for initially_open in (False, True):
            with self.subTest(initially_open=initially_open), tempfile.TemporaryDirectory() as folder:
                window = Window(initially_open)
                checker = InventoryChecker(folder, Screen(), lambda: window.elapsed)
                with patch('inventory_check.read_inventory', return_value=packet):
                    self.assertEqual(checker.run(window, 'purchase', dict(item_id=2000001, quantity=40, mesos=500)), packet)
                self.assertFalse(window.opened)
                self.assertEqual(window.keys, ['i'] if initially_open else ['i', 'i'])
                self.assertIn('confirmed', (Path(folder)/'sweep/inventory-checks.jsonl').read_text())

    def test_mismatch_closes_inventory_but_does_not_continue(self):
        for packet in (dict(categories=[], mesos=500), dict(categories=[2,3,4],mesos=499)):
            with self.subTest(packet=packet), tempfile.TemporaryDirectory() as folder:
                window = Window()
                checker = InventoryChecker(folder, Screen(), lambda: window.elapsed)
                with patch('inventory_check.read_inventory', return_value=packet), self.assertRaises(InventoryCheckError):
                    checker.run(window)
                self.assertFalse(window.opened)
                self.assertEqual(window.keys, ['i', 'i'])

    def test_missing_startup_snapshot_reconnects_only_after_inventory_closed(self):
        from free_market_route import PositionSyncError
        for reason, error in [('scan_start', PositionSyncError), ('purchase', InventoryCheckError)]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as folder:
                window = Window()
                with patch('inventory_check.read_inventory', return_value=None), self.assertRaises(error):
                    InventoryChecker(folder, Screen(), lambda: window.elapsed).run(window, reason)
                self.assertFalse(window.opened)
                self.assertEqual(window.keys, ['i', 'i'])

    def test_complete_current_packet_does_not_depend_on_scaled_currency_glyphs(self):
        class ScaledScreen:
            def locate(self,opened):return (100,100,None) if opened else None
        packet=dict(session='current',revision=3,categories=[2,3,4],mesos=737594,
                    items=[dict(item_id=4010101,quantity=3)])
        for reason in ('scan_start','purchase'):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as folder:
                window=Window()
                checker=InventoryChecker(folder,ScaledScreen(),lambda:window.elapsed)
                expected=dict(item_id=4010101,quantity=3,mesos=737594) if reason=='purchase' else None
                with patch('inventory_check.read_inventory',return_value=packet):
                    self.assertEqual(checker.run(window,reason,expected),packet)
                self.assertLess(window.elapsed,1)
                self.assertEqual(window.keys,['i','i'])

    def test_packet_path_still_requires_complete_current_data_and_purchase_totals(self):
        class ScaledScreen:
            def locate(self,opened):return (100,100,None) if opened else None
        for bad in (dict(session=None),dict(revision=0),dict(categories=[2]),dict(mesos=None),
                    dict(mesos=737593),dict(items=[dict(item_id=4010101,quantity=2)])):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as folder:
                packet=dict(session='current',revision=3,categories=[2,3,4],mesos=737594,
                            items=[dict(item_id=4010101,quantity=3)])
                packet.update(bad)
                window=Window()
                checker=InventoryChecker(folder,ScaledScreen(),lambda:window.elapsed)
                with patch('inventory_check.read_inventory',return_value=packet), self.assertRaises(InventoryCheckError):
                    checker.run(window,'purchase',dict(item_id=4010101,quantity=3,mesos=737594))
                self.assertFalse(window.opened)

    def test_pointer_over_mesos_label_still_locates_inventory(self):
        import numpy as np
        from inventory_check import InventoryScreen
        screen=InventoryScreen()
        frame=np.random.default_rng(3).integers(0,256,(768,1366,3),dtype=np.uint8)
        x,y=1100,170
        title=screen.title;frame[y+4:y+4+title.shape[0],x+5:x+5+title.shape[1]]=title
        mesos=screen.mesos;mx,my=x+170,y+269
        frame[my:my+mesos.shape[0],mx:mx+mesos.shape[1]]=mesos
        self.assertEqual(screen.locate(frame)[:2],(x,y))
        half=mesos.shape[1]//2
        for covered in (slice(mx,mx+half),slice(mx+half,mx+mesos.shape[1])):
            pointer=frame.copy();pointer[my-4:my+mesos.shape[0]+6,covered]=255
            self.assertEqual(screen.locate(pointer)[:2],(x,y))
        # Title alone, or a fully covered label, is not an open inventory.
        hidden=frame.copy();hidden[my:my+mesos.shape[0],mx:mx+mesos.shape[1]]=255
        self.assertIsNone(screen.locate(hidden))

    def test_unrecognized_window_gets_no_blind_second_toggle(self):
        with tempfile.TemporaryDirectory() as folder:
            window = Window(responsive=False)
            with self.assertRaises(InventoryCheckError):
                InventoryChecker(folder, Screen(), lambda: window.elapsed).run(window)
            self.assertEqual(window.keys, ['i'])
