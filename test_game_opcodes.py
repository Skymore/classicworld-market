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
            self.assertEqual(game_opcodes.renumber(new), old, hex(new))
        self.assertEqual(game_opcodes.normalize(message(0x1A5, b'abc')), message(0x1A9, b'abc'))

    def test_a_number_between_blocks_is_unknown_never_an_old_message(self):
        # 0x46E is new in the updated game: it must not pass for any old message.
        unknown = game_opcodes.renumber(0x46E)
        self.assertEqual(unknown, game_opcodes.UNKNOWN | 0x46E)
        self.assertNotIn(unknown, game_opcodes.NEW_TO_OLD.values())
        self.assertEqual(len(set(game_opcodes.NEW_TO_OLD.values())), len(game_opcodes.NEW_TO_OLD))   # one-to-one

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
            self.assertEqual(game_opcodes.client_index(new), old, new)
        self.assertEqual(game_opcodes.client_index(200), game_opcodes.UNKNOWN | 200)   # between blocks
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


if __name__ == '__main__':
    unittest.main()
