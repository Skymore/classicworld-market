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

    def test_moving_a_potion_onto_a_key_updates_the_table_instead_of_dropping_it(self):
        class C:
            skill_keys = key_preset = None
        c = C()
        autobuff.observe_server(c, autobuff.KEYMAP_OPCODE, key_table([{5: (1, 3101004)}, {5: (1, 3101004), 6: (1, 3001003)}, None]))
        autobuff.observe_client(c, autobuff.KEYMAP_INDEX, bytes.fromhex('00000301'))
        # Live 22:25:38: item 2012000 onto scan 5 ("4") in preset 1.
        autobuff.observe_client(c, autobuff.KEYMAP_INDEX, bytes.fromhex('0e620001ffffffffffffffff01050260b31e00'))
        self.assertIsNotNone(c.skill_keys)
        self.assertEqual(autobuff.skill_key(c, -2012000), 5)
        self.assertIsNone(autobuff.skill_key(c, 3101004))          # what was on that key is gone
        self.assertEqual(autobuff.skill_key(c, 3001003), 6)
        self.assertEqual(c.skill_keys[0], {3101004: 5})            # other presets untouched

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
        self.fighting = True
        self.tracker.in_combat = lambda c, now: self.fighting
        return character

    def test_recasts_a_buff_about_to_end_with_its_key_once_per_retry(self):
        self.start()
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])                  # 30 s left
        self.clock.t += 28.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['e'])
        self.clock.t += autobuff.RETRY / 2
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

    def test_buffs_wait_for_combat_but_potions_do_not(self):
        character = self.start()
        self.fighting = False
        self.clock.t += 29
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])
        self.fighting = True
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['e'])

    def test_a_potion_buff_is_used_three_seconds_after_the_server_cancels_it(self):
        character = self.start()
        self.send(key_table([{3: (2, 2002004)}] * 3))
        character.buffs = {}
        character.bags = {2002004: 5}
        self.current().casts.clear()
        self.current().segment.buff_totals = {-2002004: 600}
        character.buff_ended[-2002004] = self.clock()          # cancelled just now
        self.auto.tick(self.tracker, self.clock())
        self.clock.t += 2.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])
        self.clock.t += 1
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])

    def test_a_potion_is_pressed_once_per_ending_even_if_the_game_refuses(self):
        character = self.start()
        self.send(key_table([{3: (2, 2002000)}] * 3))
        character.buffs = {}
        character.bags = {2002000: 5}
        self.current().casts.clear()
        self.current().segment.buff_totals = {-2002000: 600}
        character.buff_ended[-2002000] = self.clock()
        for _ in range(6):
            self.clock.t += autobuff.ITEM_RETRY + 0.5
            self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])                     # the dialog is not asked again
        character.buff_ended[-2002000] = self.clock()            # it came back and ended again
        self.clock.t += autobuff.ITEM_LATE + 0.5
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2', '2'])

    def test_a_potion_never_seen_on_this_session_is_not_pressed(self):
        character = self.start()
        self.send(key_table([{3: (2, 2002000)}] * 3))
        character.buffs, character.buff_ended = {}, {}
        character.bags = {2002000: 5}
        self.current().segment.buff_totals = {-2002000: 600}
        self.clock.t += 10
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, [])

    def test_a_channel_change_keeps_the_buffs_that_are_still_on(self):
        character = self.start()
        character.key = 'hero'
        self.current().character['key'] = 'hero'
        character.buffs[-2002000] = (self.clock(), 600_000)
        self.tracker.disconnect('s1')
        from grind_tracker import Character
        fresh = self.tracker.characters['s2'] = Character('s2')
        fresh.key = 'hero'
        self.tracker.adopt_by_key(fresh)
        self.assertIn(-2002000, fresh.buffs)
        self.assertIn(3101004, fresh.buffs)
        self.assertIsNotNone(fresh.run)

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
        self.clock.t += 12
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])
        character.bags = {2002004: 0}
        self.clock.t += autobuff.RETRY + 2
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])               # none left in the bag

    def test_a_potion_drunk_in_this_run_is_used_again_a_second_after_it_ends(self):
        character = self.start()
        self.send(key_table([{3: (2, 2002004)}] * 3))
        character.buffs = {-2002004: (self.clock(), 10_000)}
        character.bags = {2002004: 5}
        self.current().segment.buff_totals[-2002004] = 10
        self.tracker.pinned_buffs = lambda c, now: {}
        self.clock.t += 13.2
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['2'])

    def test_an_unused_unpinned_potion_is_never_used(self):
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



