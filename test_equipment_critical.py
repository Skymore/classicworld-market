import struct
import unittest

from market_equipment import decode_equipment
from shared_protocol import validate


class CriticalEquipmentTests(unittest.TestCase):
    def test_tooltip_checked_fields_decode_and_upload(self):
        # Same-offer tooltips checked 2026-10-29: 39,999 Work Gloves (DEF 5,
        # Critical Rate 2, 4 slots); 255,555 Emerald Earrings (INT 6,
        # MDEF 27, Critical Damage 2, 0 slots). Encode their observed values.
        for iid, fields, slots, expected in [
            (1082000, {10: 5, 14: 2}, 4, {'weapon_defense': 5, 'critical_rate': 2}),
            (1032007, {2: 6, 11: 27, 15: 2}, 0,
             {'int': 6, 'magic_defense': 27, 'critical_damage': 2}),
        ]:
            with self.subTest(item_id=iid):
                raw = bytearray(40)
                raw[20:22] = b'\x01\x01'
                raw[22:26] = struct.pack('<I', iid)
                raw[35:40] = bytes.fromhex('ffffffff01')
                raw += struct.pack('<I', sum(1 << bit for bit in fields))
                raw += struct.pack('<' + 'H' * len(fields), *fields.values())
                raw += struct.pack('<IB', 0x40001, slots) + b'\xff' + bytes(8)
                eq = decode_equipment(raw.hex(), iid)
                self.assertEqual({s['key']: s['value'] for s in eq['stats']}, expected)
                self.assertEqual(eq['unknown_fields'], [])
                self.assertEqual(eq['remaining_upgrades'], slots)
                payload = dict(version=1, world='ClassicWorld', complete=True,
                               observation_id='critical-fields', observed_at=1000,
                               shop_id=1, title='Tooltip checked', items=[dict(
                                   item_id=iid, slot=1, price=39999, bundle=1, stock=1,
                                   equipment=eq)])
                cleaned = validate(payload, now=1000)['items'][0]['equipment']
                self.assertEqual({s['key']: s['value'] for s in cleaned['stats']}, expected)

    def test_legacy_upload_keeps_unknown_fields_for_idempotent_retries(self):
        payload = dict(version=1, world='ClassicWorld', complete=True,
                       observation_id='old-reader', observed_at=1000, shop_id=1,
                       title='Old reader', items=[dict(item_id=1082000, slot=1,
                       price=39999, bundle=1, stock=1, equipment=dict(status='candidate',
                       stats=[], unknown_fields=[dict(bit=14, value=2)]))])
        eq = validate(payload, now=1000)['items'][0]['equipment']
        self.assertEqual(eq['stats'], [])
        self.assertEqual(eq['unknown_fields'], [dict(bit=14, value=2)])
