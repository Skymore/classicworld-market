import struct
import unittest
from market_location import inspect_map, inspect_map_context, LocationTimeline


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

    def test_extended_channel_range_and_invalid_channel_rejection(self):
        for channel in (12, 18, 19, 20, 21, 33, 40, 50, 60, 255):
            packet=self.packet();struct.pack_into('<I',packet,10,channel-1)
            location,_=inspect_map(packet)
            self.assertEqual((location['channel'],location['room']),(channel,8))
        for raw in (255, 0xffffffff):
            packet=self.packet();struct.pack_into('<I',packet,10,raw)
            self.assertIsNone(inspect_map(packet)[0])

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

    def test_outside_market_retains_map_without_inventing_room(self):
        p = self.packet()
        struct.pack_into('<I', p, 247, 10004040)
        context, _ = inspect_map_context(p)
        self.assertEqual((context['channel'], context['map_id'], context['room']), (9, 10004040, None))
        self.assertIsNone(inspect_map(p)[0])

    def test_context_timeline_invalidates_on_unknown_layout(self):
        import tempfile, json
        from pathlib import Path
        p = self.packet()
        struct.pack_into('<I', p, 247, 10004040)
        records = []
        for timestamp, packet in [(100, p), (200, b'\xa6\x01')]:
            _, evidence = inspect_map_context(packet)
            records.append(json.dumps(dict(time=timestamp, session='test', evidence=evidence)))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'maps.jsonl'
            path.write_text('\n'.join(records), encoding='utf-8')
            timeline = LocationTimeline(path)
            self.assertEqual(timeline.resolve_context('test', 150)['map_id'], 10004040)
            self.assertIsNone(timeline.resolve_context('test', 201))
            self.assertIsNone(timeline.resolve('test', 150))


if __name__ == '__main__':
    unittest.main()
