"""Replay local recordings once per collector version; never sends or uploads."""
import contextlib
import json
import sqlite3
import tempfile
import time
from pathlib import Path

from grind_frames import RETENTION_SECONDS
from grind_pricing import Prices
from grind_tracker import Tracker, load_settings, write_json
from market_inventory import Inventory


class ReplayTracker(Tracker):
    def __init__(self, *args, **kwargs):
        self.results = []
        super().__init__(*args, **kwargs)

    def save_history(self, summary):
        self.results.append(summary)

    def persist(self):
        self.last_persist = self.now()

    def publish(self, now):
        self.last_publish = now


def replay_once(folder, version, stop=None, force=False):
    folder = Path(folder)
    data = folder / 'grind'
    status = data / 'replay.json'
    try:
        previous = json.loads(status.read_text(encoding='utf-8'))
        if (not force and previous.get('version') == version and previous.get('state') == 'done'
                and (data / 'replay-results.json').exists()):
            return previous
    except (OSError, ValueError):
        pass
    if not load_settings(data / 'settings.json')['record_frames']:
        return None
    now = time.time()
    # Snapshot file sizes: never chase a live writer or read a partial last line.
    files = [(p, p.stat().st_size) for p in sorted((data / 'frames').glob('frames_*.jsonl'))
             if p.stat().st_mtime >= now - RETENTION_SECONDS]
    write_json(status, dict(version=version, state='running', started_at=now))
    try:
        with tempfile.TemporaryDirectory(prefix='grind-replay-') as temporary:
            settings = load_settings(data / 'settings.json')
            settings.update(enabled=True, record_frames=False, upload=False)
            write_json(Path(temporary) / 'grind/settings.json', settings)
            clock = [0.0]
            tracker = ReplayTracker(temporary, Prices(data / 'prices.json'), now=lambda: clock[0])
            inventories, first, last = {}, {}, {}
            boundaries = []
            if (data / 'history.sqlite').exists():
                with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db:
                    for raw, in db.execute('SELECT summary FROM runs'):
                        old = json.loads(raw)
                        if old.get('ended_at') and old.get('started_at'):
                            boundaries.append((old['ended_at'], old['started_at'], old.get('character', {}).get('key')))
            boundaries.sort(key=lambda row: row[0], reverse=True)
            ticks = count = 0
            for path, size in files:
                with path.open('rb') as stream:
                    while stream.tell() < size:
                        line = stream.readline()
                        if stream.tell() > size or not line.endswith(b'\n'):
                            break
                        if stop is not None and stop.is_set():
                            return None
                        try:
                            record = json.loads(line)
                            if record.get('a') in ('pause', 'resume', 'toggle', 'end'):
                                clock[0] = max(clock[0], float(record['t']))
                                write_json(Path(temporary) / 'grind/command.json',
                                           dict(id=f'replay-{path.name}-{stream.tell()}', action=record['a'], at=clock[0]))
                                tracker.command(clock[0])
                                for character in tracker.characters.values():
                                    if character.key:
                                        last[character.key] = clock[0]
                                continue
                            stamp, session = float(record['t']), str(record['s'])
                            payload = bytes.fromhex(record['h'])
                        except (ValueError, KeyError, TypeError):
                            continue
                        if stamp < now - RETENTION_SECONDS:
                            continue
                        # Older logs omitted UI commands. Preserve explicit saved
                        # end boundaries rather than inventing new combined runs.
                        while boundaries and boundaries[-1][0] <= stamp:
                            end, start, key = boundaries.pop()
                            for character in tracker.characters.values():
                                if (character.key == key and character.run
                                        and abs(character.run.started_at - start) <= 5):
                                    clock[0] = end
                                    tracker.end(character, end)
                        clock[0] = max(clock[0], stamp)
                        count += 1
                        if clock[0] - ticks >= 5:
                            tracker.tick()
                            ticks = clock[0]
                        if record.get('c'):
                            character = tracker.characters.get(session)
                            if character is None:
                                continue
                            if character is not None and record.get('i') is not None and character.table is None:
                                character.table = []  # Mapping index was saved with the frame.
                            tracker.observe_client(session, payload, recorded_index=record.get('i'))
                        else:
                            inv = inventories.setdefault(session, Inventory())
                            inv.observe(payload, session)
                            tracker.observe(session, payload, inv)
                            character = tracker.characters.get(session)
                            if character and character.character_id:
                                key = character.key
                                first.setdefault(key, stamp)
                                last[key] = stamp
                # Yield to the real-time capture worker between files.
                time.sleep(.01)
            for character in list(tracker.characters.values()):
                if character.run:
                    tracker.end(character, clock[0])
            for run in list(tracker.restored):
                tracker.finish(run, clock[0])
            # Keep rebuilt results even where old versions omitted session
            # boundaries and an in-place history replacement is ambiguous.
            if not write_json(data / 'replay-results.json', dict(version=version, runs=tracker.results)):
                raise OSError('Could not save replay results')
            updated = apply_results(data, tracker.results, first, last, version)
        result = dict(version=version, state='done', frames=count, rebuilt=len(tracker.results),
                      updated=updated, finished_at=time.time())
        write_json(status, result)
        return result
    except Exception as error:
        write_json(status, dict(version=version, state='failed', error=type(error).__name__))
        return None


def apply_results(data, results, first, last, version):
    """Only replace fully covered, completed history; keep live runs untouched."""
    path = data / 'history.sqlite'
    if not path.exists():
        return 0
    updated = 0
    with contextlib.closing(sqlite3.connect(path, timeout=30)) as db, db:
        originals = db.execute('SELECT id, summary FROM runs').fetchall()
        for ident, raw in originals:
            old = json.loads(raw)
            char = (old.get('character') or {}).get('key')
            start, end = old.get('started_at'), old.get('ended_at')
            if not char or not start or not end or first.get(char, float('inf')) > start or last.get(char, 0) < end:
                continue
            candidates = [r for r in results if r.get('character', {}).get('key') == char
                          and abs(r['started_at'] - start) <= 5 and abs(r['ended_at'] - end) <= 10]
            if len(candidates) != 1:
                continue  # Missing frames or changed session boundaries: don't overwrite.
            fresh = dict(candidates[0], id=ident, replay_version=version)
            db.execute('UPDATE runs SET summary=? WHERE id=?', (json.dumps(fresh, ensure_ascii=False), ident))
            updated += 1
    return updated
