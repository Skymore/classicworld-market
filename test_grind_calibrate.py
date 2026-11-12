import struct
import unittest

from grind_calibrate import calibrate, complete, summary
from grind_protocol import read_character

MOB = 1210100


def snapshot(exp, level=25, job=410, name=b'Tester', character_id=12345, map_id=104040000):
    """Synthetic full map entry; the layout mirrors what the calibrator searches."""
    data = bytearray(600)
    struct.pack_into('<H', data, 0, 0x1A6)
    struct.pack_into('<I', data, 10, 2)
    data[14:24] = bytes.fromhex('00000000000100000000')
    struct.pack_into('<I', data, 149, character_id)
    data[153:153+len(name)] = name
    data[200] = level
    struct.pack_into('<H', data, 201, job)
    struct.pack_into('<4H', data, 203, 4, 60, 4, 30)
    struct.pack_into('<4I', data, 211, 500, 800, 100, 300)
    data[229] = 1
    struct.pack_into('<BI', data, 230, 0, 5)
    struct.pack_into('<Q', data, 235, exp)
    struct.pack_into('<I', data, 247, map_id)
    return bytes(data)


def stat(fields):
    sizes = {4: 1, 10: 4, 16: 8}
    mask = sum(1 << b for b in fields)
    body = b''.join(fields[b].to_bytes(sizes[b], 'little') for b in sorted(fields))
    return b'\x7e\x00\x00\x00\x01' + struct.pack('<I', mask) + body + b'\x00\x00'


def stream(session, start, exp, kills=20):
    t = start
    frames = [(t, session, snapshot(exp))]
    for i in range(kills):
        oid = 5000 + i
        t += 1
        frames.append((t, session, struct.pack('<HI', 0x201, oid) + struct.pack('<I', MOB) + bytes(10)))
        t += 3
        frames.append((t, session, struct.pack('<HIB', 0x202, oid, 1)))
        exp += 120
        frames.append((t + 0.05, session, stat({16: exp})))
        if i % 4 == 0:
            frames.append((t + 0.5, session, stat({10: 400 + i})))
    frames.append((t + 1, session, stat({4: 26, 10: 800, 16: 10})))
    return frames


class CalibrateTest(unittest.TestCase):
    def test_learns_stats_snapshot_and_kills_from_unlabelled_frames(self):
        frames = stream('a', 0, 5000) + stream('b', 1000, 30000)
        profile = calibrate(frames)
        self.assertEqual(profile['stat']['sizes'], {'4': 1, '10': 4, '16': 8, '18': 8})
        self.assertEqual(profile['stat']['bits']['exp'], 16)
        snap = profile['snapshot']
        self.assertTrue(snap['confirmed'])
        self.assertEqual(snap['level'], ['pre', 200])
        self.assertEqual(snap['exp'], [['post', 235], 8])
        self.assertEqual(read_character(snapshot(777, level=31, job=411), profile),
                         dict(character_id=12345, level=31, job=411, exp=777, name='Tester'))
        self.assertEqual((profile['kill']['opcode'], profile['kill']['length']), (0x202, 7))
        self.assertEqual((profile['spawn']['opcode'], profile['spawn']['mob_offset']), (0x201, 6))
        # No bag changes in this stream: pickups stay unconfirmed and are said so.
        self.assertFalse(profile['pickup']['confirmed'])
        self.assertFalse(complete(profile))
        self.assertIn(('拾取归属', '刷图时背包增加均计为拾取'), summary(profile))

    def test_too_little_evidence_confirms_nothing(self):
        profile = calibrate(stream('a', 0, 5000, kills=3))
        self.assertFalse(profile['stat']['confirmed'])
        self.assertFalse(profile['kill']['confirmed'])


if __name__ == '__main__':
    unittest.main()
