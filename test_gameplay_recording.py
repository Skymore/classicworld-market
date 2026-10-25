import json
import tempfile
import threading
import unittest
from pathlib import Path

from gameplay_recording import Cadence, InputTimeline, RecordingSession, validate_session
from gameplay_windows import parse_keys


class Clock:
    def __init__(self):
        self.now = 1_000_000_000

    def __call__(self):
        return self.now

    def advance(self, ms):
        self.now += round(ms * 1e6)


class InputTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.events = []
        self.timeline = InputTimeline(["right", "space", "ctrl"], self.events.append, self.clock)

    def test_subframe_tap_survives_20_hz_sampling(self):
        self.timeline.gate(True, "recording")
        self.clock.advance(10)
        self.timeline.key("space", True)
        self.clock.advance(8)
        self.timeline.key("space", False)
        self.clock.advance(32)
        self.assertEqual(self.timeline.snapshot(50_000_000)["held"], [])
        self.assertEqual([(e["t_ns"], e["down"]) for e in self.events if e["type"] == "key"],
                         [(10_000_000, True), (18_000_000, False)])

    def test_focus_loss_resets_and_resume_syncs_held_state(self):
        self.timeline.gate(True, "recording")
        self.timeline.key("right", True)
        self.clock.advance(20)
        self.timeline.gate(False, "window_unfocused")
        self.assertFalse(self.timeline.key("space", True))
        self.assertEqual(self.timeline.snapshot(20_000_000)["held"], [])
        self.clock.advance(20)
        self.timeline.gate(True, "recording", ["ctrl", "unconfigured"])
        state = self.timeline.snapshot(40_000_000)
        self.assertEqual(state["held"], ["ctrl"])
        self.assertEqual(state["episode"], 2)
        self.timeline.key("ctrl", False)
        self.assertEqual(self.timeline.snapshot(40_000_000)["held"], [])

    def test_snapshot_does_not_label_frame_with_future_key(self):
        self.timeline.gate(True, "recording")
        self.clock.advance(51)
        self.timeline.key("right", True)
        self.assertEqual(self.timeline.snapshot(50_000_000)["held"], [])
        self.assertEqual(self.timeline.snapshot(52_000_000)["held"], ["right"])

    def test_repeat_injected_and_unconfigured_keys_are_ignored(self):
        self.timeline.gate(True, "recording")
        self.assertFalse(self.timeline.key("space", True, injected=True))
        self.assertFalse(self.timeline.key("password", True))
        self.assertTrue(self.timeline.key("space", True))
        self.assertFalse(self.timeline.key("space", True))
        self.assertTrue(self.timeline.key("space", False))
        self.assertFalse(self.timeline.key("space", False))
        self.assertEqual(len([e for e in self.events if e["type"] == "key"]), 2)

    def test_paused_key_releases_do_not_leak_to_next_episode(self):
        self.timeline.gate(True, "recording")
        self.timeline.key("right", True)
        self.timeline.gate(False, "manual_pause")
        self.timeline.key("right", False)
        self.timeline.gate(True, "recording")
        self.assertEqual(self.timeline.snapshot(0)["held"], [])

    def test_key_configuration_rejects_reserved_hotkeys(self):
        self.assertEqual(parse_keys("SPACE, right, right"), ["right", "space"])
        for value in ("", "f8", "f9", "unknown"):
            with self.assertRaises(ValueError):
                parse_keys(value)


class CadenceTests(unittest.TestCase):
    def test_overrun_skips_ticks_without_catchup_burst(self):
        cadence = Cadence(20, 0)
        self.assertEqual(cadence.advance(12_000_000), 0)
        self.assertEqual(cadence.deadline_ns, 50_000_000)
        self.assertEqual(cadence.advance(225_000_000), 3)
        self.assertEqual(cadence.deadline_ns, 250_000_000)


