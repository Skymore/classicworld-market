import os
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from gameplay_windows import DXcamSource, KeyboardObserver, WindowTarget, enable_dpi_awareness
from gameplay_recording import InputTimeline, validate_session
from record_gameplay import Recorder


class CaptureAdapterTests(unittest.TestCase):
    def test_stop_serializes_with_focus_gate_and_prevents_late_keys(self):
        entered, release = threading.Event(), threading.Event()
        rows = []
        recorder = Recorder(dict(hwnd=1), ".", ["space"])
        recorder.session = SimpleNamespace(timeline=InputTimeline(["space"], rows.append), closed=False)

        def focused():
            entered.set()
            release.wait(2)
            return True

        target = SimpleNamespace(focused=focused, held=lambda: [])
        gate_thread = threading.Thread(target=recorder._gate, args=(target,))
        gate_thread.start()
        self.assertTrue(entered.wait(1))
        stop_thread = threading.Thread(target=recorder.control, args=("stop",))
        stop_thread.start()
        release.set()
        gate_thread.join(2)
        stop_thread.join(2)
        self.assertFalse(gate_thread.is_alive())
        self.assertFalse(stop_thread.is_alive())
        recorder._on_key(target, "space", True)
        self.assertFalse(recorder.session.timeline.active)
        self.assertFalse(any(row["type"] == "key" for row in rows))

    def test_negative_monitor_origin_and_owned_frames(self):
        cameras = []

        class Camera:
            def __init__(self):
                self.stopped = threading.Event()
                self.released = False
                self.options = None

            def start(self, **kwargs):
                self.options = kwargs

            def get_latest_frame(self, **kwargs):
                self.stopped.wait(.005)
                if self.stopped.is_set():
                    return None
                return np.ones((40, 60, 3), dtype=np.uint8), time.perf_counter()

            def stop(self):
                self.stopped.set()

            def release(self):
                self.released = True

        def create(**kwargs):
            camera = Camera()
            cameras.append((camera, kwargs))
            return camera

        output = SimpleNamespace(update_desc=lambda: None, desc=SimpleNamespace(
            DesktopCoordinates=SimpleNamespace(left=-1920, top=0, right=0, bottom=1080)))
        module = SimpleNamespace(create=create, __factory=SimpleNamespace(outputs=[[output]]))
        source = DXcamSource()
        with patch.dict("sys.modules", dxcam=module):
            try:
                source.configure((-1800, 100, -1740, 140))
                deadline = time.monotonic() + 2
                while source.read() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                first = source.read()
                self.assertIsNotNone(first)
                self.assertEqual(cameras[0][0].options["region"], (120, 100, 180, 140))
                source.configure((-1700, 100, -1640, 140))
                self.assertTrue(cameras[0][0].released)
                self.assertEqual(cameras[1][0].options["region"], (220, 100, 280, 140))
                self.assertTrue(np.all(first[0] == 1))
            finally:
                source.close()
        self.assertIsNone(source.read())
        self.assertTrue(cameras[-1][0].released)

    def test_recorder_routes_generated_stream_through_real_video_writer(self):
        class Target:
            def __init__(self, hwnd, keys):
                pass

            def exists(self):
                return True

            def focused(self):
                return True

            def held(self):
                return []

            def bounds(self):
                return (0, 0, 80, 60)

        class Source:
            failure = None

            def configure(self, bounds):
                pass

            def read(self):
                now = time.perf_counter_ns()
                return np.zeros((60, 80, 3), dtype=np.uint8), now - 1_000_000, now, 1

            def close(self):
                pass

        class Observer:
            failure = None

            def __init__(self, *args):
                self.control = args[2]

            def start(self):
                if fail_on_start:
                    self.failure = "Keyboard callback failed: test error"
                    self.control("stop")

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as directory, \
                patch("record_gameplay.WindowTarget", Target), \
                patch("record_gameplay.DXcamSource", Source), \
                patch("record_gameplay.KeyboardObserver", Observer):
            for fail_on_start in (False, True):
                with self.subTest(keyboard_failure=fail_on_start):
                    recorder = Recorder(dict(hwnd=1), directory, ["space"], duration=.3)
                    recorder.run()
                    self.assertTrue(recorder.finished.is_set())
                    if fail_on_start:
                        self.assertIn("Keyboard callback failed", recorder.error)
                        self.assertFalse(validate_session(recorder.session.directory)["ok"])
                    else:
                        self.assertIsNone(recorder.error)
                        report = validate_session(recorder.session.directory)
                        self.assertTrue(report["ok"], report)
                        self.assertGreaterEqual(report["frames"], 4)


