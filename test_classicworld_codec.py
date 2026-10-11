"""Captured known-answer vectors, not merely encrypt/decrypt symmetry."""
import json
import unittest
from pathlib import Path
from classicworld_codec import aes_payload, encode_shop_request, audit, SHOP_MAP_INDEX

FOLDER = Path(__file__).parent / 'network_captures/shop_session_20261010_170336'


class ClassicWorldCodecTests(unittest.TestCase):
    def test_three_independent_open_vectors(self):
        table = [0] * (SHOP_MAP_INDEX + 1)
        table[SHOP_MAP_INDEX] = 0xd42a
        vectors = [
            ('e1d947e0', '98e092e0d6e349f43319f7546f1a'),
            ('39a54116', '9e1694161e74ca33c897c6918091'),
            ('ea557581', 'aa81a08146e0b15e13788b19bf2f'),
        ]
        for iv, frame in vectors:
            with self.subTest(iv=iv):
                encoded, _ = encode_shop_request(table, bytes.fromhex(iv), 2, 5830)
                self.assertEqual(encoded.hex(), frame)
                self.assertEqual(aes_payload(bytes.fromhex(frame)[4:], bytes.fromhex(iv)).hex(),
                                 '2ad402000000c6160000')

    def test_close_vector(self):
        table = [0] * (SHOP_MAP_INDEX + 1)
        table[SHOP_MAP_INDEX] = 0xd42a
        frame, _ = encode_shop_request(table, bytes.fromhex('56cb39b2'), 3)
        self.assertEqual(frame.hex(), 'e6b2e0b27a4f6cf4ca7e')
        with self.assertRaises(ValueError):
            encode_shop_request(table, bytes.fromhex('56cb39b2'), 2)

    def test_two_complete_connections(self):
        report = audit(FOLDER)
        self.assertEqual([c['opcode_map_entries'] for c in report['connections']], [875, 875])
        self.assertEqual([c['shop_mapped_opcode'] for c in report['connections']], [0x1588, 0xd42a])
        self.assertEqual(sum(c['client_frames'] + c['server_frames'] for c in report['connections']), 480)
        self.assertEqual([a['action'] for a in report['shop_actions']], [2, 3, 2, 3, 2, 3])
        self.assertEqual([a['shop_id'] for a in report['shop_actions'] if a['action'] == 2], [5830]*3)


if __name__ == '__main__':
    unittest.main()
