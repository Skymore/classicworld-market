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
        for packet in (None, dict(categories=[], mesos=500), dict(categories=[2,3,4],mesos=499)):
            with self.subTest(packet=packet), tempfile.TemporaryDirectory() as folder:
                window = Window()
                checker = InventoryChecker(folder, Screen(), lambda: window.elapsed)
                with patch('inventory_check.read_inventory', return_value=packet), self.assertRaises(InventoryCheckError):
                    checker.run(window)
                self.assertFalse(window.opened)
                self.assertEqual(window.keys, ['i', 'i'])

    def test_unrecognized_window_gets_no_blind_second_toggle(self):
        with tempfile.TemporaryDirectory() as folder:
            window = Window(responsive=False)
            with self.assertRaises(InventoryCheckError):
                InventoryChecker(folder, Screen(), lambda: window.elapsed).run(window)
            self.assertEqual(window.keys, ['i'])
