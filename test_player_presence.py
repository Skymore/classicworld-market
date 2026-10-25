import struct
import unittest
from market_presence import PlayerPresence, departure_payload


def enter(character=123, name=b'ExampleHost', op=0x22d):
    return struct.pack('<HIIIIH', op, 900001, character, 0, 20, len(name)) + name + bytes(100)


class PresenceTest(unittest.TestCase):
    def test_upload_is_allowlisted_and_not_counted_as_a_shop_visit(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch, MagicMock
        from shared_client import upload_once
        event = dict(version=1, world='ClassicWorld', parser='cw_player_departure_v1',
                     event_id='a'*32, name='ExampleHost', character_id=123,
                     seen_at=10, observed_at=11, location=dict(channel=26, room=1), raw_body='PRIVATE')
        self.assertNotIn('raw_body', departure_payload(event))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'presence_example.json').write_text(json.dumps(event))
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value.read.return_value = b'{"ok":true}'
            with patch('shared_client.upload_opener', return_value=opener):
                self.assertEqual(upload_once(root, dict(endpoint='http://127.0.0.1:9999', token='fixture'), root/'sent.sqlite'), 0)
                sent = opener.open.call_args.args[0]
                self.assertTrue(sent.full_url.endswith('/collector/player-departure'))
                self.assertNotIn(b'PRIVATE', sent.data)
                upload_once(root, dict(endpoint='http://127.0.0.1:9999', token='fixture'), root/'sent.sqlite')
                self.assertEqual(opener.open.call_count, 1)

    def test_character_id_not_entity_handle_and_duplicate_leave(self):
        p = PlayerPresence()
        self.assertIsNone(p.observe(enter(), 10))
        self.assertIsNone(p.observe(struct.pack('<HI', 0x22e, 900001), 11))
        result = p.observe(struct.pack('<HI', 0x22e, 123), 12)
        self.assertEqual((result['character_id'], result['name'], result['seen_at']), (123, 'ExampleHost', 10))
        self.assertIsNone(p.observe(struct.pack('<HI', 0x22e, 123), 13))

    def test_unknown_truncated_and_other_packets_do_not_expire(self):
        p = PlayerPresence()
        self.assertIsNone(p.observe(struct.pack('<HI', 0x22e, 123), 10))
        self.assertIsNone(p.observe(enter()[:22], 10))
        self.assertIsNone(p.observe(enter(name=b'bad name'), 10))
        p.observe(enter(), 10)
        self.assertIsNone(p.observe(struct.pack('<HI', 0x23d, 123), 12))
        self.assertIsNone(p.observe(struct.pack('<HI', 0x22e, 123) + b'\0', 12))
        p.players.clear()  # map transition: never treat the old roster as departures
        self.assertIsNone(p.observe(struct.pack('<HI', 0x22e, 123), 13))

    def test_reentry_requires_new_explicit_leave(self):
        p = PlayerPresence()
        p.observe(enter(), 1)
        p.observe(struct.pack('<HI', 0x22e, 123), 2)
        p.observe(enter(), 3)
        self.assertEqual(p.observe(struct.pack('<HI', 0x22e, 123), 4)['seen_at'], 3)


if __name__ == '__main__':
    unittest.main()
