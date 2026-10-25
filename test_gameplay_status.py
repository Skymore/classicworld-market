import unittest
from types import SimpleNamespace

from gameplay_status import RecordingProgress, format_duration
from record_gameplay import Recorder


class StatusTests(unittest.TestCase):
    def test_elapsed_excludes_waiting_and_pauses_and_freezes_at_stop(self):
        now = [1_000_000_000]
        progress = RecordingProgress(lambda: now[0])
        now[0] += 8_000_000_000  # waiting for game
        self.assertEqual(progress.snapshot()["duration"], "00:00")
        progress.sample(now[0])
        for _ in range(40):
            now[0] += 50_000_000
            progress.sample(now[0])
        self.assertEqual(progress.snapshot()["fps"], 20)
        progress.pause()
        now[0] += 30_000_000_000
        self.assertEqual(progress.snapshot()["duration"], "00:02")
        self.assertEqual(progress.snapshot()["fps"], 0)
        progress.sample(now[0])
        now[0] += 3_000_000_000
        progress.pause()
        now[0] += 99_000_000_000
        self.assertEqual(progress.snapshot()["duration"], "00:05")

    def test_stalled_samples_do_not_keep_showing_twenty_hz(self):
        now = [1_000_000_000]
        progress = RecordingProgress(lambda: now[0])
        progress.sample(now[0] - 50_000_000)
        progress.sample(now[0])
        self.assertEqual(progress.snapshot()["fps"], 20)
        now[0] += 600_000_000
        self.assertEqual(progress.snapshot()["fps"], 0)
        self.assertEqual(format_duration(3661), "01:01:01")

    def test_pause_saving_and_error_override_old_recording_label(self):
        recorder = Recorder(dict(hwnd=1), ".", ["space"])
        recorder.session = SimpleNamespace(timeline=SimpleNamespace(active=True, gate=lambda *args: None), closed=False)
        recorder.status = "录制中"
        self.assertEqual(recorder.display_status()["state"], "recording")
        recorder.control("pause")
        self.assertEqual(recorder.display_status()["state"], "paused")
        recorder.control("stop")
        self.assertEqual(recorder.display_status()["state"], "saving")
        recorder.error = "write failed"
        recorder.finished.set()
        self.assertEqual(recorder.display_status()["state"], "error")


if __name__ == "__main__":
    unittest.main()
