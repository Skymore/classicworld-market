import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from collector_capture_index import CaptureIndex, upload_candidate
from market_location import FollowingTimeline, LocationTimeline
from shared_client import upload_once


def map_line(session, stamp, channel, room):
    packet = bytearray(103)
    packet[:2] = (0x1a9).to_bytes(2, 'little')
    packet[10:14] = (channel - 1).to_bytes(4, 'little')
    packet[36:40] = (80002000 + room).to_bytes(4, 'little')
    return json.dumps(dict(session=session, time=stamp, evidence=dict(length=103, prefix_hex=packet.hex()))) + '\n'


def accept_all(url, payload, headers, stop=None, session=None, timeout=None):
    if url.endswith('/batch'):
        return {'ok': True, 'results': [{'status': 201} for _ in payload['observations']]}
    return {'ok': True}


class CaptureIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.clock = [0.0]

    def write(self, name):
        (self.root/name).write_text('{}')

    def test_candidates_match_the_uploaded_kinds_only(self):
        for name in ('shop_a.json', 'presence_a.json', 'roster_a.json', 'grind_a.json'):
            self.assertTrue(upload_candidate(name), name)
        for name in ('grind_state.json', 'shop_a_zh.json', 'raw_shop_a.jsonl', 'map_observations.jsonl', 'shop_a.tmp'):
            self.assertFalse(upload_candidate(name), name)

    def test_events_add_files_between_scans_and_rescans_catch_missed_events(self):
        self.write('shop_a.json'); self.write('raw_shop_a.jsonl')
        index = CaptureIndex(self.root, rescan=600, clock=lambda: self.clock[0])
        self.assertEqual([p.name for p in index.paths()], ['shop_a.json'])
        index.forget(['shop_a.json'])
        self.write('shop_b.json'); index.note('shop_b.json')
        self.write('shop_c.json')  # an event the watcher missed
        index.note('raw_shop_b.jsonl')
        self.assertEqual([p.name for p in index.paths()], ['shop_b.json'])
        self.clock[0] = 600
        # The rescan finds the missed file; forgotten files are seen again
        # and the ledger keeps them from being resent.
        self.assertEqual([p.name for p in index.paths()], ['shop_a.json', 'shop_b.json', 'shop_c.json'])

    def test_deleted_files_leave_the_index_on_rescan(self):
        index = CaptureIndex(self.root, rescan=600, clock=lambda: self.clock[0])
        index.paths()
        self.write('shop_a.json'); index.note('shop_a.json')
        (self.root/'shop_a.json').unlink()
        self.clock[0] = 600
        self.assertEqual(index.paths(), [])


class IndexedUploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ledger = self.root/'upload.sqlite'
        self.config = dict(endpoint='http://127.0.0.1:9999', token='synthetic')
        self.clock = [0.0]
        self.index = CaptureIndex(self.root, rescan=600, clock=lambda: self.clock[0])
        self.timeline = FollowingTimeline(self.root/'map_observations.jsonl')
        self.events = []

    def capture(self, name, shop=12):
        (self.root/name).write_text(json.dumps(dict(session='test', time=time.time(), shop_id=shop, title='TEST', items=[])))

    def run_upload(self):
        return upload_once(self.root, self.config, self.ledger, on_event=self.events.append,
                           index=self.index, timeline=self.timeline)

    def test_uploaded_files_leave_the_index_and_only_new_files_are_read(self):
        for n in range(3):self.capture(f'shop_{n}.json')
        with patch('shared_client.request_json', side_effect=accept_all) as send:
            self.assertEqual(self.run_upload(), 3)
            self.assertEqual(self.index.names, set())
            self.capture('shop_new.json'); self.index.note('shop_new.json')
            with patch('pathlib.Path.read_text', wraps=Path.read_text, autospec=True) as read:
                self.assertEqual(self.run_upload(), 1)
            self.assertEqual([c.args[0].name for c in read.call_args_list], ['shop_new.json'])
            self.assertEqual(send.call_count, 2)
        self.assertEqual(self.events[-1]['pending'], 0)

    def test_rescan_never_resends_ledgered_files(self):
        for n in range(2):self.capture(f'shop_{n}.json')
        with patch('shared_client.request_json', side_effect=accept_all) as send:
            self.run_upload()
            self.clock[0] = 600
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.index.names, set())

    def test_failed_files_stay_indexed_for_the_next_pass(self):
        from urllib.error import URLError
        self.capture('shop_a.json')
        with patch('shared_client.request_json', side_effect=URLError(TimeoutError())):
            with self.assertRaises(URLError):self.run_upload()
        self.assertEqual(self.index.names, {'shop_a.json'})
        with patch('shared_client.request_json', side_effect=accept_all):
            self.assertEqual(self.run_upload(), 1)
        self.assertEqual(self.index.names, set())


class FollowingTimelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'map_observations.jsonl'

    def test_reads_only_appended_complete_lines_and_matches_a_full_parse(self):
        self.path.write_text(map_line('s', 100, 4, 1))
        timeline = FollowingTimeline(self.path)
        self.assertEqual(timeline.resolve('s', 150)['channel'], 4)
        partial = map_line('s', 200, 7, 2)
        with self.path.open('a') as f:f.write(partial[:40])
        timeline.refresh()
        self.assertEqual(timeline.resolve('s', 250)['channel'], 4)
        with self.path.open('a') as f:f.write(partial[40:] + map_line('t', 300, 9, 3))
        with patch('json.loads', wraps=json.loads) as parse:
            timeline.refresh()
        self.assertEqual(parse.call_count, 2)
        full = LocationTimeline(self.path)
        for session, stamp in (('s', 150), ('s', 250), ('t', 400), ('t', 10)):
            self.assertEqual(timeline.resolve(session, stamp), full.resolve(session, stamp))
            self.assertEqual(timeline.resolve_context(session, stamp), full.resolve_context(session, stamp))

    def test_shorter_file_is_read_again(self):
        self.path.write_text(map_line('s', 100, 4, 1) + map_line('s', 200, 5, 1))
        timeline = FollowingTimeline(self.path)
        self.path.write_text(map_line('s', 100, 6, 1))
        timeline.refresh()
        self.assertEqual(timeline.resolve('s', 300)['channel'], 6)

    def test_missing_file_is_empty(self):
        self.assertIsNone(FollowingTimeline(self.path).resolve('s', 1))


if __name__ == '__main__':
    unittest.main()
