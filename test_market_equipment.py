import unittest
from market_equipment import decode_equipment

# Captured listing 1041040: the values vary per instance; this is not the
# user's own-shop screenshot instance.
ROW = '010008000100000001000000a00f000000000000010190e20f0000008005bb46e61702ffffffff01120400000200050024000100040007ff00000000000000427cd9cafa0000000000000000000000000000000000f9c88c25c158f20b00000000000000000040e0fd3b374f0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'


class EquipmentTests(unittest.TestCase):
    def test_captured_top(self):
        result = decode_equipment(ROW, 1041040)
        self.assertEqual({s['key']: s['value'] for s in result['stats']},
                         dict(dex=2, hp=5, weapon_defense=36))
        self.assertEqual(result['remaining_upgrades'], 7)
        self.assertEqual(result['status'], 'candidate')

    def test_wrong_id_and_truncation_rejected(self):
        self.assertEqual(decode_equipment(ROW, 1040033)['status'], 'unsupported')
        self.assertEqual(decode_equipment(ROW[:100], 1041040)['status'], 'unsupported')

    def test_different_defense_is_preserved(self):
        raw = bytearray.fromhex(ROW)
        raw[48] = 39
        result = decode_equipment(raw.hex(), 1041040)
        self.assertEqual(result['stats'][-1]['value'], 39)

    def test_unknown_mask_fails_closed(self):
        raw = bytearray.fromhex(ROW)
        raw[43] = 128
        self.assertEqual(decode_equipment(raw.hex(), 1041040)['status'], 'unsupported')


if __name__ == '__main__':
    unittest.main()
