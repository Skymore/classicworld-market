"""Local recording of decrypted server frames for the grind calibrator.

Frames stay on this PC (captures/grind/frames). Each line is
{"t": unix time, "s": connection session, "h": frame hex}; the player's own
messages add "c": 1 and "i", the opcode's index in the connection's mapping
table (the raw client opcode changes per connection). Files rotate at
FILE_LIMIT or hourly; files older than 30 days are pruned. Nothing is uploaded.

A closed file (untouched for COMPRESS_AFTER) is gzipped in the background to
frames_*.jsonl.gz (about 8x smaller, so 30 days fit in roughly a gigabyte).
Every new client version replays these files once (grind_replay, and the open
run through grind_reconcile), so a parser fix also repairs recorded history.
Read them through frame_files / open_frames / frame_lines: a file's name
without ".gz" and its uncompressed byte offsets stay the same after compression.
"""
import gzip
import json
import math
import threading
import time
from pathlib import Path

FILE_LIMIT = 48 * 1024 * 1024
RETENTION_SECONDS = 30 * 24 * 3600
COMPRESS_AFTER = 3600
UNBOUNDED = float('inf')


def frame_name(path):
    """The recording's name, the same before and after compression."""
    name = Path(path).name
    return name[:-3] if name.endswith('.gz') else name


def frame_files(folder):
    """Recordings oldest first, plain or compressed; while a file is being
    compressed both exist, and the plain one is used."""
    folder = Path(folder)
    found = {}
    for path in list(folder.glob('frames_*.jsonl.gz')) + list(folder.glob('frames_*.jsonl')):
        found[frame_name(path)] = path   # plain ones last: they win
    return [found[name] for name in sorted(found)]


def current_path(path):
    """The file as it is now: a plain file listed a moment ago may have been
    compressed since (2026-11-15: a replay failed on exactly that)."""
    path = Path(path)
    if path.name.endswith('.gz') or path.exists():
        return path
    compressed = path.with_name(path.name + '.gz')
    return compressed if compressed.exists() else path


def frame_size(path):
    """Bytes to read: a plain file can still be growing, so take its size now;
    a compressed one is complete."""
    path = current_path(path)
    return UNBOUNDED if path.name.endswith('.gz') else path.stat().st_size


def open_frames(path):
    path = current_path(path)
    return gzip.open(path, 'rb') if path.name.endswith('.gz') else path.open('rb')


def frame_lines(path):
    """All lines of a recording (bytes), plain or compressed."""
    path = current_path(path)
    data = path.read_bytes()
    return (gzip.decompress(data) if path.name.endswith('.gz') else data).splitlines()


def compress(path):
    """frames_x.jsonl -> frames_x.jsonl.gz, then remove the plain file."""
    path = Path(path)
    target = path.with_name(path.name + '.gz')
    part = path.with_name(path.name + '.gz.part')
    try:
        with path.open('rb') as source, gzip.open(part, 'wb', compresslevel=6) as out:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        part.replace(target)
        path.unlink(missing_ok=True)
    except OSError:
        part.unlink(missing_ok=True)


class FrameLog:
    """Buffers lines and appends them on flush; no file stays open between ticks."""
    def __init__(self, folder):
        self.folder = Path(folder)
        self.path = None
        self.size = 0
        self.buffer = []
        self.buffered = 0
        self.failed = False
        self.rotated_at = 0

    def _rotate(self, session, now):
        self.folder.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime('%Y%m%d_%H%M%S', time.localtime(now))
        self.path = self.folder / f'frames_{stamp}_{str(session)[:8]}.jsonl'
        self.size = self.path.stat().st_size if self.path.exists() else 0
        self.rotated_at = now
        self.prune(now)

    def prune(self, now=None):
        now = time.time() if now is None else now
        cutoff = now - RETENTION_SECONDS
        closed = []
        for old in list(self.folder.glob('frames_*.jsonl')) + list(self.folder.glob('frames_*.jsonl.gz')):
            if old == self.path:
                continue
            try:
                modified = old.stat().st_mtime
            except OSError:
                continue
            if modified < cutoff:
                old.unlink(missing_ok=True)
            elif old.name.endswith('.jsonl') and modified < now - COMPRESS_AFTER:
                closed.append(old)
        if closed:
            # Off the capture thread: a 48 MB file takes about half a second.
            threading.Thread(target=lambda: [compress(p) for p in closed], daemon=True,
                             name='grind-frames-compress').start()

    def write(self, session, plain, now=None, index=None, client=False):
        if self.failed or len(plain) < 2:
            return
        now = time.time() if now is None else now
        try:
            if self.path is None or self.size + self.buffered >= FILE_LIMIT or now - self.rotated_at >= 3600:
                self.flush()
                self._rotate(session, now)
        except OSError:
            self.failed = True
            return
        # Rounded down: a time rounded up could pass the handoff cutoff taken a
        # moment later, and the frame would be left out of the replay.
        record = dict(t=math.floor(now * 1000) / 1000, s=str(session), h=plain.hex())
        if client:
            record.update(c=1, i=index)
        line = json.dumps(record) + '\n'
        self.buffer.append(line)
        self.buffered += len(line)
        if self.buffered >= 1024 * 1024:
            self.flush()

    def flush(self):
        if not self.buffer or self.path is None:
            return
        data, self.buffer, self.buffered = ''.join(self.buffer), [], 0
        try:
            with self.path.open('a', encoding='ascii') as out:
                out.write(data)
            self.size += len(data)
        except OSError:
            # Recording is diagnostic; capture and tracking continue without it.
            self.failed = True

    def control(self, action, now):
        """Preserve local pause/end boundaries for a faithful later replay."""
        try:
            if self.path is None:
                self._rotate('control', now)
            line = json.dumps(dict(t=now, a=action)) + '\n'
            self.buffer.append(line)
            self.buffered += len(line)
        except OSError:
            self.failed = True

    def close(self):
        self.flush()


def read_client_frames(paths):
    """(time, session, mapping index, bytes) of the player's own recorded messages."""
    for path in paths:
        try:
            lines = frame_lines(path)
        except (OSError, EOFError, gzip.BadGzipFile):
            continue
        for line in lines:
            try:
                record = json.loads(line)
                if record.get('c'):
                    yield record['t'], record['s'], record.get('i'), bytes.fromhex(record['h'])
            except (ValueError, KeyError, TypeError):
                continue


def read_frames(paths):
    """(time, session, bytes) of recorded server frames, in file then line order."""
    for path in paths:
        try:
            lines = frame_lines(path)
        except (OSError, EOFError, gzip.BadGzipFile):
            continue
        for line in lines:
            try:
                record = json.loads(line)
                if not record.get('c'):
                    yield record['t'], record['s'], bytes.fromhex(record['h'])
            except (ValueError, KeyError, TypeError):
                continue
