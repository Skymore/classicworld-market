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
    def test_anonymous_interval_identity_and_map_names_repair_without_adding_totals(self):
        from grind_history_repair import HistoryRepair, apply_identities
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            clock = [time.time()-60]
            tracker = Tracker(root, Prices(), now=lambda: clock[0])
            inv = Inventory()
            inv.observe(snapshot(map_id=10004141), 's')
            tracker.observe('s', snapshot(map_id=10004141), inv)
            original = dict(id='unknown', character=dict(key=None, name=None), started_at=clock[0]+5,
                            ended_at=clock[0]+20, map_id=None, level=None, level_start=None,
                            exp=123, kills=4, net=321, segments=[])
            tracker.save_history(original)
            repair = HistoryRepair(root/'grind')
            repair.frame(tracker, original['started_at'], 's')
            self.assertEqual(apply_identities(root/'grind', repair.results, tracker.prices, 'test'), 1)
            with contextlib.closing(sqlite3.connect(root/'grind/history.sqlite')) as db:
                rows = db.execute('SELECT summary FROM runs').fetchall()
            self.assertEqual(len(rows), 1)
            row = json.loads(rows[0][0])
            self.assertEqual((row['character']['name'], row['map_name']), ('Tester', '第2军营'))
            self.assertEqual((row['exp'], row['kills'], row['net']), (123, 4, 321))
            self.assertEqual(apply_identities(root/'grind', repair.results, tracker.prices, 'test'), 0)
            tracker.frames.close()

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
