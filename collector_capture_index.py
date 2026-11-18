"""Upload candidates without rescanning the capture folder on every pass.

The capture folder only grows (2026-11-17: 288k files, 1.1 GB). Globbing it
four times, reading the whole sent ledger and reparsing map_observations.jsonl
every five seconds kept the collector reading ~13 MB/s even when idle. The
index is filled by one scan, then by file-system events; files that reached a
final ledger state leave it, and a periodic rescan catches missed events.
"""
import os
import threading
import time
from pathlib import Path

PREFIXES = ('shop_', 'presence_', 'roster_', 'grind_')
RESCAN_SECONDS = 600


def upload_candidate(name):
    return (name.endswith('.json') and name.startswith(PREFIXES)
            and name != 'grind_state.json' and not name.endswith('_zh.json'))


def scan(folder):
    try:
        with os.scandir(folder) as entries:
            return {e.name for e in entries if upload_candidate(e.name) and e.is_file()}
    except OSError:
        return set()


class CaptureIndex:
    def __init__(self, folder, rescan=RESCAN_SECONDS, clock=time.monotonic):
        self.folder = Path(folder)
        self.rescan = rescan
        self.clock = clock
        self.names = set()
        self.scanned = None
        self.lock = threading.Lock()

    def note(self, name):
        """A file event; cheap enough to call from the watchdog thread."""
        if upload_candidate(name):
            with self.lock:
                self.names.add(name)

    def paths(self):
        if self.scanned is None or self.clock() - self.scanned >= self.rescan:
            found = scan(self.folder)
            with self.lock:
                # Events seen during the scan are kept; deleted files go.
                self.names = found | {n for n in self.names if (self.folder/n).exists()}
                self.scanned = self.clock()
        with self.lock:
            return [self.folder/n for n in sorted(self.names)]

    def forget(self, names):
        with self.lock:
            self.names.difference_update(names)
