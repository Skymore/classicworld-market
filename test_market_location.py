import struct
import unittest
from market_location import inspect_map


class LocationTests(unittest.TestCase):
    def packet(self):
        p = bytearray(7600)
        struct.pack_into('<H', p, 0, 0x1a6)
        struct.pack_into('<I', p, 10, 8)
        p[19] = 1
        struct.pack_into('<I', p, 247, 80002008)
        return p

    def test_channel_and_room(self):
        location, _ = inspect_map(self.packet())
        self.assertEqual((location['channel'], location['room']), (9, 8))

    def test_unknown_layout_cannot_be_assigned_location(self):
        p = self.packet()
        p[19] = 0
        self.assertIsNone(inspect_map(p)[0])
        self.assertIsNone(inspect_map(p[:100])[0])

    def test_map_number_elsewhere_does_not_override_unknown_map(self):
        p = self.packet()
        struct.pack_into('<I', p, 247, 100000000)
        struct.pack_into('<I', p, 280, 80002008)
        self.assertIsNone(inspect_map(p)[0])

    def test_recorded_portal_entry_and_entrance(self):
        p = bytes.fromhex('a601a09066ee1459dd010800000000000000000300000000a60500006603000000000000d7bbc4040a760200000002006400000000010000000000000000000000000001ffffffff0000000000000000ffc99a3bffc99a3b000000000000000000000000000000')
        location, _ = inspect_map(p)
        self.assertEqual((location['channel'], location['room']), (9, 7))
        entrance = bytearray(p)
        struct.pack_into('<I', entrance, 36, 80002000)
        self.assertEqual(inspect_map(entrance)[0]['room'], 0)

    def test_bounded_long_capture(self):
        self.assertEqual(inspect_map(self.packet()[:320], 7600)[0]['room'], 8)


if __name__ == '__main__':
    unittest.main()
