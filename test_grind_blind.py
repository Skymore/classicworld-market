"""Bags that could not be followed for a while: the difference between the last known
contents and the next known ones is counted (used / picked up, marked estimated)."""
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from grind_pricing import Prices
from grind_tracker import Run, Tracker, write_json
from market_inventory import Inventory
from test_grind_live import snapshot, stat, spawn, hit, died, ME

POTION, ARROW, ETC = 2000002, 2060002, 4000019


def bags(potions, arrows, etc=0, mesos=1000):
    slots = {(2, 1): (POTION, potions), (2, 2): (ARROW, arrows)}
    if etc:
        slots[(4, 1)] = (ETC, etc)
    return SimpleNamespace(slots=slots, mesos=mesos, equipment=None, worn=None)


class BlindBridgeTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.clock = [round(time.time() - 100, 3)]
        write_json(self.folder / 'grind/settings.json', dict(record_frames=False, upload=False))
        self.tracker = Tracker(self.folder, Prices(), now=lambda: self.clock[0])
        inventory = Inventory()
        for data in [snapshot()] + [d for n in range(1, 6) for d in (spawn(n, 22), hit(n, ME), died(n), stat(exp=5000 + n * 40))]:
            self.clock[0] += .5
            inventory.observe(data, 's')
            self.tracker.observe('s', data, inventory)
        self.character = self.tracker.characters['s']
        self.run = self.character.run
        self.assertIsNotNone(self.run)

    def see(self, state, rebase=False):
        self.clock[0] += 1
        self.tracker.inventory(self.character, state, self.clock[0], rebase=rebase)

    def estimated(self):
        return sorted((e['kind'], e.get('item_id'), e.get('quantity', e.get('mesos'))) for e in self.run.ledger if e.get('estimated'))

    def test_the_difference_across_an_unread_stretch_is_counted(self):
        self.see(bags(100, 5000, mesos=1000))
        self.see(SimpleNamespace(slots=None, mesos=None, equipment=None, worn=None))   # an update we could not read
        self.see(bags(88, 4700, etc=6, mesos=1900), rebase=True)                        # the next full snapshot
        self.assertEqual(self.estimated(), [('loot', ETC, 6), ('mesos', None, 900), ('used', POTION, 12), ('used', ARROW, 300)])

    def test_mesos_read_while_the_bags_were_not_are_not_counted_twice(self):
        self.see(bags(100, 5000, mesos=1000))
        self.see(SimpleNamespace(slots=None, mesos=1500, equipment=None, worn=None))   # bags unknown, mesos still read live
        self.see(bags(90, 5000, mesos=1500), rebase=True)
        self.assertEqual(self.estimated(), [('used', POTION, 10)])

    def test_a_restart_compares_with_the_bags_saved_in_the_run(self):
        self.see(bags(100, 5000))
        restored = Run.from_json(self.run.to_json())       # a new process, the connection not taken over
        self.character.run, self.run = restored, restored
        self.character.bags = None
        self.see(bags(95, 5000), rebase=True)
        self.assertEqual(self.estimated(), [('used', POTION, 5)])

    def test_a_channel_change_with_nothing_missed_adds_nothing(self):
        self.see(bags(100, 5000))
        self.see(bags(99, 5000))                             # one potion, seen as it happened
        self.see(bags(99, 5000), rebase=True)
        self.assertEqual(self.estimated(), [])

    def test_a_town_trip_in_between_is_not_counted(self):
        self.see(bags(10, 5000))
        self.run.status, self.run.pause_reason = 'paused', 'map'
        self.see(SimpleNamespace(slots=None, mesos=None, equipment=None, worn=None))
        self.run.status, self.run.pause_reason = 'active', None
        self.see(bags(300, 5000), rebase=True)               # bought potions in town
        self.assertEqual(self.estimated(), [])


if __name__ == '__main__':
    unittest.main()


class ExperienceBridgeTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        write_json(Path(self.folder.name) / 'grind/settings.json', dict(enabled=True, record_frames=False, upload=False))
        self.tracker = Tracker(self.folder.name, Prices(), now=time.time)
        self.run = Run(dict(key='Skyyyy', name='Skyyyy'), 1000.0)
        self.run.segments.append(SimpleNamespace(exp=100))

    def tearDown(self):
        self.folder.cleanup()

    def character(self, session, level, exp):
        return SimpleNamespace(run=self.run, level=level, exp=exp, session=session)

    def test_experience_gained_across_a_reconnect_is_added_as_estimated(self):
        # 2026-11-21: a restart in the middle of a run; the new connection reads 25,000 more.
        self.run.exp_seen = [1000.0, 72, 1_082_071, 'old']
        self.tracker.bridge_exp(self.character('new', 72, 1_107_071), 1300.0)
        self.assertEqual((self.run.exp_bridged, self.run.segments[-1].exp), (25_000, 25_100))
        # Read again on the same connection: nothing more.
        self.tracker.bridge_exp(self.character('new', 72, 1_107_071), 1301.0)
        self.assertEqual(self.run.exp_bridged, 25_000)

    def test_over_a_level_up_and_never_after_an_hour(self):
        from grind_data import exp_to_next
        self.run.exp_seen = [1000.0, 71, exp_to_next(71) - 500, 'old']
        self.tracker.bridge_exp(self.character('new', 72, 1500), 1200.0)
        self.assertEqual(self.run.exp_bridged, 2000)
        self.run.exp_seen = [1000.0, 72, 1500, 'old']
        self.tracker.bridge_exp(self.character('new2', 72, 9500), 1000.0 + 3601)
        self.assertEqual(self.run.exp_bridged, 2000)      # too long ago: not guessed

    def test_saved_with_the_run_and_never_the_same_connection_after_a_restart(self):
        self.run.exp_seen = [1000.0, 72, 1500, 'old']
        self.run.segments = []
        loaded = Run.from_json(self.run.to_json())
        self.assertEqual(loaded.exp_seen, [1000.0, 72, 1500, None])
