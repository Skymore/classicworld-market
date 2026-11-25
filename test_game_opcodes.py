import json
import struct
import unittest

import game_opcodes
from grind_frames import server_payload


def message(opcode, body=b'\x00' * 6):
    return struct.pack('<H', opcode) + body


class RenumberTest(unittest.TestCase):
    def test_the_updated_games_numbers_read_as_before(self):
        # Read off recordings from both sides of the 2026-11-18 update.
        for new, old in ((0x1A5, 0x1A9), (0x3CF, 0x3D4), (0x448, 0x44D), (0x3C4, 0x3C9), (0x3D0, 0x3D5),
                         (0x46D, 0x471), (0x470, 0x472), (0x5F3, 0x5F5), (0x229, 0x22D), (0x2A5, 0x2A8),
                         (0x7E, 0x7E), (0x72, 0x72), (0x8B, 0x8B), (0xAD, 0xAE)):
            self.assertEqual(game_opcodes.renumber(new, 1), old, hex(new))
        self.assertEqual(game_opcodes.normalize(message(0x1A5, b'abc'), 1), message(0x1A9, b'abc'))

    def test_a_number_between_blocks_is_unknown_never_an_old_message(self):
        # 0x46E is new in the updated game: it must not pass for any old message.
        unknown = game_opcodes.renumber(0x46E, 1)
        self.assertEqual(unknown, game_opcodes.UNKNOWN | 0x46E)
        for _, (new_to_old, old_to_new), (client, client_back) in game_opcodes.VERSIONS:
            self.assertNotIn(unknown, new_to_old.values())
            self.assertEqual(len(old_to_new), len(new_to_old))   # one-to-one
            self.assertEqual(len(client_back), len(client))

    def test_recordings_from_before_the_update_are_never_renumbered(self):
        before = dict(t=game_opcodes.UPDATE_AT - 60, s='a', h=message(0x1A5).hex())
        after = dict(before, t=game_opcodes.UPDATE_AT + 60)
        marked = dict(after, n=1)
        client = dict(after, c=1, i=26)
        self.assertEqual(server_payload(before)[:2], b'\xa5\x01')    # the old game's 0x1A5: as recorded
        self.assertEqual(server_payload(after)[:2], b'\xa9\x01')     # an older collector after the update
        self.assertEqual(server_payload(marked)[:2], b'\xa5\x01')    # renumbered live already
        self.assertEqual(server_payload(client)[:2], b'\xa5\x01')    # the player's own: not server numbering

    def test_the_players_own_messages_move_by_their_mapping_index_too(self):
        from grind_frames import recorded_index
        # Read off recordings from both sides of the update: unchanged up to 191, then -2, then -1.
        for new, old in ((20, 20), (26, 26), (73, 73), (119, 119), (186, 186), (319, 321), (210, 212), (565, 567), (866, 867)):
            self.assertEqual(game_opcodes.client_index(new, 1), old, new)
        self.assertEqual(game_opcodes.client_index(200, 1), game_opcodes.UNKNOWN | 200)   # between blocks
        pet = dict(t=game_opcodes.UPDATE_AT + 60, s='a', c=1, i=319, h='00')
        self.assertEqual(recorded_index(pet), 321)                                     # an older collector, new game
        self.assertEqual(recorded_index(dict(pet, n=1)), 319)                          # already renumbered
        self.assertEqual(recorded_index(dict(pet, t=game_opcodes.UPDATE_AT - 60)), 319)   # the old game

    def test_new_recordings_are_marked_as_read(self):
        import tempfile
        from grind_frames import FrameLog
        with tempfile.TemporaryDirectory() as folder:
            log = FrameLog(folder)
            log.write('s', message(0x1A9), now=game_opcodes.UPDATE_AT + 10)
            log.write('s', message(0x10), now=game_opcodes.UPDATE_AT + 11, index=26, client=True)
            log.flush()
            lines = [json.loads(l) for p in log.folder.glob('frames_*') for l in p.read_text().splitlines()]
        self.assertEqual([l.get('n') for l in lines], [1, 1])   # indexes too are in the parsers' numbering
        with tempfile.TemporaryDirectory() as folder:
            log = FrameLog(folder)
            log.write('s', message(0x1A9), now=game_opcodes.UPDATE_AT_1124 + 10)
            log.flush()
            lines = [json.loads(l) for p in log.folder.glob('frames_*') for l in p.read_text().splitlines()]
        self.assertEqual([l.get('n') for l in lines], [3])   # renumbered with the corrected 11-24 map



