import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from market_presence import RoomRoster, roster_payload
from test_player_presence import enter


def map_entry():
    body = bytearray(512)
    body[:2] = bytes.fromhex('a901')
    body[10:14] = (25).to_bytes(4, 'little')
    body[14:24] = bytes.fromhex('00000000000100000000')
    body[158:162] = body[162:166] = (999).to_bytes(4, 'little')
    body[170:176] = b'MySelf'
    body[229] = 1  # One SP book; the following map is at offset 247.
    body[247:251] = (80002001).to_bytes(4, 'little')
    return bytes(body)


def suffix():
    return [struct.pack('<H', op) + bytes(size-2) for op, size in RoomRoster.suffix]


class RoomRosterTest(unittest.TestCase):
    def begin(self):
        from market_location import inspect_map
        p = RoomRoster()
        body = map_entry()
        p.begin(body, inspect_map(body)[0], 10)
        p.observe(bytes.fromhex('fa0100'), 10.01)
        return p

    def test_only_full_envelope_completes_and_includes_observer(self):
        p = self.begin()
        self.assertIsNone(p.observe(enter(), 10.02))
        for body in suffix()[:-1]:
            self.assertIsNone(p.observe(body, 10.03))
        result = p.observe(suffix()[-1], 10.04)
        self.assertEqual(result['character_ids'], [123, 999])
        self.assertEqual(result['started_at'], 10)
        self.assertIsNone(p.observe(suffix()[-1], 10.05))
        # A legitimately empty room still includes the observer.
        p = self.begin()
        for body in suffix(): result = p.observe(body, 10.1)
        self.assertEqual(result['character_ids'], [999])

    def test_missing_corrupt_reordered_or_timed_out_envelope_cannot_expire(self):
        for frames, stamp in [(suffix()[1:],10.1), ([enter()[:22]]+suffix(),10.1),
                              ([b'\x01\0']+suffix(),10.1), (suffix(),21),
                              ([enter(op=0x22a)]+suffix(),10.1)]:
            p = self.begin()
            self.assertFalse(any(p.observe(body, stamp) for body in frames))
        p = self.begin()
        p.begin(b'\xa9\x01'+bytes(101), None, 11)
        self.assertFalse(any(p.observe(body, 11.1) for body in suffix()))

    def test_unknown_self_and_midstream_capture_cannot_expire(self):
        from market_location import inspect_map
        body = bytearray(map_entry());body[162] ^= 1
        p = RoomRoster();p.begin(body, inspect_map(body)[0], 10)
        self.assertFalse(any(p.observe(b, 10.1) for b in [b'\xfa\x01\0',enter(),*suffix()]))
        p = RoomRoster()
        self.assertFalse(any(p.observe(b, 10.1) for b in [b'\xfa\x01\0',enter(),*suffix()]))

    def test_live_decoder_session_exports_allowlisted_roster_and_uploads_once(self):
        from market_passive import Collector
        from market_proxy import Session
        from shared_client import upload_once
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);collector=Collector(root)
            session=Session(collector,None,None,None,None,'fixture',8500)
            observe=collector.observer(session)
            for body in [map_entry(),b'\xfa\x01\0',enter(),*suffix()]:observe(body)
            files=list(root.glob('roster_*.json'));self.assertEqual(len(files),1)
            data=json.loads(files[0].read_text());data['raw_body']='PRIVATE'
            self.assertNotIn('raw_body',roster_payload(data))
            self.assertEqual(data['character_ids'],[123,999])
            opener=MagicMock();opener.open.return_value.__enter__.return_value.read.return_value=b'{"ok":true}'
            with patch('shared_client.request_json',return_value={'ok':True}) as send:
                self.assertEqual(upload_once(root,dict(endpoint='http://127.0.0.1:9999',token='fixture'),root/'sent.sqlite'),0)
                self.assertTrue(send.call_args.args[0].endswith('/collector/room-roster'))
                upload_once(root,dict(endpoint='http://127.0.0.1:9999',token='fixture'),root/'sent.sqlite')
                self.assertEqual(send.call_count,1)

    def test_partial_roster_reset_on_unknown_frame(self):
        p=self.begin();p.observe(enter(),10.02)
        p.reset()  # decode fault / map change
        self.assertFalse(any(p.observe(b,10.1) for b in suffix()))

    def test_portal_entry_retains_observer_and_extended_players(self):
        from market_location import inspect_map
        p=self.begin()
        body=bytearray(103);body[:2]=b'\xa9\x01';body[10:14]=(25).to_bytes(4,'little')
        body[36:40]=(80002002).to_bytes(4,'little')
        p.begin(body,inspect_map(body)[0],11)
        p.observe(b'\xfa\x01\0',11.01)
        p.observe(struct.pack('<HQIIIH',0x22d,900001,123,0,48,4)+b'Loon'+bytes(100),11.02)
        for b in suffix(): result=p.observe(b,11.03)
        self.assertEqual(result['location'],dict(channel=26,room=2))
        self.assertEqual(result['character_ids'],[123,999])


if __name__=='__main__':unittest.main()
