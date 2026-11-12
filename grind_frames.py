"""Local recording of decrypted server frames for the grind calibrator.

Frames stay on this PC (captures/grind/frames). Each line is
{"t": unix time, "s": connection session, "h": frame hex}. Files rotate at
FILE_LIMIT and the folder is pruned oldest-first beyond TOTAL_LIMIT, so a
long session can never fill the disk. Nothing here is uploaded.
"""
import json
import time
from pathlib import Path

FILE_LIMIT = 48 * 1024 * 1024
TOTAL_LIMIT = 384 * 1024 * 1024
# Market browsing frames are large and say nothing about grinding.
SKIP = {0x578, 0x57B, 0x22A, 0x22B, 0x22D, 0x22E, 0x23A, 0x23D, 0x577, 0x57A}


class FrameLog:
    """Buffers lines and appends them on flush; no file stays open between ticks."""
    def __init__(self, folder):
        self.folder = Path(folder)
        self.path = None
        self.size = 0
        self.buffer = []
        self.buffered = 0
        self.failed = False

    def _rotate(self, session, now):
        self.folder.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime('%Y%m%d_%H%M%S', time.localtime(now))
        self.path = self.folder / f'frames_{stamp}_{str(session)[:8]}.jsonl'
        self.size = self.path.stat().st_size if self.path.exists() else 0
        self.prune()

    def prune(self):
        files = sorted(self.folder.glob('frames_*.jsonl'), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        for old in files:
            if total <= TOTAL_LIMIT or old == self.path:
                continue
            total -= old.stat().st_size
            old.unlink(missing_ok=True)

    def write(self, session, plain, now=None):
        if self.failed or len(plain) < 2 or int.from_bytes(plain[:2], 'little') in SKIP:
            return
        now = time.time() if now is None else now
        try:
            if self.path is None or self.size + self.buffered >= FILE_LIMIT:
                self.flush()
                self._rotate(session, now)
        except OSError:
            self.failed = True
            return
        line = json.dumps(dict(t=round(now, 3), s=str(session), h=plain.hex())) + '\n'
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

    def close(self):
        self.flush()


def read_frames(paths):
    """(time, session, bytes) from recorded files, in file then line order."""
    for path in paths:
        try:
            lines = Path(path).read_text(encoding='ascii').splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for line in lines:
            try:
                record = json.loads(line)
                yield record['t'], record['s'], bytes.fromhex(record['h'])
            except (ValueError, KeyError, TypeError):
                continue
