"""Timestamped demonstration storage. No desktop access or input injection here."""
from __future__ import annotations

import bisect
import json
import queue
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
DEFAULT_KEYS = "left,right,up,down,space,ctrl,alt,shift,z,x,c,a,s,d,f,q,w,e,r,1,2,3,4,5,6"


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


class Cadence:
    """Absolute deadlines; an overrun skips ticks instead of creating a burst."""
    def __init__(self, fps, now_ns):
        if not 1 <= fps <= 60:
            raise ValueError("FPS must be between 1 and 60")
        self.period_ns = round(1_000_000_000 / fps)
        self.deadline_ns = now_ns

    def advance(self, now_ns):
        self.deadline_ns += self.period_ns
        skipped = 0
        if self.deadline_ns <= now_ns:
            skipped = (now_ns - self.deadline_ns) // self.period_ns + 1
            self.deadline_ns += skipped * self.period_ns
        return skipped


class InputTimeline:
    """Thread-safe, bounded recent history plus an append-only event stream.

    Callbacks must enqueue, not perform disk IO. A frame can look up the state
    at its sampling time even when the next keyboard callback has already run.
    """
    def __init__(self, keys, emit, clock=time.perf_counter_ns, origin_ns=None):
        self.keys = frozenset(keys)
        self.emit = emit
        self.clock = clock
        self.origin_ns = clock() if origin_ns is None else origin_ns
        self.lock = threading.RLock()
        self.active = False
        self.reason = "waiting_for_window"
        self.episode = 0
        self.held = set()
        self.seq = 0
        self.history = deque([(0, 0, (), False, 0)], maxlen=4096)

    def _emit(self, kind, **fields):
        now = max(self.history[-1][0], self.clock() - self.origin_ns)
        self.seq += 1
        row = dict(seq=self.seq, t_ns=now, type=kind, episode=self.episode, **fields)
        self.emit(row)
        self.history.append((now, self.seq, tuple(sorted(self.held)), self.active, self.episode))
        return row

    def gate(self, active, reason, held=()):
        with self.lock:
            if self.active == active and self.reason == reason:
                return
            self.active = bool(active)
            self.reason = reason
            self.held = set(held) & self.keys if active else set()
            if active:
                self.episode += 1
            self._emit("gate", active=self.active, reason=reason, held=sorted(self.held))

    def key(self, name, down, *, injected=False, native_time_ms=None, scan_code=None):
        with self.lock:
            if not self.active or name not in self.keys or injected:
                return False
            if (name in self.held) == down:  # suppress OS repeat key-downs
                return False
            if down:
                self.held.add(name)
            else:
                self.held.discard(name)
            self._emit("key", key=name, down=bool(down), native_time_ms=native_time_ms,
                       scan_code=scan_code)
            return True

    def snapshot(self, t_ns):
        with self.lock:
            rows = list(self.history)
            index = bisect.bisect_right([row[0] for row in rows], t_ns) - 1
            if index < 0:
                raise ValueError("Frame predates retained input history")
            _, seq, held, active, episode = rows[index]
            return dict(input_seq=seq, held=list(held), active=active, episode=episode)


class OpenCVSegments:
    """Short, independently finalized MP4 files; odd dimensions are padded."""
    def __init__(self, directory, fps, segment_seconds):
        import cv2
        self.cv2 = cv2
        self.directory = Path(directory)
        self.fps = fps
        self.limit = max(1, round(fps * segment_seconds))
        self.writer = None
        self.shape = None
        self.index = -1
        self.frame_index = 0
        self.segments = []

    def write(self, image, row):
        import numpy as np
        if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("Expected a uint8 BGR image")
        h, w = image.shape[:2]
        shape = (w + w % 2, h + h % 2)
        if self.writer is None or self.shape != shape or self.frame_index >= self.limit:
            self._finish()
            self.index += 1
            self.shape = shape
            self.frame_index = 0
            name = f"video-{self.index:04d}.mp4"
            self.writer = self.cv2.VideoWriter(str(self.directory / name),
                                              self.cv2.VideoWriter_fourcc(*"mp4v"),
                                              self.fps, shape)
            if not self.writer.isOpened():
                self.writer.release()
                self.writer = None
                raise RuntimeError("MP4 encoder could not be opened")
            self.segments.append(dict(file=name, width=shape[0], height=shape[1],
                                      frames=0, finalized=False))
        if shape != (w, h):
            image = self.cv2.copyMakeBorder(image, 0, h % 2, 0, w % 2,
                                           self.cv2.BORDER_CONSTANT, value=(0, 0, 0))
        self.writer.write(image)
        result = dict(video=self.segments[-1]["file"], video_frame=self.frame_index,
                      content_size=[w, h])
        self.frame_index += 1
        self.segments[-1]["frames"] = self.frame_index
        return result

    def _finish(self):
        if self.writer is not None:
            self.writer.release()
            self.writer = None
            self.segments[-1]["finalized"] = True

    def close(self):
        self._finish()


