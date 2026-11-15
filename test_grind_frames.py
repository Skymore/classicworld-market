"""Local recordings: 30 days kept, closed files compressed, readers see both forms."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

import grind_frames
from grind_frames import FrameLog, compress, frame_files, frame_lines, frame_name, read_frames
from grind_reconcile import frames


def lines(n, start=0):
    return ''.join(json.dumps(dict(t=1000 + i, s='one', h='7200' + f'{i:02x}')) + '\n' for i in range(start, start + n))


class FrameFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)
        self.folder = self.data / 'frames'
        self.folder.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_compressed_recordings_read_the_same(self):
        plain = self.folder / 'frames_20261115_120000_aaaa.jsonl'
        plain.write_text(lines(3), encoding='ascii')
        (self.folder / 'frames_20261115_130000_bbbb.jsonl').write_text(lines(2, 3), encoding='ascii')
        compress(plain)
        self.assertFalse(plain.exists())
        files = frame_files(self.folder)
        self.assertEqual([frame_name(p) for p in files], ['frames_20261115_120000_aaaa.jsonl', 'frames_20261115_130000_bbbb.jsonl'])
        self.assertTrue(files[0].name.endswith('.gz'))
        self.assertEqual(len(frame_lines(files[0])), 3)
        self.assertEqual([t for t, _, _ in read_frames(files)], [1000, 1001, 1002, 1003, 1004])

    def test_reconcile_offsets_survive_compression_between_passes(self):
        plain = self.folder / 'frames_20261115_120000_aaaa.jsonl'
        plain.write_text(lines(3), encoding='ascii')
        first = next(frames(self.data))   # the first pass stopped after one line
        offsets = {first[0]: first[1]}
        compress(plain)
        rest = [record['t'] for _, _, record in frames(self.data, offsets)]
        self.assertEqual(rest, [1001, 1002])

    def test_a_file_compressed_after_it_was_listed_is_still_read(self):
        plain = self.folder / 'frames_20261115_120000_aaaa.jsonl'
        plain.write_text(lines(3), encoding='ascii')
        listed = frame_files(self.folder)
        compress(plain)                                 # by the background thread, meanwhile
        self.assertEqual([t for t, _, _ in read_frames(listed)], [1000, 1001, 1002])
        with grind_frames.open_frames(listed[0]) as stream:
            self.assertEqual(len(stream.read().splitlines()), 3)

    def test_both_forms_present_reads_the_plain_one_once(self):
        plain = self.folder / 'frames_20261115_120000_aaaa.jsonl'
        plain.write_text(lines(3), encoding='ascii')
        compress(plain)
        plain.write_text(lines(3), encoding='ascii')   # compression not finished removing it yet
        self.assertEqual(frame_files(self.folder), [plain])

    def test_prune_keeps_thirty_days_and_compresses_closed_files(self):
        now = time.time()
        old = self.folder / 'frames_20261001_000000_old0.jsonl'
        closed = self.folder / 'frames_20261110_000000_done.jsonl'
        recent = self.folder / 'frames_20261115_120000_live.jsonl'
        for path in (old, closed, recent):
            path.write_text(lines(2), encoding='ascii')
        os.utime(old, (now - 31 * 86400,) * 2)
        os.utime(closed, (now - 5 * 86400,) * 2)
        self.assertEqual(grind_frames.RETENTION_SECONDS, 30 * 24 * 3600)
        log = FrameLog(self.folder)
        log.prune(now)
        deadline = time.time() + 5
        while closed.exists() and time.time() < deadline:
            time.sleep(.05)
        self.assertFalse(old.exists())
        self.assertFalse(closed.exists())
        self.assertTrue(closed.with_name(closed.name + '.gz').exists())
        self.assertTrue(recent.exists())   # written within the hour: left as it is


if __name__ == '__main__':
    unittest.main()
