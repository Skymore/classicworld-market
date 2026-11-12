import contextlib
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from grind_pricing import Prices
from grind_replay import replay_once
from grind_tracker import Tracker, write_json
from market_inventory import Inventory
from test_grind_live import snapshot, spawn, hit, died, exp_message, stat, ME


class ReplayTest(unittest.TestCase):
    def test_upgrade_replays_history_once_without_uploading_or_touching_live_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            clock = [time.time() - 60]
            write_json(root/'grind/settings.json', dict(record_frames=True, upload=False))
            tracker = Tracker(root, Prices(), now=lambda: clock[0])
            inv = Inventory()
            def send(data):
                inv.observe(data, 'test')
                tracker.observe('test', data, inv)
            send(snapshot())
            for n in range(1, 6):
                clock[0] += 2
                for data in (spawn(n, 22), hit(n, ME), died(n), exp_message(40), stat(exp=5000+n*40)):
                    send(data)
            clock[0] += 1
            write_json(root/'grind/command.json', dict(id='end', action='end', at=clock[0]))
            tracker.command(clock[0])
            tracker.frames.close()
            with contextlib.closing(sqlite3.connect(root/'grind/history.sqlite')) as db, db:
                ident, raw = db.execute('SELECT id,summary FROM runs').fetchone()
                old = json.loads(raw)
                expected = old['exp']
                old['exp'] = -999
                db.execute('UPDATE runs SET summary=?', (json.dumps(old),))
            live = root/'grind/current.json'
            live.write_text('keep-live-state')
            result = replay_once(root, 'test-v2')
            self.assertIsNotNone(result)
            self.assertEqual(result['updated'], 1)
            with contextlib.closing(sqlite3.connect(root/'grind/history.sqlite')) as db, db:
                row = json.loads(db.execute('SELECT summary FROM runs WHERE id=?', (ident,)).fetchone()[0])
            self.assertEqual(row['exp'], expected)
            self.assertEqual(row['replay_version'], 'test-v2')
            self.assertEqual(live.read_text(), 'keep-live-state')
            self.assertEqual(list(root.glob('grind_*.json')), [])
            self.assertEqual(replay_once(root, 'test-v2'), result)


if __name__ == '__main__':
    unittest.main()