class FakeSink:
    def __init__(self, directory, fps, seconds):
        self.segments = []
        self.count = 0

    def write(self, image, row):
        index = self.count
        self.count += 1
        return dict(video="fake.mp4", video_frame=index, content_size=[10, 10])

    def close(self):
        pass


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.clock = Clock()

    def session(self, **kwargs):
        session = RecordingSession(self.temporary.name, keys=["right", "space"],
                                    clock=self.clock, **kwargs)
        self.addCleanup(session.close)
        return session

    def frame(self, session, image=None):
        return session.frame(image, sample_ns=self.clock(), read_begin_ns=self.clock(),
                             read_end_ns=self.clock())

    def test_backpressure_drops_are_explicit_and_keys_are_retained(self):
        entered, release = threading.Event(), threading.Event()

        class SlowSink(FakeSink):
            def write(self, image, row):
                entered.set()
                release.wait(3)
                return super().write(image, row)

        session = self.session(frame_queue_size=1, sink_factory=SlowSink)
        session.timeline.gate(True, "recording")
        self.assertTrue(self.frame(session))
        self.assertTrue(entered.wait(2))
        try:
            self.clock.advance(50)
            self.assertTrue(self.frame(session))
            session.timeline.key("space", True)
            self.clock.advance(8)
            session.timeline.key("space", False)
            self.clock.advance(42)
            self.assertFalse(self.frame(session))
        finally:
            release.set()
        result = session.close()
        self.assertEqual(result["counts"]["dropped"], 1)
        self.assertEqual(result["counts"]["written"], 2)
        events = [json.loads(line) for line in (session.directory / "events.jsonl").read_text().splitlines()]
        self.assertEqual(sum(e["type"] == "key" for e in events), 2)
        self.assertTrue(any(e["type"] == "frame_dropped" for e in events))

    def test_encoder_failure_is_not_reported_as_success(self):
        class FailingSink(FakeSink):
            def write(self, image, row):
                raise OSError("disk full")
        session = self.session(sink_factory=FailingSink)
        session.timeline.gate(True, "recording")
        self.frame(session)
        result = session.close()
        self.assertEqual(result["status"], "failed")
        self.assertIn("disk full", result["error"])

    def test_event_overflow_stops_instead_of_silently_losing_keys(self):
        entered, release = threading.Event(), threading.Event()

        class SlowSink(FakeSink):
            def write(self, image, row):
                entered.set()
                release.wait(3)
                return super().write(image, row)
        session = self.session(sink_factory=SlowSink, event_queue_size=2)
        session.timeline.gate(True, "recording")
        self.frame(session)
        self.assertTrue(entered.wait(2))
        try:
            for _ in range(5):
                session.timeline.key("space", True)
                session.timeline.key("space", False)
            self.assertIsNotNone(session.failure)
        finally:
            release.set()
        self.assertEqual(session.close()["status"], "failed")

    def test_real_video_rotation_resize_and_input_alignment(self):
        import numpy as np
        session = self.session(segment_seconds=.1)
        session.timeline.gate(True, "recording")
        for index in range(7):
            if index == 1:
                session.timeline.key("right", True)
            if index == 3:
                session.timeline.key("right", False)
            self.clock.advance(50)
            shape = (49, 65, 3) if index < 4 else (80, 100, 3)
            self.assertTrue(self.frame(session, np.full(shape, index * 25, dtype=np.uint8)))
        session.close()
        report = validate_session(session.directory)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["frames"], 7)
        self.assertEqual(report["segments"], 4)
        rows = [json.loads(line) for line in (session.directory / "frames.jsonl").read_text().splitlines()]
        self.assertEqual(rows[0]["content_size"], [65, 49])
        self.assertEqual(rows[1]["held"], ["right"])
        self.assertEqual(rows[3]["held"], [])

    def test_validator_detects_corrupted_action_label(self):
        import numpy as np
        session = self.session()
        session.timeline.gate(True, "recording")
        self.clock.advance(50)
        self.frame(session, np.zeros((20, 20, 3), dtype=np.uint8))
        session.close()
        path = session.directory / "frames.jsonl"
        row = json.loads(path.read_text())
        row["held"] = ["space"]
        path.write_text(json.dumps(row) + "\n")
        self.assertFalse(validate_session(session.directory)["ok"])


if __name__ == "__main__":
    unittest.main()
