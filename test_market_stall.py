import struct
import unittest

from market_stall import StallTracker, parse_entry, parse_sign


LOOK = (struct.pack('<BBIIBI', 1, 2, 21001, 200, 0, 31235)
        + bytes([1]) + struct.pack('<I', 1007136) + bytes([11]) + struct.pack('<I', 1372002) + bytes([0xFF])
        + bytes([1]) + struct.pack('<I', 1002019) + bytes([0xFF]) + struct.pack('<I', 1702028))


def entry(character_id, name, x, y, title=None, permit=5140002, pets=False, op=0x22D, look=False):
    body = struct.pack('<HI', op, 0x0101C8AC) + struct.pack('<I', character_id) + bytes(8)
    body += struct.pack('<H', len(name)) + name.encode() + bytes(40)
    if look:
        body += LOOK + bytes(20)
    body += b'\xff\xff' + bytes(8) + struct.pack('<hhBH', x, y, 4, 10) + b'\x01\x01\x00'
    if pets:
        # A pet record carries its own position after the owner's.
        body += b'\x01\x00\x00\x00\x00' + struct.pack('<I', 5000004) + b'\x0b\x00Black Kitty'
        body += bytes(8) + struct.pack('<hhBH', x + 5, y, 0x18, 10) + b'\xff\xff\xff\xff'
    body += bytes(16)
    if title is not None:
        raw = title.encode()
        body += struct.pack('<IIIH', 3, 0x14B2, 2, len(raw)) + raw + struct.pack('<I', permit)
    else:
        body += bytes(4)
    return body + bytes(20)


def sign(character_id, title=None, permit=5140005, op=0x23D):
    if title is None:
        return struct.pack('<HI', op, character_id) + bytes(18)
    raw = title.encode()
    return struct.pack('<HIIIIH', op, character_id, 3, 0x14B2, 2, len(raw)) + raw + struct.pack('<I', permit)


class StallTest(unittest.TestCase):
    def test_entry_gives_position_and_permit(self):
        self.assertEqual(parse_entry(entry(47870, 'Hexa', 444, -416, 'Great Deals!')),
                         dict(character_id=47870, x=444, y=-416, permit=5140002, title='Great Deals!', look=None))

    def test_entry_gives_the_look(self):
        stall = parse_entry(entry(47870, 'Hexa', 52, -206, '1-7 door', look=True))
        self.assertEqual(stall['look'], dict(gender=1, skin=2, face=21001, hair=31235,
                                              equips={'1': 1007136, '11': 1372002}, cash_weapon=1702028))
        tracker = StallTracker()
        tracker.observe(entry(47870, 'Hexa', 52, -206, '1-7 door', look=True))
        self.assertEqual(tracker.stall(47870, '1-7 door')['look']['hair'], 31235)

    def test_pets_do_not_move_the_stall(self):
        stall = parse_entry(entry(9, 'Owner', 794, -416, 'Need Pots', pets=True))
        self.assertEqual((stall['x'], stall['y']), (794, -416))

    def test_legacy_opcodes(self):
        self.assertEqual(parse_entry(entry(5, 'Ab', 1, 34, 'x', op=0x22A))['y'], 34)
        self.assertEqual(parse_sign(sign(5, 'x', op=0x23A)), (5, 'x', 5140005))

    def test_player_without_store(self):
        self.assertIsNone(parse_entry(entry(5, 'Ab', 1, 34)))

    def test_tracker_needs_position_and_matching_title(self):
        tracker = StallTracker()
        tracker.observe(entry(7, 'Seller', 120, -206, 'NX'))
        self.assertEqual(tracker.stall(7, 'NX'), dict(x=120, y=-206, permit=5140002, parser='cw_stall_v1'))
        self.assertIsNone(tracker.stall(7, 'Other title'))
        # A sign repeats the balloon: the newest permit wins.
        tracker.observe(sign(7, 'NX', 5140003))
        self.assertEqual(tracker.stall(7, 'NX')['permit'], 5140003)

    def test_closed_store_forgets_position(self):
        tracker = StallTracker()
        tracker.observe(entry(7, 'Seller', 120, -206, 'NX'))
        tracker.observe(sign(7))
        tracker.observe(sign(7, 'NX'))
        self.assertIsNone(tracker.stall(7, 'NX'))

    def test_store_opened_after_entry_has_no_position(self):
        tracker = StallTracker()
        tracker.observe(entry(7, 'Seller', 120, -206))
        tracker.observe(sign(7, 'NX'))
        self.assertIsNone(tracker.stall(7, 'NX'))

    def test_map_change_clears(self):
        tracker = StallTracker()
        tracker.observe(entry(7, 'Seller', 120, -206, 'NX'))
        tracker.clear()
        self.assertIsNone(tracker.stall(7, 'NX'))

    def test_permit_out_of_range_is_not_a_store(self):
        self.assertIsNone(parse_entry(entry(7, 'Seller', 1, 2, 'NX', permit=5000004)))


if __name__ == '__main__':
    unittest.main()
