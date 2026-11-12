import json
import struct
import tempfile
import unittest
from pathlib import Path

from grind_combat import Meter, attack, party
from grind_pricing import Prices
from grind_tracker import Run, Tracker
from test_grind_live import Clock, ME, OTHER, died, hit, snapshot, stat, exp_message


def local_attack(targets, skill=3001001, index=27):
    label = b'User Shoot' if index == 27 else b'User Melee'
    data = bytearray(115 + len(label))
    struct.pack_into('<HBBI', data, 0, index, 1, len(targets), skill)
    struct.pack_into('<H', data, 84, len(label))
    data[86:86+len(label)] = label
    struct.pack_into('<I', data, len(data)-12, len(targets))
    for oid, hits in targets:
        data += struct.pack('<IIH', oid, 67, len(hits))
        for amount in hits:
            data += struct.pack('<BQB', 1, amount, 0)
        data += bytes(90)
    return bytes(data) + bytes(13 if skill else 5)


def remote_attack(actor, targets, opcode=0x2A9):
    data = bytearray(63)
    struct.pack_into('<HI', data, 0, opcode, actor)
    struct.pack_into('<I', data, 8, 4001001)
    struct.pack_into('<I', data, 51, len(targets))
    for oid, hits in targets:
        data += struct.pack('<IHBB', oid, len(hits), 0, 1)
        for amount in hits:
            data += struct.pack('<QBB', amount, 1, 0)
        data += bytes(6)
    return bytes(data)


def roster(members, kind=0x0D):
    core = b''
    for ident, name, channel in members:
        name = name.encode('utf-8')
        core += struct.pack('<IH', ident, len(name)) + name + struct.pack('<QI i', 310, 68, channel) + bytes(125)
    title = b'Test party'
    if kind == 0x13:
        header = b'\xa7\0\x13\x03\0New' + struct.pack('<IB', 42, 0)
    elif kind == 0x10:
        header = b'\xa7\0\x10' + struct.pack('<IBBH', 999, 1, 0, 3) + b'Old' + struct.pack('<IB', 42, 0)
    else:
        header = b'\xa7\0\x0d\x01' + struct.pack('<IB', 42, 0)
    return header + core + struct.pack('<II', ME, 0) + bytes(144) + struct.pack('<H', len(title)) + title + b'\x01\0'


class LayoutTest(unittest.TestCase):
    def test_own_multitarget_multihit_and_zero_damage(self):
        targets = [(101, [100, 200, 0]), (102, [50, 60])]
        for index in (26, 27):
            for skill in (0, 3001001):
                parsed = attack(local_attack(targets, skill, index), index)
                self.assertEqual(parsed['targets'], targets)
                self.assertEqual(parsed['skill'], skill)
        self.assertEqual(attack(local_attack([]), 27)['targets'], [])

    def test_remote_physical_ranged_and_magic(self):
        targets = [(101, [300, 200]), (102, [0])]
        for op in (0x2A8, 0x2A9, 0x2AA):
            parsed = attack(remote_attack(OTHER, targets, op))
            self.assertEqual((parsed['actor'], parsed['targets']), (OTHER, targets))

    def test_malformed_and_unknown_layouts_do_not_create_damage(self):
        for data, index in ((local_attack([(1, [50])]), 27), (remote_attack(OTHER, [(1, [50])]), None)):
            for damaged in (data[:-1], data + b'\0', data[:50]):
                self.assertIsNone(attack(damaged, index))
        self.assertIsNone(attack(local_attack([(1, [50])]), 28))
        self.assertIsNone(attack(remote_attack(OTHER, [(1, [10**13])])))

    def test_party_snapshots_join_leave_and_unknown_shapes(self):
        members = [(ME, 'Tester', 17), (OTHER, 'Friend', 17)]
        for kind in (0x0D, 0x13, 0x10):
            parsed = party(roster(members, kind), ME)
            self.assertEqual(set(parsed), {ME, OTHER})
            self.assertEqual(parsed[OTHER]['name'], 'Friend')
        self.assertIsNone(party(roster(members)[:-1], ME))
        self.assertIsNone(party(roster(members), 888))
        self.assertIsNone(party(roster(members + [members[1]]), ME))
        self.assertEqual(party(b'\xa7\0\x10' + struct.pack('<I', ME), ME), {})

    def test_rates_decay_pause_and_persistence(self):
        meter = Meter()
        meter.damage(ME, 'Me', True, [(1, [900])], 100)
        meter.kill(OTHER, 'Friend')
        restored = Meter(json.loads(json.dumps(meter.to_json())))
        row = restored.rows(110, 10, 100, True, ME, 3)[0]
        self.assertEqual((row['damage'], row['dps'], row['average_dps'], row['kills']), (900, 90, 90, 3))
        self.assertEqual(restored.rows(145, 45, 100, True, ME, 3)[0]['dps'], 20)
        self.assertEqual(restored.rows(161, 61, 100, True, ME, 3)[0]['dps'], 0)
        self.assertIsNone(restored.rows(161, 61, 100, False, ME, 3)[0]['dps'])


class TrackerCombatTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        data = Path(self.folder.name) / 'grind'
        data.mkdir()
        (data/'settings.json').write_text(json.dumps(dict(record_frames=False)))
        self.clock = Clock()
        self.tracker = Tracker(self.folder.name, Prices(), now=self.clock)
        self.inv = type('Inv', (), dict(session=None, slots=None, mesos=None, equipment=None, worn=None))()
        self.send(snapshot())
        self.who = self.tracker.characters['s']
        self.who.table = list(range(900))
        self.send(roster([(ME, 'Tester', 17), (OTHER, 'Friend', 17)]))
        for _ in range(3):
            self.clock.t += 1
            self.tracker.gain(self.who, self.clock(), 100)

    def tearDown(self):
        self.folder.cleanup()

    def send(self, data):
        self.tracker.observe('s', data, self.inv)

    def rows(self):
        return {r['character_id']: r for r in self.tracker.summarize(self.who.run, self.clock(), self.who)['combat']}

    def test_only_party_damage_counts_and_own_broadcast_is_not_duplicated(self):
        self.tracker.observe_client('s', local_attack([(1, [100, 200])]))
        self.send(remote_attack(ME, [(1, [100, 200])]))
        self.send(remote_attack(OTHER, [(2, [400])]))
        self.send(remote_attack(999, [(3, [9000])]))
        rows = self.rows()
        self.assertEqual(set(rows), {ME, OTHER})
        self.assertEqual((rows[ME]['damage'], rows[OTHER]['damage']), (300, 400))

    def test_kills_follow_server_ownership_not_attack_participation(self):
        self.tracker.observe_client('s', local_attack([(1, [100])]))
        self.send(remote_attack(OTHER, [(1, [200])]))
        self.send(hit(1, ME))
        self.send(hit(1, OTHER))
        self.send(died(1))
        self.send(died(1))
        self.send(hit(2, ME))
        self.send(died(2))
        rows = self.rows()
        self.assertEqual((rows[ME]['kills'], rows[OTHER]['kills']), (1, 1))
        self.assertEqual(self.who.run.segment.kills, 1)

    def test_leave_and_channel_change_stop_party_attribution(self):
        self.send(remote_attack(OTHER, [(1, [200])]))
        self.send(b'\xa7\0\x2a\x01' + struct.pack('<IIi', OTHER, 3, 18))
        self.assertTrue(self.rows()[OTHER]['away'])
        self.send(remote_attack(OTHER, [(1, [1000])]))
        self.assertEqual(self.rows()[OTHER]['damage'], 200)
        self.send(roster([(ME, 'Tester', 17)]))
        self.send(remote_attack(OTHER, [(1, [300])]))
        self.assertEqual(self.rows()[OTHER]['damage'], 200)

    def test_partial_frames_pause_and_history_keep_honest_totals(self):
        self.tracker.observe_client('s', local_attack([(1, [200])]))
        self.tracker.observe_client('s', local_attack([(2, [200])])[:-1])
        row = self.rows()[ME]
        self.assertTrue(row['partial'])
        self.assertIsNone(row['dps'])
        self.assertEqual(row['damage'], 200)
        self.who.run.status = 'paused'
        self.who.run.pause_reason = 'manual'
        self.tracker.observe_client('s', local_attack([(3, [500])]))
        self.assertEqual(self.rows()[ME]['damage'], 200)
        restored = Run.from_json(json.loads(json.dumps(self.who.run.to_json())))
        summary = self.tracker.summarize(restored, self.clock())
        self.assertEqual(summary['damage'], 200)

    def test_damage_clock_starts_when_observed_not_before_an_update(self):
        self.clock.t += 600
        self.who.run.credit(self.clock())
        self.tracker.observe_client('s', local_attack([(1, [1000])]))
        self.clock.t += 10
        row = self.rows()[ME]
        self.assertEqual((row['dps'], row['average_dps']), (100, 100))


if __name__ == '__main__':
    unittest.main()
