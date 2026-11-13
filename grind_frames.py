"""Local recording of decrypted server frames for the grind calibrator.

Frames stay on this PC (captures/grind/frames). Each line is
{"t": unix time, "s": connection session, "h": frame hex}; the player's own
messages add "c": 1 and "i", the opcode's index in the connection's mapping
table (the raw client opcode changes per connection). Files rotate at
FILE_LIMIT; only files older than seven days are pruned. Nothing is uploaded.
"""
import json
import math
import time
from pathlib import Path

FILE_LIMIT = 48 * 1024 * 1024
RETENTION_SECONDS = 7 * 24 * 3600


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
        cutoff = (time.time() if now is None else now) - RETENTION_SECONDS
        files = sorted(self.folder.glob('frames_*.jsonl'), key=lambda p: p.stat().st_mtime)
        for old in files:
            if old.stat().st_mtime >= cutoff or old == self.path:
                continue
            old.unlink(missing_ok=True)

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
            lines = Path(path).read_text(encoding='ascii').splitlines()
        except (OSError, UnicodeDecodeError):
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
            lines = Path(path).read_text(encoding='ascii').splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for line in lines:
            try:
                record = json.loads(line)
                if not record.get('c'):
                    yield record['t'], record['s'], bytes.fromhex(record['h'])
            except (ValueError, KeyError, TypeError):
                continue
