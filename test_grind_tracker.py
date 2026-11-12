import json
import sqlite3
import struct
import tempfile
import unittest
from pathlib import Path

import grind_protocol as proto
from grind_pricing import Prices, group_key
from grind_tracker import Tracker

EXP, LEVEL, MESO, HP = 16, 4, 18, 10
SIZES = {EXP: 8, LEVEL: 1, MESO: 8, HP: 4}


def stat(**fields):
    """A synthetic 0x7E stat update (fields in ascending bit order)."""
    bits = dict(exp=EXP, level=LEVEL, mesos=MESO, hp=HP)
    chosen = sorted((bits[k], v) for k, v in fields.items())
    mask = sum(1 << b for b, _ in chosen)
    body = b''.join(v.to_bytes(SIZES[b], 'little') for b, v in chosen)
    return b'\x7e\x00\x00\x00\x01' + struct.pack('<I', mask) + body + b'\x00\x00'


def portal(map_id, channel=3):
    data = bytearray(103)
    struct.pack_into('<H', data, 0, 0x1A6)
    struct.pack_into('<I', data, 10, channel - 1)
    struct.pack_into('<I', data, 36, map_id)
    return bytes(data)


class FakeInventory:
    """What the tracker reads from market_inventory.Inventory."""
    def __init__(self, session):
        self.session = session
        self.slots = {}
        self.mesos = 1000
        self.equipment = {}
        self.worn = {}

    def give(self, item, quantity, slot=None):
        category = item // 1000000
        for key, (held, count) in self.slots.items():
            if held == item:
                self.slots[key] = (item, count + quantity)
                return
        slot = slot or len(self.slots) + 1
        self.slots[category, slot] = (item, quantity)

    def take(self, item, quantity):
        for key, (held, count) in list(self.slots.items()):
            if held == item:
                if count - quantity:
                    self.slots[key] = (item, count - quantity)
                else:
                    del self.slots[key]
                return


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


def prices():
    p = Prices()
    p.rows = {
        4000019: dict(name='蜗牛壳', typical=12, npc_sell=1, at=1e12),
        2000000: dict(name='红色药水', typical=40, npc_shop=50, at=1e12),
        2070000: dict(name='海星镖', npc_shop=500, at=1e12),
        1082002: dict(name='工地手套', typical=20000, npc_sell=100, at=1e12,
                      groups=[dict(key=group_key(dict(stats=[dict(key='weapon_attack', value=3)],
                                                      remaining_upgrades=5)), median=900000)]),
    }
    return p


class TrackerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.folder = Path(self.dir.name)
        grind = self.folder / 'grind'
        grind.mkdir()
        profile = proto.default_profile()
        profile['stat'] = dict(sizes={str(k): v for k, v in SIZES.items()},
                               bits=dict(exp=EXP, level=LEVEL, hp=HP), confirmed=True)
        proto.save_profile(grind / 'protocol.json', profile)
        (grind / 'settings.json').write_text(json.dumps(dict(record_frames=False)), encoding='utf-8')
        self.clock = Clock()
        self.tracker = Tracker(self.folder, prices(), now=self.clock)
        self.inv = FakeInventory('s1')
        self.exp = 1000
        self.send(portal(104040000))
        character = self.tracker.characters['s1']
        character.level = 20
        character.bags = {}

    def tearDown(self):
        self.dir.cleanup()

    def send(self, data, after=0):
        self.clock.t += after
        self.tracker.observe('s1', data, self.inv)

    def kill(self, exp=100, after=5):
        self.exp += exp
        self.send(stat(exp=self.exp), after)

    def current(self):
        return self.tracker.characters['s1'].run

    def test_a_single_reward_does_not_start_but_repeated_kills_do_and_keep_their_loot(self):
        self.kill(after=0)              # first update sets the baseline
        self.kill(500)                  # a quest-sized single gain
        self.assertIsNone(self.current())
        self.inv.give(4000019, 2)
        self.send(stat(mesos=1100), 1)  # picked-up money while arming
        self.kill()
        self.kill()
        run = self.current()
        self.assertIsNotNone(run)
        self.assertEqual(run.status, 'active')
        summary = self.tracker.summarize(run, self.clock(), self.tracker.characters['s1'])
        self.assertEqual(summary['exp'], 700)
        self.assertEqual(summary['kills'], 3)
        self.assertEqual(summary['mesos'], 100)
        self.assertEqual(summary['item_value'], 24)

    def test_experience_in_a_town_never_starts_a_run(self):
        self.tracker.prices.maps[100000000] = dict(name='射手村', is_town=True)
        self.send(portal(100000000))
        for _ in range(6):
            self.kill()
        self.assertIsNone(self.current())
        self.tracker.prices.maps[104040000] = dict(name='射手村东部平原', is_town=False)
        self.send(portal(104040000))
        for _ in range(3):
            self.kill()
        self.assertEqual(self.tracker.summarize(self.current(), self.clock())['map_name'], '射手村东部平原')

    def test_values_loot_by_attribute_group_and_costs_consumables_at_shop_price(self):
        for _ in range(4):
            self.kill()
        self.inv.equipment[3] = dict(slot=3, item_id=1082002, stats=[dict(key='weapon_attack', value=3)],
                                     remaining_upgrades=5, unknown_fields=0)
        self.kill()
        self.inv.give(2000000, 10)
        self.tracker.characters['s1'].bags = {2000000: 10}
        self.inv.take(2000000, 3)
        self.kill()
        self.inv.give(4000019, 5)
        self.kill()
        summary = self.tracker.summarize(self.current(), self.clock(), self.tracker.characters['s1'])
        self.assertEqual(summary['item_value'], 900000 + 5 * 12)
        self.assertEqual(summary['consume_cost'], 3 * 50)
        self.assertEqual(summary['net'], 900000 + 60 - 150)
        notable = [r for r in summary['recent'] if r['notable']]
        self.assertEqual(notable[0]['basis'], '同属性成交中位')
        potion = summary['consumables'][0]
        self.assertEqual((potion['item_id'], potion['used'], potion['remaining']), (2000000, 3, 7))

    def test_idle_pause_credits_ten_seconds_and_map_change_starts_a_segment(self):
        for _ in range(4):
            self.kill(after=10)
        run = self.current()
        self.clock.t += 200
        self.tracker.tick()
        self.assertEqual((run.status, run.pause_reason), ('paused', 'idle'))
        # Gains at 20, 30, 40 s (the first update is the baseline), then 10 s of grace.
        self.assertAlmostEqual(run.active_seconds(self.clock()), 20 + 10)
        # Back to killing in the same map: same segment.
        for _ in range(3):
            self.kill(after=5)
        self.assertEqual(run.status, 'active')
        self.assertEqual(len(run.segments), 1)
        # Town trip: money spent there is not grinding.
        self.send(portal(100000000), 2)
        self.assertEqual(run.pause_reason, 'map')
        self.send(stat(mesos=500), 5)
        self.inv.give(2000000, 100)
        self.send(stat(hp=50), 1)
        self.send(portal(104040100), 30)
        for _ in range(3):
            self.kill(after=5)
        self.assertEqual([s.map_id for s in run.segments], [104040000, 104040100])
        summary = self.tracker.summarize(run, self.clock(), self.tracker.characters['s1'])
        self.assertEqual(summary['mesos_spent'], 0)
        self.assertEqual(summary['consume_cost'], 0)

    def test_level_up_and_death_adjust_experience(self):
        for _ in range(4):
            self.kill(after=5)
        # Level 20 needs 20216; 400 before the level, 300 after.
        before = 20216 - 400
        self.exp = before
        self.send(stat(exp=before), 5)
        self.send(stat(level=21, exp=300), 5)
        run = self.current()
        self.assertEqual(run.segment.exp, 300 + (before - 1400) + 400 + 300)
        self.send(stat(exp=100), 5)
        self.assertEqual((run.deaths, run.exp_lost), (1, 200))

    def test_long_pause_ends_saves_history_and_queues_an_anonymous_upload(self):
        for _ in range(30):
            self.kill(after=12)
        self.inv.give(4000019, 7)
        self.kill()
        self.send(portal(100000000), 1)
        self.clock.t += 700
        self.tracker.tick()
        self.assertIsNone(self.current())
        db = sqlite3.connect(self.folder / 'grind' / 'history.sqlite')
        (summary,), = db.execute('SELECT summary FROM runs').fetchall()
        db.close()
        self.assertEqual(json.loads(summary)['kills'], 30)
        upload, = [p for p in self.folder.glob('grind_*.json') if p.name != 'grind_state.json']
        payload = json.loads(upload.read_text(encoding='utf-8'))
        segment, = payload['segments']
        self.assertEqual(segment['map_id'], 104040000)
        self.assertEqual(segment['level'], 20)
        self.assertEqual(segment['drops'], [dict(item_id=4000019, quantity=7)])
        self.assertNotIn('name', json.dumps(payload))

    def test_snapshot_rebases_without_counting_and_disconnect_keeps_the_run(self):
        for _ in range(4):
            self.kill()
        run = self.current()
        self.tracker.disconnect('s1')
        self.assertEqual(run.pause_reason, 'disconnect')
        self.assertIn(run, self.tracker.restored)

    def test_state_file_lists_the_open_run(self):
        for _ in range(5):
            self.kill(after=10)
        self.clock.t += 2
        self.tracker.tick()
        state = json.loads((self.folder / 'grind_state.json').read_text(encoding='utf-8'))
        self.assertEqual(state['runs'][0]['status'], 'active')
        self.assertTrue(state['runs'][0]['exp_per_hour'])
        self.assertEqual(state['calibration'][0]['state'], '已确认')


    def test_buffs_kept_on_most_of_the_time_on_a_map_stay_pinned_after_they_run_out(self):
        character = self.tracker.characters['s1']
        character.key = 'hero'
        self.kill(after=0)
        character.buffs[2001002] = (self.clock(), 900_000)   # on for the whole run
        character.buffs[2001003] = (self.clock(), 60_000)    # only the first minute
        for _ in range(150):
            self.kill()
        self.assertGreater(self.current().active_seconds(self.clock()), 600)
        self.tracker.pin_cache = {}
        live = {b['source']: b for b in self.tracker.buffs(character, self.clock())}
        self.assertTrue(live[2001002]['pinned'])
        self.assertNotIn(2001003, live)
        self.clock.t += 900
        self.tracker.pin_cache = {}
        live = {b['source']: b for b in self.tracker.buffs(character, self.clock())}
        self.assertEqual((live[2001002]['seconds'], live[2001002]['total']), (0, 900))
        self.assertTrue(live[2001002]['pinned'])
        self.send(portal(104040100))
        self.tracker.pin_cache = {}
        self.assertEqual(self.tracker.buffs(self.tracker.characters['s1'], self.clock()), [])


    def test_final_attack_series_shows_as_a_buff(self):
        character = self.tracker.characters['s1']
        character.buffs[3101000] = (self.clock(), 60_000)
        shown = self.tracker.buffs(character, self.clock())
        self.assertEqual([(b['source'], b['name']) for b in shown], [(3101000, '终极弓')])


    def test_an_ended_run_keeps_how_its_kills_were_counted(self):
        character = self.tracker.characters['s1']
        character.character_id = 7
        self.tracker.profile.setdefault('kill', {})['confirmed'] = True
        for _ in range(4):
            self.kill()
        run = self.current()
        self.tracker.end(character, self.clock())
        self.assertFalse(self.tracker.summarize(run, self.clock())['kills_estimated'])


class GroupKeyTest(unittest.TestCase):
    def test_matches_the_server_string(self):
        piece = dict(stats=[dict(key='weapon_defense', value=2), dict(key='weapon_attack', value=2),
                            dict(key='dex', value=1)], remaining_upgrades=5, unknown_fields=0)
        self.assertEqual(group_key(piece), '[[["dex",1],["weapon_attack",2]],5,0]')


class ProtocolTest(unittest.TestCase):
    def test_stat_parsing_needs_every_size_and_the_exact_tail(self):
        self.assertEqual(proto.parse_stat(stat(exp=5, mesos=7), SIZES), {EXP: 5, MESO: 7})
        self.assertIsNone(proto.parse_stat(stat(exp=5), {MESO: 8}))
        self.assertIsNone(proto.parse_stat(stat(exp=5) + b'\x00', SIZES))
        self.assertEqual(proto.single_bit_size(stat(hp=9)), (HP, 4))


if __name__ == '__main__':
    unittest.main()
