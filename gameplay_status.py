"""Live recorder timing, independent of the UI and video encoder."""
from collections import deque
import threading
import time


def format_duration(seconds):
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


class RecordingProgress:
    def __init__(self, clock=time.perf_counter_ns):
        self.clock = clock
        self.lock = threading.Lock()
        self.started_ns = None
        self.total_ns = 0
        self.samples = deque(maxlen=40)

    def sample(self, now_ns):
        with self.lock:
            if self.started_ns is None:
                self.started_ns = now_ns
            self.samples.append(now_ns)

    def pause(self):
        with self.lock:
            if self.started_ns is not None:
                self.total_ns += max(0, self.clock() - self.started_ns)
                self.started_ns = None
            self.samples.clear()

    def snapshot(self):
        with self.lock:
            now = self.clock()
            elapsed_ns = self.total_ns + (max(0, now - self.started_ns) if self.started_ns is not None else 0)
            fps = 0.0
            if len(self.samples) > 1 and now - self.samples[-1] < 500_000_000:
                span = self.samples[-1] - self.samples[0]
                if span > 0:
                    fps = (len(self.samples) - 1) * 1e9 / span
            return dict(fps=fps, elapsed_seconds=elapsed_ns / 1e9, duration=format_duration(elapsed_ns / 1e9))