class CancelTest(unittest.TestCase):
    setUp, tearDown, send = base.TrackerTest.setUp, base.TrackerTest.tearDown, base.TrackerTest.send

    def test_a_cancel_ends_a_buff_and_the_next_one_counts_as_turning_on(self):
        from test_grind_live import buff
        self.tracker.profile['buff'] = dict(confirmed=True, opcode=0x7F, start=126)
        character = self.tracker.characters['s1']
        given = buff(3101000, 60_000)
        self.send(given)
        first = character.buff_on[3101000]
        self.send(buff(3101000, 60_000), 2)                       # a refresh, not a new one
        self.assertEqual(character.buff_on[3101000], first)
        cancel = bytearray(129)
        cancel[0:5] = bytes.fromhex('8000010115')
        cancel[5:129] = given[2:126]
        self.send(bytes(cancel), 1)
        self.assertNotIn(3101000, character.buffs)
        self.assertEqual(character.buff_ended[3101000], self.clock())
        self.send(buff(3101000, 60_000), 0.5)
        self.assertEqual(character.buff_on[3101000], self.clock())
        row = [b for b in self.tracker.buffs(character, self.clock()) if b['source'] == 3101000][0]
        self.assertEqual((row['on'], row['proc']), (self.clock(), True))


class PotionTest(unittest.TestCase):
    setUp, tearDown, send, kill, current = AutoBuffTest.setUp, AutoBuffTest.tearDown, AutoBuffTest.send, AutoBuffTest.kill, AutoBuffTest.current
    start = AutoBuffTest.start

    def ready(self, hit=300, cost=30):
        character = self.start()
        character.buffs = {}
        self.current().casts.clear()
        # red (100) on 1, orange (250) on 2, white (500) on 3, blue MP (200) on 4
        self.send(key_table([{2: (2, 2000000), 3: (2, 2000001), 4: (2, 2000002), 5: (2, 2000003)}] * 3))
        character.bags = {2000000: 5, 2000001: 5, 2000002: 5, 2000003: 5}
        character.hp, character.max_hp, character.mp, character.max_mp = 1000, 1000, 1000, 1000
        self.tracker.combat_limits = lambda c, now: (hit, cost)
        return character

    def drink(self, character, **vitals):
        for key, value in vitals.items():
            setattr(character, key, value)
        self.clock.t += 2
        self.auto.tick(self.tracker, self.clock())

    def test_above_three_hits_nothing_below_it_the_smallest_that_wastes_nothing(self):
        character = self.ready(hit=300)                    # danger 600, comfort 900
        self.drink(character, hp=900)
        self.assertEqual(self.pressed, [])                 # not topping up for its own sake
        self.drink(character, hp=850)
        self.assertEqual(self.pressed, ['1'])              # red 100, 150 missing

    def test_between_the_lines_a_potion_that_would_be_wasted_waits(self):
        character = self.ready(hit=300)
        character.bags = {2000002: 5}                      # only white (500)
        self.drink(character, hp=850)
        self.assertEqual(self.pressed, [])

    def test_in_danger_the_smallest_potion_that_lifts_it_over_the_line(self):
        character = self.ready(hit=300)                    # danger 600
        self.drink(character, hp=500)
        self.assertEqual(self.pressed, ['1'])              # needs 100: red
        character.rise_at['hp'] = self.clock() + 0.1
        self.drink(character, hp=400)
        self.assertEqual(self.pressed, ['1', '2'])         # needs 200: orange

    def test_pet_setting_first_while_some_are_left(self):
        character = self.ready()
        character.pet_potions = {'hp': 2000001}
        self.drink(character, hp=700)
        self.assertEqual(self.pressed, ['2'])
        character.bags[2000001] = 0
        character.rise_at['hp'] = self.clock() + 0.5          # it took, then a hit
        self.drink(character, hp=700)
        self.assertEqual(self.pressed, ['2', '1'])

    def test_under_two_hits_drinks_even_if_some_is_wasted(self):
        character = self.ready(hit=500)
        character.bags = {2000002: 5}
        self.drink(character, hp=900)                 # missing 100 < 500, but 900 < 2 x 500
        self.assertEqual(self.pressed, ['3'])

    def test_mp_under_five_of_the_dearest_skill(self):
        character = self.ready(cost=30)
        self.drink(character, mp=160)
        self.assertEqual(self.pressed, [])
        self.drink(character, mp=140)
        self.assertEqual(self.pressed, ['4'])

    def test_a_potion_that_did_nothing_is_not_pressed_again_every_second(self):
        character = self.ready()
        self.drink(character, hp=700)
        self.assertEqual(self.pressed, ['1'])
        for _ in range(3):                                    # HP stays where it was
            self.clock.t += 1.3
            self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['1'])
        self.clock.t += 2
        self.auto.tick(self.tracker, self.clock())
        self.assertEqual(self.pressed, ['1', '1'])

    def test_reads_the_pet_setting_and_vitals_from_the_server(self):
        character = self.ready()
        self.send(bytes.fromhex('f60581841e00'))
        self.send(bytes.fromhex('f70595ab1e00'))
        self.assertEqual(character.pet_potions, {'hp': 2000001, 'mp': 2010005})
        import grind_protocol as proto
        snapshot = bytearray(600)
        snapshot[0:2] = (0x1A9).to_bytes(2, 'little')
        snapshot[14:24] = bytes.fromhex('00000000000100000000')
        snapshot[211:227] = struct.pack('<4I', 1958, 1992, 1170, 1616)
        self.assertEqual(proto.vitals(bytes(snapshot)), (1958, 1992, 1170, 1616))


if __name__ == '__main__':
    unittest.main()
