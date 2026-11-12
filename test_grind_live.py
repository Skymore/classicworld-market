"""Layouts verified on a live session (grind_protocol.verified_profile), with
synthetic frames: no recorded game traffic or real character data."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

import grind_protocol as proto
from classicworld_codec import advance, aes_payload, frame_header
from grind_desktop import GrindService, parse_hotkey
from grind_pricing import Prices
from grind_tracker import Tracker
from market_passive import ClientDecoder

ME, OTHER = 424242, 515151


def snapshot(level=30, job=310, exp=5000, name=b'Tester', map_id=10004080):
    data = bytearray(600)
    struct.pack_into('<H', data, 0, 0x1A9)
    struct.pack_into('<I', data, 10, 2)
    data[14:24] = bytes.fromhex('00000000000100000000')
    struct.pack_into('<II', data, 158, ME, ME)
    data[170:170+len(name)] = name
    data[197] = level
    struct.pack_into('<H', data, 201, job)
    struct.pack_into('<4H', data, 203, 4, 120, 4, 4)
    struct.pack_into('<4I', data, 211, 500, 800, 100, 300)
    data[229] = 1
    struct.pack_into('<BI', data, 230, 0, 5)
    struct.pack_into('<Q', data, 235, exp)
    struct.pack_into('<I', data, 247, map_id)
    return bytes(data)


def stat(**fields):
    bits = dict(hp=(10, 4), exp=(16, 8), mesos=(18, 8))
    chosen = sorted((bits[k][0], bits[k][1], v) for k, v in fields.items())
    mask = sum(1 << b for b, _, _ in chosen)
    body = b''.join(v.to_bytes(n, 'little') for _, n, v in chosen)
    return b'\x7e\x00\x00\x00\x01' + struct.pack('<I', mask) + body + b'\x00\x00'


def spawn(oid, mob):
    return b'\xc9\x03\x00' + struct.pack('<IBI', oid, 1, mob) + bytes(300)


def hit(oid, who):
    return struct.pack('<HIIH', 0x44D, oid, who, 310) + bytes(2)


def died(oid, kind=1):
    return struct.pack('<HIB', 0x3D4, oid, kind) + bytes(9)


def exp_message(gain):
    return b'\x8b\x00\x03\x01' + struct.pack('<I', gain) + bytes(13)


def item_message(item, quantity=1):
    return b'\x8b\x00\x00\x01\x00' + struct.pack('<IH', item, quantity) + bytes(3)


def buff(source, milliseconds):
    data = bytearray(160)
    struct.pack_into('<H', data, 0, 0x7F)
    data[17] = 4
    struct.pack_into('<IiI', data, 126, abs(source), source, milliseconds)
    return bytes(data)


class Clock:
    t = 1_800_000_000.0

    def __call__(self):
        return self.t


class LiveLayoutTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        folder = Path(self.dir.name)
        (folder / 'grind').mkdir()
        (folder / 'grind' / 'settings.json').write_text(json.dumps(dict(record_frames=False)), encoding='utf-8')
        self.clock = Clock()
        prices = Prices()
        prices.mobs = {22: dict(name='野猪')}
        self.tracker = Tracker(folder, prices, now=self.clock)
        self.inv = type('Inv', (), dict(session=None, slots=None, mesos=None, equipment=None, worn=None))()
        self.exp = 5000
        self.send(snapshot(exp=self.exp))

    def tearDown(self):
        self.dir.cleanup()

    def send(self, data, after=0.0):
        self.clock.t += after
        self.tracker.observe('s', data, self.inv)

    def kill(self, oid, mob=22, gain=40, who=ME):
        self.send(spawn(oid, mob), 1)
        self.send(hit(oid, who), 1)
        self.send(died(oid), 0.1)
        if who == ME:
            self.exp += gain
            self.send(exp_message(gain), 0.05)
            self.send(stat(exp=self.exp), 0.01)

    def character(self):
        return self.tracker.characters['s']

    def test_snapshot_layout_reads_level_job_and_id(self):
        character = self.character()
        self.assertEqual((character.name, character.level, character.job, character.character_id, character.exp),
                         ('Tester', 30, 310, ME, 5000))

    def test_only_own_kills_count_and_split_by_mob(self):
        for oid in range(1, 6):
            self.kill(oid)
        self.kill(99, who=OTHER)           # another player's kill
        self.send(spawn(100, 22), 1)
        self.send(died(100, kind=0), 1)    # left view, not killed
        summary = self.tracker.summarize(self.character().run, self.clock(), self.character())
        self.assertEqual(summary['kills'], 5)
        self.assertFalse(summary['kills_estimated'])
        self.assertEqual(summary['mobs'], [dict(mob_id=22, kills=5, name='野猪')])
        self.assertEqual(summary['exp'], 5 * 40)

    def test_drop_after_an_experience_message_is_a_level_up(self):
        for oid in range(1, 5):
            self.kill(oid)
        need = 34320  # level 30 -> 31
        self.exp = need - 10
        self.send(exp_message(need - 10 - 5160), 1)
        self.send(stat(exp=self.exp), 0.01)
        self.send(exp_message(50), 1)
        self.send(stat(exp=40), 0.01)       # level-up: 10 to finish 30, 40 into 31
        run = self.character().run
        self.assertEqual(self.character().level, 31)
        self.assertEqual(run.deaths, 0)
        self.send(stat(exp=20), 1)          # no message: a death
        self.assertEqual((run.deaths, run.exp_lost), (1, 20))

    def test_item_messages_attribute_pickups_and_buffs_count_down(self):
        self.send(item_message(4000021))
        self.assertEqual(list(self.character().pickups)[-1][1], 4000021)
        self.send(buff(3101003, 228000))
        self.send(buff(-2002004, 600000))
        self.clock.t += 28
        buffs = self.tracker.buffs(self.character(), self.clock())
        self.assertEqual([(b['source'], round(b['seconds'])) for b in buffs], [(3101003, 200), (-2002004, 572)])
        self.assertEqual(buffs[0]['name'], '无形箭')

    def test_buff_value_equal_to_the_source_is_skipped(self):
        self.assertEqual(proto.parse_buff(buff(3101000, 60000), proto.verified_profile()['buff']), (3101000, 60000))

    def test_manual_pause_holds_until_resume_and_end_closes(self):
        for oid in range(1, 5):
            self.kill(oid)
        run = self.character().run
        data = self.tracker.data

        def order(action, ident):
            (data / 'command.json').write_text(json.dumps(dict(id=ident, action=action, at=self.clock())), encoding='utf-8')
            import os
            os.utime(data / 'command.json', (self.clock(), self.clock() + ident.__hash__() % 1000))
            self.tracker.tick()
        order('pause', 'a')
        self.assertEqual((run.status, run.pause_reason), ('paused', 'manual'))
        for oid in range(10, 15):
            self.kill(oid)
        self.assertEqual(run.status, 'paused')
        order('resume', 'b')
        self.assertEqual(run.status, 'active')
        order('end', 'c')
        self.assertIsNone(self.character().run)
        self.assertEqual(self.tracker.finished[0]['id'], run.id)


class ClientDecoderTest(unittest.TestCase):
    def test_reads_aes_frames_under_the_greeting_client_iv(self):
        iv, seen = bytes.fromhex('01020304'), []
        wire, current = b'', iv
        for plain in (b'\x10\x00attack', b'\x22\x00skill!'):
            wire += frame_header(len(plain), current, True) + aes_payload(plain, current)
            current = advance(current)
        decoder = ClientDecoder(iv, seen.append)
        decoder.feed(wire[:5])
        decoder.feed(wire[5:])
        self.assertEqual(seen, [b'\x10\x00attack', b'\x22\x00skill!'])
        with self.assertRaises(ValueError):
            ClientDecoder(iv, seen.append).feed(b'\x00\x00\x05\x00junk!')


class HotkeyTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_hotkey('Ctrl+Alt+O'), (3, ord('O')))
        self.assertEqual(parse_hotkey('F9'), (0, 0x78))
        self.assertIsNone(parse_hotkey('O'))          # bare letters fire while typing
        self.assertIsNone(parse_hotkey('Ctrl+Space'))
        self.assertIsNone(parse_hotkey(''))

    def test_commands_and_hotkey_settings_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            service = GrindService(folder)
            saved = service.save_settings(dict(hotkeys=dict(pause='Ctrl+Shift+P', bogus='x')))
            self.assertEqual(saved['hotkeys']['pause'], 'Ctrl+Shift+P')
            self.assertNotIn('bogus', saved['hotkeys'])
            service.command('toggle')
            order = json.loads((Path(folder) / 'grind' / 'command.json').read_text(encoding='utf-8'))
            self.assertEqual(order['action'], 'toggle')
            with self.assertRaises(ValueError):
                service.command('format-disk')


if __name__ == '__main__':
    unittest.main()
