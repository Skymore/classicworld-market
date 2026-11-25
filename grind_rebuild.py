"""The rebuild from local recordings after a parser fix, in a process of its own.

Capture, the overlay and the window are threads of one Python process, and Python runs one
thread at a time. Rebuilt in a thread there, the open run and 30 days of history (minutes of
a full CPU core) starved the capture thread: its packet queue (8192) overflowed, every game
connection was dropped with "Local capture queue overflow", a channel change did not help
and the screen stuttered (2026-11-17, a teammate on 巫婆森林). Here it runs at below-normal
priority and holds no lock the collector needs; progress is in files (replay.json groups,
reconcile-pending.json), so ending the process when the app closes loses nothing.
"""
import json
import sqlite3
from pathlib import Path

# The rebuild's CPU: a quarter of one core, so a 30-day rebuild (tens of minutes of a core)
# runs in the background over a few hours instead of holding a core the whole time.
CPU_SHARE = 0.25


def needed(folder):
    """Whether this release's rebuild (REPLAY_VERSION) is still to do or to finish."""
    from grind_replay import REPLAY_VERSION
    try:
        status = json.loads((Path(folder) / 'grind' / 'replay.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return True
    return not (status.get('version') == REPLAY_VERSION and status.get('state') == 'done')


def lower_priority():
    try:
        import psutil
        psutil.Process().nice(getattr(psutil, 'BELOW_NORMAL_PRIORITY_CLASS', 10))
    except Exception:
        pass


def run(folder):
    """The open run first (its own connections, seconds), then history newest first."""
    lower_priority()
    import grind_replay
    grind_replay.throttle = grind_replay.Throttle(CPU_SHARE)
    folder = Path(folder)
    from grind_reconcile import prepare
    from grind_replay import REPLAY_VERSION, replay_once
    try:
        prepare(folder)
    except (OSError, ValueError, KeyError, sqlite3.Error):
        pass
    fetch = None
    try:
        from grind_sync import RunSync
        config = RunSync(folder).config()
        if config:
            from grind_pricing import site_fetch
            from shared_client import upload_opener
            fetch = site_fetch(config, upload_opener)
    except Exception:
        fetch = None   # cached prices then; never a reason to skip the rebuild
    replay_once(folder, REPLAY_VERSION, fetch=fetch)


def start(folder):
    """The rebuild process, or None when there is nothing to rebuild."""
    if not needed(folder):
        return None
    import multiprocessing
    process = multiprocessing.get_context('spawn').Process(target=run, args=(str(folder),),
                                                           daemon=True, name='grind-rebuild')
    process.start()
    return process
