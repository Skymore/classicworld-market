import json
from pathlib import Path
import tempfile
import unittest

from market_scan_receipt import CaptureReceipt


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def write(self, name, **values):
        row = dict(session='test', time=101, shop_id=42, items=[], triggered_by_python=False)
        row.update(values)
        (self.folder/name).write_text(json.dumps(row), encoding='utf-8')

    def test_stale_experimental_and_partial_are_not_success(self):
        self.write('shop_existing.json')
        receipt = CaptureReceipt(self.folder, now=100)
        self.write('shop_stale.json', time=99)
        self.write('shop_test.json', triggered_by_python=True)
        (self.folder/'shop_partial.json').write_text('{', encoding='utf-8')
        self.assertIsNone(receipt.poll(now=102))
        self.write('shop_partial.json')
        self.assertEqual(receipt.poll(now=102)['shop_id'], 42)

    def test_ambiguous_receipts_fail(self):
        receipt = CaptureReceipt(self.folder, now=100)
        self.write('shop_a.json')
        self.write('shop_b.json', shop_id=43)
        with self.assertRaisesRegex(RuntimeError, 'Multiple'):
            receipt.poll(now=102)

    def test_empty_shop_is_valid_and_duplicate_exports_count_once(self):
        receipt = CaptureReceipt(self.folder, now=100)
        self.write('shop_a.json')
        self.write('shop_a_zh.json')
        self.assertEqual(receipt.poll(now=102)['item_count'], 0)

    def test_invalid_metadata_is_rejected(self):
        receipt = CaptureReceipt(self.folder, now=100)
        for index, values in enumerate([{'time': float('nan')}, {'time': 500},
                                       {'session': None}, {'items': None},
                                       {'shop_id': True}, {'triggered_by_python': None}]):
            self.write(f'shop_{index}.json', **values)
        self.assertIsNone(receipt.poll(now=102))


if __name__ == '__main__':
    unittest.main()