class Update1124Test(unittest.TestCase):
    def test_the_11_24_games_numbers_read_as_before(self):
        # Read off recordings from both sides of the 2026-11-24 update (the 11-18 game's
        # number - 1 from the 0x44E region on): the key table 0x5F3 -> 0x5F2 above all.
        for new, old in ((0x5F2, 0x5F5), (0x576, 0x579), (0x577, 0x57A), (0x578, 0x57B), (0x46C, 0x471),
                         (0x46F, 0x472), (0x62B, 0x62E), (0x1A5, 0x1A9), (0x229, 0x22D), (0x2A5, 0x2A8),
                         (0x7E, 0x7E), (0xAD, 0xAE)):
            self.assertEqual(game_opcodes.renumber(new, 3), old, hex(new))
        self.assertEqual(game_opcodes.renumber(0x5F3, 3), 0x5F6)   # was the key table: no longer
        # Mobs did not move (2026-11-25 recording: appear 0x3C4, leave 0x3CF, hit 0x448).
        for new, old in ((0x3C4, 0x3C9), (0x3CF, 0x3D4), (0x3D0, 0x3D5), (0x448, 0x44D)):
            self.assertEqual(game_opcodes.renumber(new, 3), old, hex(new))
        for new, old in ((20, 20), (186, 186), (210, 212), (319, 321), (529, 531), (830, 832), (865, 867)):
            self.assertEqual(game_opcodes.client_index(new, 3), old, new)
        at = game_opcodes.UPDATE_AT_1124
        self.assertEqual([game_opcodes.version(t) for t in (game_opcodes.UPDATE_AT - 1, at - 1, at + 1)], [0, 1, 3])
        self.assertEqual(game_opcodes.normalize(message(0x5F2, b'k')), message(0x5F5, b'k'))   # live: the latest

    def test_recordings_renumbered_with_the_11_18_map_after_11_24_are_redone(self):
        from grind_frames import recorded_index
        at = game_opcodes.UPDATE_AT_1124
        # A collector from before this release saw the new key table 0x5F2 and wrote the
        # 11-18 map's 0x5F4; the old key table position 0x5F3 became 0x5F5.
        stale = dict(t=at + 60, s='a', n=1, h=message(0x5F4).hex())
        self.assertEqual(server_payload(stale)[:2], struct.pack('<H', 0x5F5))
        moved = dict(stale, h=message(0x5F5).hex())     # the game's 0x5F3: not the key table now
        self.assertEqual(server_payload(moved)[:2], struct.pack('<H', 0x5F6))
        unknown = dict(stale, h=message(game_opcodes.UNKNOWN | 0x46C).hex())   # 11-18: between blocks
        self.assertEqual(server_payload(unknown)[:2], struct.pack('<H', 0x471))
        self.assertEqual(server_payload(dict(stale, n=3))[:2], struct.pack('<H', 0x5F4))   # this release's
        self.assertEqual(server_payload(dict(stale, t=at - 60))[:2], struct.pack('<H', 0x5F4))   # the 11-18 game
        plain = dict(t=at + 60, s='a', h=message(0x5F2).hex())   # unmarked: what the game sent
        self.assertEqual(server_payload(plain)[:2], struct.pack('<H', 0x5F5))
        client = dict(t=at + 60, s='a', c=1, n=1, i=game_opcodes.client_index(831, 1), h='00')
        self.assertEqual(recorded_index(client), 833)   # the game sent 831
        self.assertEqual(recorded_index(dict(client, i=321)), 321)
        self.assertEqual(recorded_index(dict(client, n=3, i=321)), 321)

    def test_mobs_recorded_by_v0_8_1_to_v0_8_5_read_as_the_game_sent_them(self):
        at = game_opcodes.UPDATE_AT_1124
        # v0.8.1-v0.8.4 wrote the game's 0x3C4 (a mob appearing) as 0x3CA, its 0x3CF (leaving)
        # as 0x3D5 and its 0x448 (hit) as unmapped; all marked 2. Read: the old 0x3C9/0x3D4/0x44D.
        early = dict(t=at + 60, s='a', n=2)
        for written, old in ((0x3CA, 0x3C9), (0x3D5, 0x3D4), (game_opcodes.UNKNOWN | 0x448, 0x44D)):
            self.assertEqual(server_payload(dict(early, h=message(written).hex()))[:2], struct.pack('<H', old), hex(written))
        # v0.8.5 wrote the corrected map's numbers, also marked 2: as written.
        late = dict(early, t=game_opcodes.FIXED_AT_1124 + 60)
        for old in (0x3C9, 0x3D4, 0x44D, 0x5F5):
            self.assertEqual(server_payload(dict(late, h=message(old).hex()))[:2], struct.pack('<H', old), hex(old))
        self.assertEqual(server_payload(dict(early, h=message(0x5F5).hex()))[:2], struct.pack('<H', 0x5F5))   # same elsewhere

if __name__ == '__main__':
    unittest.main()