class RecordingSession:
    def __init__(self, output_root, *, fps=20, keys=(), metadata=None,
                 segment_seconds=60, frame_queue_size=8, event_queue_size=8192,
                 sink_factory=OpenCVSegments, clock=time.perf_counter_ns):
        Cadence(fps, 0)
        if segment_seconds <= 0 or frame_queue_size < 1 or event_queue_size < 1:
            raise ValueError("Segment duration and queue sizes must be positive")
        self.clock = clock
        self.origin_ns = clock()
        self.started_utc = datetime.now(timezone.utc).isoformat()
        name = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
        self.directory = Path(output_root) / name
        self.directory.mkdir(parents=True, exist_ok=False)
        self.fps = fps
        self.keys = sorted(set(keys))
        self.metadata = metadata or {}
        self.segment_seconds = segment_seconds
        self.frame_queue = queue.Queue(maxsize=frame_queue_size)
        self.event_queue = queue.Queue(maxsize=event_queue_size)
        self.done = threading.Event()
        self.failure = None
        self.closed = False
        self.counts = dict(sampled=0, written=0, dropped=0, events=0, skipped_ticks=0)
        self.capture_ms = deque(maxlen=20000)
        self.write_ms = deque(maxlen=20000)
        self.sink = None
        self.sink_factory = sink_factory
        self.timeline = InputTimeline(self.keys, self.event, clock, self.origin_ns)
        atomic_json(self.directory / "session.json", self.manifest("recording"))
        self.thread = threading.Thread(target=self._write_loop, name="demo-writer", daemon=True)
        self.thread.start()

    def event(self, row):
        if self.failure:
            return
        try:
            self.event_queue.put_nowait(row)
        except queue.Full:
            self.failure = "Keyboard/event queue overflow; recording stopped to preserve alignment"
            self.done.set()

    def diagnostic(self, kind, **fields):
        self.event(dict(type=kind, t_ns=self.clock() - self.origin_ns, **fields))

    def frame(self, image, *, sample_ns, read_begin_ns, read_end_ns,
              source_present_ns=None, source_received_ns=None, source_frame_id=None, bounds=None):
        if self.closed or self.failure:
            return False
        t_ns = sample_ns - self.origin_ns
        state = self.timeline.snapshot(t_ns)
        if not state["active"]:
            return False
        self.counts["sampled"] += 1
        row = dict(frame_id=self.counts["sampled"] - 1, t_ns=t_ns,
                   read_begin_ns=read_begin_ns - self.origin_ns,
                   read_end_ns=read_end_ns - self.origin_ns,
                   source_present_ns=None if source_present_ns is None else source_present_ns - self.origin_ns,
                   source_received_ns=None if source_received_ns is None else source_received_ns - self.origin_ns,
                   source_frame_id=source_frame_id, bounds=bounds, **state)
        self.capture_ms.append((read_end_ns - read_begin_ns) / 1e6)
        try:
            self.frame_queue.put_nowait((image, row))
            return True
        except queue.Full:
            self.counts["dropped"] += 1
            self.diagnostic("frame_dropped", frame_id=row["frame_id"],
                            sample_t_ns=t_ns, reason="encoder_backpressure")
            return False

    def _write_loop(self):
        try:
            self.sink = self.sink_factory(self.directory, self.fps, self.segment_seconds)
            with (self.directory / "frames.jsonl").open("w", encoding="utf-8") as frames, \
                    (self.directory / "events.jsonl").open("w", encoding="utf-8") as events:
                flushed = time.monotonic()
                while not self.done.is_set() or not self.frame_queue.empty() or not self.event_queue.empty():
                    # A bounded batch prevents input activity from starving video.
                    for _ in range(1024):
                        try:
                            event = self.event_queue.get_nowait()
                        except queue.Empty:
                            break
                        events.write(json.dumps(event, ensure_ascii=False) + "\n")
                        self.counts["events"] += 1
                    try:
                        image, row = self.frame_queue.get(timeout=0.02)
                    except queue.Empty:
                        pass
                    else:
                        started = time.perf_counter_ns()
                        row.update(self.sink.write(image, row))
                        row["writer_delay_ms"] = max(0, (self.clock() - self.origin_ns - row["t_ns"]) / 1e6)
                        frames.write(json.dumps(row, ensure_ascii=False) + "\n")
                        self.counts["written"] += 1
                        self.write_ms.append((time.perf_counter_ns() - started) / 1e6)
                    if time.monotonic() - flushed >= 0.5:
                        frames.flush()
                        events.flush()
                        atomic_json(self.directory / "session.json", self.manifest("recording"))
                        flushed = time.monotonic()
        except Exception as exc:
            self.failure = f"{type(exc).__name__}: {exc}"
            self.done.set()
        finally:
            if self.sink is not None:
                try:
                    self.sink.close()
                except Exception as exc:
                    self.failure = self.failure or f"Closing video failed: {exc}"

    def manifest(self, status):
        def timing(values):
            ordered = sorted(values.copy())
            return dict(samples=len(ordered), p50_ms=ordered[len(ordered) // 2] if ordered else None,
                        p95_ms=ordered[min(len(ordered) - 1, int(len(ordered) * .95))] if ordered else None)
        return dict(schema=SCHEMA_VERSION, status=status, started_utc=self.started_utc,
                    clock="time.perf_counter_ns", origin_monotonic_ns=self.origin_ns,
                    duration_ns=self.clock() - self.origin_ns, fps=self.fps, keys=self.keys,
                    metadata=self.metadata, counts=dict(self.counts), error=self.failure,
                    timing=dict(sample_read=timing(self.capture_ms), encode=timing(self.write_ms)),
                    segments=list(getattr(self.sink, "segments", [])),
                    timestamp_note="Relative nanoseconds. t_ns is observation sampling time; source_present_ns is the original DXGI presentation time and can repeat. events key timestamps are hook receipt times. Video uses compact CFR playback; frames.jsonl defines real elapsed time.")

    def close(self, error=None):
        if self.closed:
            return
        self.timeline.gate(False, "stopped")
        self.closed = True
        self.failure = self.failure or error
        self.done.set()
        self.thread.join(timeout=30)
        if self.thread.is_alive():
            self.failure = self.failure or "Video writer did not finish within 30 seconds"
        result = self.manifest("failed" if self.failure else "complete")
        atomic_json(self.directory / "session.json", result)
        return result


def validate_session(directory, *, decode_video=True):
    """Check timing, input reconstruction, segment counts and decodability."""
    directory = Path(directory)
    manifest = json.loads((directory / "session.json").read_text(encoding="utf-8"))
    frames = [json.loads(line) for line in (directory / "frames.jsonl").read_text(encoding="utf-8").splitlines()]
    events = [json.loads(line) for line in (directory / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    errors = []
    if manifest["status"] != "complete":
        errors.append("Session is not complete: " + str(manifest.get("error")))
    if not frames:
        errors.append("No video frames")
    if manifest["counts"]["written"] != len(frames):
        errors.append("Manifest/frame count mismatch")
    inputs = [event for event in events if event["type"] in ("gate", "key")]
    state = set()
    states = {0: (set(), False, 0, 0)}
    active = False
    previous_seq = 0
    previous_event_time = -1
    for event in inputs:
        if event["seq"] != previous_seq + 1 or event["t_ns"] < previous_event_time:
            errors.append("Input event sequence is incomplete or out of order")
        previous_seq, previous_event_time = event["seq"], event["t_ns"]
        if event["type"] == "gate":
            active = event["active"]
            state = set(event["held"])
        else:
            if not active or event["key"] not in manifest["keys"]:
                errors.append("Key event outside configured recording scope")
            if event["down"]:
                state.add(event["key"])
            else:
                state.discard(event["key"])
        states[event["seq"]] = (set(state), active, event["episode"], event["t_ns"])
    input_times = [event["t_ns"] for event in inputs]
    previous = -1
    counts = {}
    for frame in frames:
        if frame["t_ns"] < previous:
            errors.append("Frame timestamps go backwards")
        previous = frame["t_ns"]
        recorded = states.get(frame["input_seq"])
        if recorded is None or recorded[:3] != (set(frame["held"]), True, frame["episode"]) or recorded[3] > frame["t_ns"]:
            errors.append(f"Input alignment mismatch at frame {frame['frame_id']}")
        older = bisect.bisect_left(input_times, frame["t_ns"]) - 1
        if older >= 0 and inputs[older]["seq"] > frame["input_seq"]:
            errors.append(f"Stale input state at frame {frame['frame_id']}")
        expected = counts.get(frame["video"], 0)
        if frame["video_frame"] != expected:
            errors.append("Non-contiguous video index")
        counts[frame["video"]] = expected + 1
    for segment in manifest["segments"]:
        path = directory / segment["file"]
        if not segment["finalized"] or not path.exists() or path.stat().st_size == 0:
            errors.append(f"Unfinished video: {segment['file']}")
            continue
        if counts.get(segment["file"], 0) != segment["frames"]:
            errors.append("Segment/frame count mismatch")
        if decode_video:
            import cv2
            video = cv2.VideoCapture(str(path))
            decoded = 0
            try:
                while True:
                    ok, image = video.read()
                    if not ok:
                        break
                    decoded += 1
                    if image.shape[1::-1] != (segment["width"], segment["height"]):
                        errors.append("Video dimensions mismatch")
            finally:
                video.release()
            if decoded != segment["frames"]:
                errors.append(f"Decoded {decoded} of {segment['frames']} frames in {segment['file']}")
    return dict(ok=not errors, frames=len(frames), key_events=sum(e["type"] == "key" for e in events),
                segments=len(manifest["segments"]), errors=errors)
