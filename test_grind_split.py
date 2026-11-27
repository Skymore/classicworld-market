"""A change of grinding map splits the record (Tracker.next_record, grind_replay.apply_results)."""
import contextlib
import json
import sqlite3
import unittest

import test_grind_tracker as base
from test_grind_tracker import portal, stat

A, B, TOWN = 104040000, 104040100, 100000000


class SplitTest(unittest.TestCase):
    tearDown = base.TrackerTest.tearDown
    send = base.TrackerTest.send
    kill = base.TrackerTest.kill
    current = base.TrackerTest.current

    def setUp(self):
        base.TrackerTest.setUp(self)
        character = self.tracker.characters['s1']
        character.key = character.name = 'Skyyyy'

    def grind(self, seconds, every=10, exp=100):
        for _ in range(int(seconds // every)):
            self.kill(exp, after=every)
            self.tracker.tick()

    def wait(self, seconds, step=5):
        for _ in range(int(seconds // step)):
            self.clock.t += step
            self.tracker.tick()

    def go(self, map_id, after=5):
        self.send(portal(map_id), after)
        self.tracker.tick()

    def end(self, after=1):
        self.clock.t += after
        path = self.folder / 'grind' / 'command.json'
        path.write_text(json.dumps(dict(id=str(self.clock.t), action='end', at=self.clock.t)), encoding='utf-8')
        self.tracker.tick()

    def history(self):
        with contextlib.closing(sqlite3.connect(self.folder / 'grind' / 'history.sqlite')) as db:
            return [json.loads(r) for r, in db.execute('SELECT summary FROM runs ORDER BY started_at')]

    def assertAccounted(self, runs):
        for run in runs:
            self.assertAlmostEqual(run['active_seconds'] + run['idle_seconds'], run['ended_at'] - run['started_at'], delta=1.5)

    def test_another_grinding_map_ends_the_record_at_its_first_gain(self):
        self.tracker.prices.maps.update({A: dict(name='破败的坟墓'), B: dict(name='猴子森林II')})
        self.grind(1800)
        self.go(TOWN)
        self.wait(500)                      # a long stop in town: idle, never a record
        self.go(B)
        self.grind(30)                      # three kills start the next record
        live = self.current()
        first, = self.history()            # the record on A is ended and saved at once
        self.assertEqual(first['map_name'], '破败的坟墓')
        self.assertAlmostEqual(first['ended_at'], live.started_at)
        self.grind(50)
        self.wait(190)
        self.end()
        a, b = self.history()
        self.assertEqual((a['map_name'], b['map_name']), ('破败的坟墓', '猴子森林II'))
        self.assertEqual([s['map_id'] for s in b['segments']], [B])
        self.assertEqual(b['chain'], a['id'])
        self.assertEqual(a['chain'], a['id'])
        self.assertEqual(b['previous_id'], a['id'])
        self.assertEqual(a['kills'] + b['kills'], 180 + 8 - 1)   # the very first reading is the baseline
        self.assertEqual(a['exp'] + b['exp'], 187 * 100)
        self.assertGreaterEqual(a['idle_seconds'], 500)      # the town stop belongs to the record before
        self.assertAlmostEqual(b['active_seconds'], 80, delta=12)
        self.assertGreaterEqual(b['idle_seconds'], 180)      # the wait before "end" is idle (less the 10 s of grace)
        self.assertAccounted([a, b])
        uploads = [p for p in self.folder.glob('grind_*.json') if p.name != 'grind_state.json']
        self.assertEqual(len(uploads), 1)   # the anonymous map statistics: only the record over 5 minutes

    def test_splitting_keeps_every_total(self):
        def play(tracker_test, minimum):
            tracker_test.tracker.settings['min_record_seconds'] = minimum
            tracker_test.grind(600)
            tracker_test.inv.give(4000019, 4)
            tracker_test.kill()
            tracker_test.go(B)
            tracker_test.grind(300)
            tracker_test.inv.give(4000019, 3)
            tracker_test.send(stat(mesos=1500), 3)
            tracker_test.kill()
            tracker_test.end()
            return tracker_test.history()
        split = play(self, 60)
        self.tearDown()
        self.setUp()
        whole = play(self, 10 ** 9)
        self.assertEqual((len(split), len(whole)), (2, 1))
        for key in ('exp', 'kills', 'mesos', 'item_value', 'consume_cost', 'net', 'active_seconds'):
            self.assertAlmostEqual(sum(r[key] for r in split), whole[0][key], delta=1, msg=key)
        self.assertAccounted(split + whole)

    def test_a_supply_trip_stays_in_the_record_as_idle_time(self):
        self.grind(600)
        self.go(TOWN)
        self.wait(120)
        self.go(A)
        self.grind(300)
        self.end()
        run, = self.history()
        self.assertEqual([s['map_id'] for s in run['segments']], [A])
        self.assertGreaterEqual(run['idle_seconds'], 120)
        self.assertAccounted([run])

    def test_a_long_stay_on_another_map_and_back_is_three_records(self):
        self.grind(600)
        self.go(B)
        self.grind(300)
        self.go(A)
        self.grind(300)
        self.end()
        runs = self.history()
        self.assertEqual([r['map_id'] for r in runs], [A, B, A])
        self.assertEqual(len({r['chain'] for r in runs}), 1)
        self.assertAccounted(runs)

    def test_a_short_stay_on_another_map_goes_back_into_the_record(self):
        self.grind(600)
        self.go(B)
        self.grind(40)                      # four kills: a record of its own while there...
        self.assertNotEqual(self.current().segment.map_id, A)
        self.assertEqual(len(self.history()), 1)
        self.go(A)
        self.grind(300)                     # ...back on A: one record again, no fragment
        self.end()
        run, = self.history()
        self.assertEqual([s['map_id'] for s in run['segments']], [A, B, A])
        self.assertEqual(run['map_id'], A)
        self.assertEqual(run['kills'], 59 + 4 + 30)
        self.assertAccounted([run])

    def test_a_short_last_map_goes_back_into_the_record_before(self):
        self.grind(600)
        self.go(B)
        self.grind(40)
        self.end()
        run, = self.history()
        self.assertEqual([s['map_id'] for s in run['segments']], [A, B])
        self.assertEqual((run['map_id'], run['kills']), (A, 63))
        self.assertAccounted([run])
        uploads = [p for p in self.folder.glob('grind_*.json') if p.name != 'grind_state.json']
        self.assertEqual(len(uploads), 1)

    def test_a_few_kills_passing_through_a_map_never_make_a_record(self):
        self.grind(600)
        self.go(B, after=2)
        self.grind(15, every=5)             # three quick kills on the way (under the minimum)
        self.go(B + 1, after=2)
        self.grind(600)
        self.end()
        a, c = self.history()
        self.assertEqual([s['map_id'] for s in a['segments']], [A, B])
        self.assertEqual([s['map_id'] for s in c['segments']], [B + 1])
        self.assertAlmostEqual(a['ended_at'], c['started_at'])
        self.assertAccounted([a, c])

    def test_a_short_first_map_joins_the_next_record_named_after_the_longer_map(self):
        self.tracker.prices.maps.update({A: dict(name='A'), B: dict(name='B')})
        self.go(TOWN)
        self.wait(300)                      # town before any grinding is in no record
        self.go(A)
        self.grind(40)
        self.go(B)
        self.grind(600)
        self.end()
        run, = self.history()
        self.assertEqual([s['map_id'] for s in run['segments']], [A, B])
        self.assertEqual(run['map_name'], 'B')                  # not the last map: the longest
        self.assertAccounted([run])

    def test_the_record_waiting_for_the_next_survives_a_restart(self):
        from grind_tracker import Tracker
        self.grind(600)
        self.go(B)
        self.grind(40)
        self.tracker.persist()
        saved = json.loads((self.folder / 'grind' / 'current.json').read_text(encoding='utf-8'))
        self.assertEqual(len(saved['previous']), 1)
        again = Tracker(self.folder, self.tracker.prices, now=self.clock)
        self.assertEqual(len(again.pending), 1)
        self.assertEqual(again.restored[0].previous_id, saved['previous'][0]['id'])

    def test_ended_by_waiting_the_record_ends_where_grinding_stopped(self):
        self.grind(600)
        stopped = self.clock.t
        self.go(TOWN)
        self.wait(700)
        run, = self.history()
        self.assertLess(run['ended_at'] - stopped, 15)
        self.assertAccounted([run])


class ApplySplitTest(unittest.TestCase):
    def test_a_saved_run_is_replaced_by_its_records_once(self):
        import tempfile
        from pathlib import Path
        from grind_replay import apply_results, piece_id
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            char = dict(key='Skyyyy')
            old = dict(id='a' * 32, character=char, started_at=1000.0, ended_at=20000.0, map_id=B,
                       segments=[dict(map_id=A, active_seconds=16995), dict(map_id=B, active_seconds=74)])
            with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db, db:
                db.execute('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at REAL, ended_at REAL, summary TEXT)')
                db.execute('INSERT INTO runs VALUES (?,?,?,?)', (old['id'], 1000.0, 20000.0, json.dumps(old)))
            results = [dict(id='x' * 32, character=char, started_at=1000.2, ended_at=19500.0, map_id=A, chain='x' * 32, exp=1093499),
                       dict(id='y' * 32, character=char, started_at=19500.0, ended_at=20000.0, map_id=B, chain='x' * 32,
                            previous_id='x' * 32, exp=1675)]
            for _ in range(2):   # applying again changes nothing
                self.assertEqual(apply_results(data, results, {'Skyyyy': 0}, {'Skyyyy': 30000}, 'r17'), 2)
                with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db:
                    rows = [json.loads(r) for r, in db.execute('SELECT summary FROM runs ORDER BY started_at')]
                    kept, = db.execute('SELECT id, summary FROM split_runs').fetchall()
                self.assertEqual([r['id'] for r in rows], [old['id'], piece_id(old['id'], 1)])
                self.assertEqual([r['map_id'] for r in rows], [A, B])
                self.assertEqual(rows[1]['previous_id'], old['id'])
                self.assertEqual({r['chain'] for r in rows}, {old['id']})
                self.assertEqual(sum(r['exp'] for r in rows), 1095174)
                self.assertEqual((kept[0], json.loads(kept[1])['map_id']), (old['id'], B))   # the run as it was, for rollback


if __name__ == '__main__':
    unittest.main()
