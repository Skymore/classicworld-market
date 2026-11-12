import json
import tempfile
import unittest
from pathlib import Path

from grind_desktop import GrindService, merge_profiles
from grind_frames import FrameLog, read_frames
from grind_protocol import default_profile


class MergeTest(unittest.TestCase):
    def test_confirmed_sections_are_never_replaced_by_unconfirmed_results(self):
        current = default_profile()
        current['snapshot'] = dict(confirmed=True, level=['pre', 200], exp=[['post', 235], 8])
        learned = default_profile()
        learned['snapshot'] = dict(confirmed=True, level=['pre', 200])
        learned['kill'] = dict(confirmed=True, opcode=0x202, length=7, offset=2)
        merged = merge_profiles(current, learned)
        self.assertEqual(merged['snapshot']['exp'], [['post', 235], 8])
        self.assertTrue(merged['kill']['confirmed'])
        learned['kill'] = dict(confirmed=False)
        self.assertTrue(merge_profiles(merged, learned)['kill']['confirmed'])


class FrameLogTest(unittest.TestCase):
    def test_round_trip_keeps_all_frames_and_holds_no_open_file(self):
        with tempfile.TemporaryDirectory() as folder:
            log = FrameLog(Path(folder) / 'frames')
            log.write('abc', b'\x7e\x00\x01', now=10)
            log.write('abc', (0x578).to_bytes(2, 'little') + b'x', now=11)
            log.flush()
            files = list((Path(folder) / 'frames').glob('frames_*.jsonl'))
            self.assertEqual([(t, s, d) for t, s, d in read_frames(files)], [(10, 'abc', b'\x7e\x00\x01'), (11, 'abc', b'\x78\x05x')])

    def test_retains_seven_days_without_size_eviction(self):
        import os
        from grind_frames import RETENTION_SECONDS
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old, recent = root/'frames_old.jsonl', root/'frames_recent.jsonl'
            old.write_text('old'); recent.write_text('recent')
            os.utime(old, (1, 1)); os.utime(recent, (RETENTION_SECONDS, RETENTION_SECONDS))
            FrameLog(root).prune(RETENTION_SECONDS + 2)
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())


class ServiceTest(unittest.TestCase):
    def test_settings_round_trip_and_reject_unknown_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            service = GrindService(folder)
            saved = service.save_settings(dict(idle_seconds=120, overlay=dict(layout='compact', bogus=1), bogus=2))
            self.assertEqual(saved['idle_seconds'], 120)
            self.assertEqual(saved['overlay']['layout'], 'compact')
            on_disk = json.loads((Path(folder) / 'grind' / 'settings.json').read_text(encoding='utf-8'))
            self.assertNotIn('bogus', on_disk)
            self.assertNotIn('bogus', on_disk['overlay'])
            self.assertIsNone(service.live())
            self.assertEqual(service.history(), [])

    def test_overlay_is_dragged_and_sized_directly(self):
        with tempfile.TemporaryDirectory() as folder:
            service = GrindService(folder)
            settings = service.settings()
            self.assertNotIn('click_through', settings['overlay'])
            self.assertNotIn('edit', settings['hotkeys'])
            self.assertEqual(service.scale_overlay(1.234), 1.23)
            self.assertEqual(service.scale_overlay(9), 2.0)
            self.assertEqual(service.scale_overlay(0.1), 0.6)
            with self.assertRaises(ValueError):
                service.scale_overlay('big')
            base = service.overlay_size(dict(settings['overlay'], scale=1.0))
            self.assertEqual(service.overlay_size(dict(settings['overlay'], scale=2.0)), (base[0] * 2, base[1] * 2))

            class Window:
                x, y = 321, 45
            service.overlay = Window()
            service.save_overlay_position()
            self.assertEqual((service.settings()['overlay']['x'], service.settings()['overlay']['y']), (321, 45))
            Window.x = -32000
            service.save_overlay_position()
            self.assertEqual(service.settings()['overlay']['x'], 321)
            service.overlay = None
            self.assertEqual(service.fit_overlay(187.4), 187)
            self.assertEqual(service.overlay_size(dict(settings['overlay'], layout='slim', scale=1.5)), (390, 187))
            self.assertEqual(service.fit_overlay(5), 24)
            with self.assertRaises(ValueError):
                service.fit_overlay(None)

    def test_overlay_stays_off_the_taskbar(self):
        from grind_desktop import WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, overlay_styles
        styles = overlay_styles(WS_EX_APPWINDOW | 0x8)
        self.assertFalse(styles & WS_EX_APPWINDOW)
        self.assertTrue(styles & WS_EX_TOOLWINDOW and styles & WS_EX_NOACTIVATE and styles & 0x8)
        self.assertFalse(styles & 0x20, 'the overlay takes the mouse so it can be dragged')


if __name__ == '__main__':
    unittest.main()
