import contextlib
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from grind_pricing import Prices
from grind_reconcile import prepare, apply_pending
from grind_tracker import Tracker, write_json
from market_inventory import Inventory
from test_grind_live import snapshot, stat, spawn, hit, died, ME


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.clock = [round(time.time()-100, 3)]
        write_json(self.folder/'grind/settings.json', dict(record_frames=True, upload=False))
        self.tracker = Tracker(self.folder, Prices(), now=lambda: self.clock[0])
        self.inventory = Inventory()
        self.send(snapshot())
        for n in range(1, 6):
            self.clock[0] += 2
            for data in (spawn(n, 22), hit(n, ME), died(n), stat(exp=5000+n*40)):
                self.send(data)
        self.character = self.tracker.characters['s']
        self.run = self.character.run
        fragment = dict(self.tracker.summarize(self.run, self.clock[0], self.character),
                        id='fragment', started_at=self.run.started_at+2, ended_at=self.clock[0])
        self.tracker.save_history(fragment)
        self.run.segment.exp -= 40
        self.run.segment.kills -= 1
        self.tracker.persist()
        self.tracker.frames.flush()

    def tearDown(self):
        self.tracker.frames.close()

    def send(self, payload):
        self.inventory.observe(payload, 's')
        self.tracker.observe('s', payload, self.inventory)

    def count_history(self):
        with contextlib.closing(sqlite3.connect(self.folder/'grind/history.sqlite')) as db:
            return db.execute('SELECT count(*) FROM runs').fetchone()[0]

    def test_rebuild_catches_up_new_frames_and_replaces_instead_of_adding(self):
        report = prepare(self.folder)
        self.assertEqual(report['retire'], ['fragment'])
        self.assertEqual(report['before'], dict(exp=160, kills=4))
        self.assertEqual(report['after'], dict(exp=200, kills=5))
        pending = (self.folder/'grind/reconcile-pending.json').read_text()
        self.clock[0] += 2
        for data in (spawn(6, 22), hit(6, ME), died(6), stat(exp=5240)):
            self.send(data)
        apply_pending(self.tracker)
        self.assertEqual((self.character.run.segment.exp, self.character.run.segment.kills), (240, 6))
        self.assertEqual(self.character.run.id, self.run.id)
        self.assertEqual(self.character.exp, 5240)
        self.assertEqual(self.count_history(), 0)
        self.tracker.save_history(dict(self.tracker.summarize(self.character.run, self.clock[0], self.character), id='fragment'))
        self.assertEqual(self.count_history(), 0)
        # A restart after committing the ledger but before deleting the request
        # must not double count a second application.
        (self.folder/'grind/reconcile-pending.json').write_text(pending)
        apply_pending(self.tracker)
        self.assertEqual((self.character.run.segment.exp, self.character.run.segment.kills), (240, 6))
        self.assertEqual(self.count_history(), 0)

    def test_manual_end_during_rebuild_keeps_history(self):
        prepare(self.folder)
        self.clock[0] += 2
        write_json(self.folder/'grind/command.json', dict(id='end', action='end', at=self.clock[0]))
        self.tracker.command(self.clock[0])
        apply_pending(self.tracker)
        self.assertIsNone(self.character.run)
        self.assertEqual(self.count_history(), 2)


if __name__ == '__main__':
    unittest.main()
