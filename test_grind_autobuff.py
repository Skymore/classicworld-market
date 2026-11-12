import collections
import struct
import unittest

import grind_autobuff as autobuff
import test_grind_tracker as base


def key_table(presets):
    """A 0x5F5 frame: presets are {scan: (kind, action)} or None for a default table."""
    out = struct.pack('<H', autobuff.KEYMAP_OPCODE)
    for rows in list(presets) + [None]:      # three presets and the controller table
        if rows is None:
            out += b'\x01'
            continue
        out += b'\x00' + b''.join(struct.pack('<BI', *rows.get(scan, (0, 0))) for scan in range(89))
    return out + b'\x00'


class KeyTableTest(unittest.TestCase):
    def test_reads_skills_per_preset_and_follows_the_selected_preset(self):
        class C:
            skill_keys = key_preset = None
        c = C()
        frame = key_table([{18: (1, 3101004), 2: (2, 2002000)}, {16: (1, 3101004), 5: (4, 7)}, None])
        autobuff.observe_server(c, autobuff.KEYMAP_OPCODE, frame)
        self.assertEqual(c.skill_keys, [{3101004: 18, -2002000: 2}, {3101004: 16}, {}])
        self.assertIsNone(autobuff.skill_key(c, 3101004))          # presets differ, none selected yet
        autobuff.observe_client(c, autobuff.KEYMAP_INDEX, b'\0\0\x03\x01')
        self.assertEqual(autobuff.key_name(autobuff.skill_key(c, 3101004)), 'q')
        autobuff.observe_client(c, autobuff.KEYMAP_INDEX, b'\0\0\x00\x05\x00')   # an edit
        self.assertIsNone(c.skill_keys)

    def test_rejects_a_truncated_table(self):
        with self.assertRaises(ValueError):
            autobuff.skill_tables(key_table([{}, {}, {}])[:100])


class AutoBuffTest(unittest.TestCase):
    # The tracker test's fixture, without running its tests again here.
    setUp, tearDown, send, kill, current = (base.TrackerTest.setUp, base.TrackerTest.tearDown,
                                            base.TrackerTest.send, base.TrackerTest.kill, base.TrackerTest.current)

    def start(self, foreground=42):
        self.pressed = []
        self.auto = autobuff.AutoBuff(press=self.pressed.append, foreground=lambda: foreground,
                                      pid_of=lambda connection: 42, threaded=False)
        self.tracker.connection('s1', ('1.2.3.4', 8585, '10.0.0.2', 50000))
        character = self.tracker.characters['s1']
        self.send(key_table([{18: (1, 3101004)}, {18: (1, 3101004)}, {18: (1, 3101004)}]))
        for _ in range(4):
            self.kill()
        character.buffs[3101004] = (self.clock(), 30_000)
        self.current().casts[3101004] = 1                # the player cast it in this run
        self.current().segment.buff_totals[3101004] = 30
        return character

    def test_recasts_a_buff_about_to_end_with_its_key_once_per_retry(self):
        self.start()
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])                  # 30 s left
        self.clock.t += 28.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['e'])
        self.clock.t += 3
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['e'])               # waiting for the retry
        self.clock.t += autobuff.RETRY
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['e', 'e'])

    def test_skills_due_together_queue_one_a_second_soonest_first(self):
        character = self.start()
        self.send(key_table([{18: (1, 3101004), 19: (1, 3001003)}] * 3))
        run = self.current()
        run.casts[3001003] = 1
        run.segment.buff_totals[3001003] = 30
        character.buffs[3001003] = (self.clock() - 0.5, 30_000)   # ends half a second sooner
        self.clock.t += 27.2                                       # 2.3 and 2.8 seconds left
        self.auto.tick(self.tracker, self.clock())
        self.clock.t += 0.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['r'])
        self.clock.t += 0.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['r', 'e'])

    def test_a_buff_that_ended_while_the_game_was_behind_is_recast_when_it_is_back(self):
        character = self.start(foreground=7)
        self.clock.t += 29
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.auto.status()['waiting'], 'game_not_in_front')
        self.clock.t += 60
        del character.buffs[3101004]                     # long gone from the live timers
        self.auto.foreground = lambda: 42
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['e'])
        self.assertEqual(self.auto.status()['last']['key'], 'e')

    def test_final_attack_is_never_pressed(self):
        character = self.start()
        self.send(key_table([{19: (1, 3101000)}] * 3))
        character.buffs = {3101000: (self.clock(), 60_000)}
        self.current().casts[3101000] = 3
        self.current().segment.buff_totals = {3101000: 60}
        self.clock.t += 59
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])
        self.assertTrue(self.tracker.buff_row(3101000, 1, 60, False)['proc'])

    def test_a_buff_someone_else_cast_is_left_alone(self):
        self.start()
        self.current().casts.clear()
        self.clock.t += 29
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])

    def test_never_presses_into_another_window_or_a_paused_run(self):
        self.start(foreground=7)
        self.clock.t += 29
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])
        self.auto.foreground = lambda: 42
        self.current().status = 'paused'
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])

    def test_a_pinned_potion_is_used_a_second_after_it_ends_unless_renewed_or_out(self):
        character = self.start()
        self.send(key_table([{3: (2, 2002004)}] * 3))
        character.buffs = {-2002004: (self.clock(), 10_000)}
        character.bags = {2002004: 5}
        self.tracker.pinned_buffs = lambda c, now: {-2002004: 10}
        self.clock.t += 10.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])                  # ended half a second ago
        character.buffs = {-2002004: (self.clock(), 10_000)}   # the player drank one
        self.clock.t += 1
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])
        self.clock.t += 10
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])
        character.bags = {2002004: 0}
        self.clock.t += autobuff.RETRY + 2
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])               # none left in the bag

    def test_an_unpinned_potion_is_never_used(self):
        character = self.start()
        self.send(key_table([{3: (2, 2002004)}] * 3))
        character.buffs = {-2002004: (self.clock(), 10_000)}
        character.bags = {2002004: 5}
        self.tracker.pinned_buffs = lambda c, now: {}
        self.clock.t += 15
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])

    def test_a_skill_without_a_key_is_left_alone(self):
        character = self.start()
        character.buffs = {3001003: (self.clock(), 1000)}
        self.current().casts = collections.Counter({3001003: 1})
        self.current().segment.buff_totals = {3001003: 1}
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])


if __name__ == '__main__':
    unittest.main()