@unittest.skipUnless(os.name == "nt" and os.environ.get("GAMEPLAY_NATIVE_SMOKE") == "1",
                     "Opt-in Windows hook smoke test")
class NativeHookTests(unittest.TestCase):
    def test_hook_installs_and_uninstalls_without_recording_any_keys(self):
        target = WindowTarget(0, [])
        observer = KeyboardObserver(target, lambda *a, **kw: None, lambda action: None)
        try:
            observer.start()
            self.assertTrue(observer.thread.is_alive())
            self.assertIsNone(observer.failure)
        finally:
            observer.close()
        self.assertFalse(observer.thread.is_alive())


@unittest.skipUnless(os.name == "nt" and os.environ.get("GAMEPLAY_SCREEN_SMOKE") == "1",
                     "Opt-in capture of a visible generated test window")
class NativeScreenTests(unittest.TestCase):
    def test_live_recorder_overlay_pause_resume_and_save(self):
        import tkinter as tk
        from gameplay_overlay import StatusOverlay
        enable_dpi_awareness()
        root = tk.Tk()
        root.title("录制流程自检（自动关闭）")
        root.geometry("640x280+80+100")
        root.configure(bg="#204080")
        root.attributes("-topmost", True)
        root.update()
        overlay = StatusOverlay(root)
        native = overlay.native
        hwnd = native.user.GetAncestor(root.winfo_id(), 2)
        bounds = WindowTarget(hwnd, []).bounds()
        recorder = None
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)

        def pump(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                root.update()
                overlay.update(recorder.display_status(), bounds)
                time.sleep(.02)

        try:
            # Do not take focus from the user: only this scope check is simulated.
            # Screenshot, hook lifecycle, encoding and overlay are real Windows APIs.
            with patch.object(WindowTarget, "focused", return_value=True):
                recorder = Recorder(dict(hwnd=hwnd), temporary.name, [])  # no gameplay keys observed
                recorder.start()
                pump(1.2)
                self.assertEqual(recorder.display_status()["state"], "recording", recorder.error)
                self.assertGreater(recorder.actual_fps(), 10)
                recorder.control("pause")
                elapsed = recorder.progress.snapshot()["elapsed_seconds"]
                pump(.4)
                self.assertEqual(recorder.progress.snapshot()["elapsed_seconds"], elapsed)
                self.assertEqual(recorder.display_status()["state"], "paused")
                recorder.control("pause")
                pump(.8)
                recorder.control("stop")
                deadline = time.monotonic() + 10
                while not recorder.finished.is_set() and time.monotonic() < deadline:
                    pump(.05)
                self.assertTrue(recorder.finished.is_set())
                self.assertIsNone(recorder.error)
                self.assertEqual(recorder.display_status()["state"], "saved")
                report = validate_session(recorder.session.directory)
                self.assertTrue(report["ok"], report)
                self.assertGreater(report["frames"], 15)
                self.assertEqual(report["key_events"], 0)
        finally:
            if recorder and not recorder.finished.is_set():
                recorder.control("stop")
                recorder.finished.wait(10)
            overlay.close()
            root.destroy()

    def test_capture_generated_window_with_real_dxgi_timestamps(self):
        import tkinter as tk
        enable_dpi_awareness()
        root = tk.Tk()
        root.title("录制器画面自检（自动关闭）")
        root.geometry("400x240+100+100")
        root.configure(bg="#204080")
        root.attributes("-topmost", True)
        root.update()
        target = WindowTarget(root.winfo_id(), [])
        source = DXcamSource()
        received = []
        try:
            source.configure(target.bounds())
            deadline = time.monotonic() + 3
            while len(received) < 30 and time.monotonic() < deadline:
                root.update()
                frame = source.read()
                if frame is not None:
                    image, presented, arrived, source_id = frame
                    self.assertTrue(0 < presented <= arrived + 100_000_000)
                    # Only our solid-color client area is captured, with no input hook.
                    self.assertTrue(np.allclose(image[120, 200], [128, 64, 32], atol=5), image[120, 200])
                    received.append(source_id)
                time.sleep(.05)
            self.assertEqual(len(received), 30)
            self.assertGreater(len(set(received)), 20)
        finally:
            source.close()
            root.destroy()


if __name__ == "__main__":
    unittest.main()
