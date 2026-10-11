"""Regression checks against the captured bytes and malformed rows."""
import unittest
from pathlib import Path
from decode_market import messages, subtract
from decode_shops import rows


class ShopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payloads=[]
        for msg in messages(Path('network_captures/monitor_20261010_132022')):
            if msg['flow'][1]!=8548 or len(msg['body'])<2:
                continue
            d=subtract(msg['body'],(msg['body'][1]-5)&255)
            if d[:2]==b'\x78\x05':
                cls.payloads.append(d)

    def test_all_observed_lists_match_announced_count(self):
        self.assertEqual(len(self.payloads),24)
        self.assertEqual(sum(len(rows(d)) for d in self.payloads),271)

    def test_reject_count_mismatch(self):
        d=bytearray(self.payloads[0]);d[6]+=1
        with self.assertRaises(ValueError):rows(d)

    def test_reject_truncated_first_record(self):
        with self.assertRaises(ValueError):rows(self.payloads[0][:30])

    def test_cash_equipment_is_supported(self):
        found=[r for d in self.payloads for r in rows(d) if r['category']==6 and r['item_kind']==1]
        self.assertTrue(found)
        self.assertTrue(all(r['item_id']//1000000==1 for r in found))


if __name__=='__main__':unittest.main()
