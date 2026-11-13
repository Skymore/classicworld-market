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


class RepriceTest(unittest.TestCase):
    def test_runs_the_frames_did_not_rebuild_take_todays_prices_except_equipment(self):
        import contextlib, json, sqlite3, tempfile
        from pathlib import Path
        from grind_pricing import Prices
        from grind_replay import reprice_history
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            run = dict(id='r', started_at=0, active_seconds=3600, mesos=1000, mesos_spent=0,
                       loot=[dict(item_id=4000019, quantity=10, value=50), dict(item_id=1442007, quantity=1, value=750000)],
                       consumables=[dict(item_id=2000002, used=10, cost=3500)])
            with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db, db:
                db.execute('CREATE TABLE runs (id TEXT PRIMARY KEY, summary TEXT)')
                db.execute('INSERT INTO runs VALUES (?, ?)', ('r', json.dumps(run)))
            prices = Prices()
            prices.rows = {4000019: dict(typical=12), 2000002: dict(typical=300, npc_shop=350), 1442007: dict(typical=1350000)}
            self.assertEqual(reprice_history(data, prices, 'v'), 1)
            with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db:
                out = json.loads(db.execute('SELECT summary FROM runs').fetchone()[0])
            self.assertEqual([r['value'] for r in out['loot']], [120, 750000])   # equipment kept
            self.assertEqual(out['consume_cost'], 3000)                            # median sale, not the shop's 350
            self.assertEqual(out['net'], 1000 + 750120 - 3000)
            self.assertEqual(reprice_history(data, prices, 'v'), 0)                # once per version


if __name__ == '__main__':
    unittest.main()
