"""Replay local recordings once per collector version; never sends or uploads."""
import contextlib
import hashlib
import json
import sqlite3
import tempfile
import time
from pathlib import Path

from grind_frames import RETENTION_SECONDS, current_path, frame_files, frame_name, frame_size, open_frames, recorded_index, server_payload
from grind_pricing import Prices
from grind_tracker import Tracker, load_settings, write_json
from market_inventory import Inventory


class ReplayTracker(Tracker):
    read_presets = False

    def __init__(self, *args, **kwargs):
        self.results = []
        super().__init__(*args, **kwargs)

    def save_history(self, summary):
        # A record ended at a change of map is saved again when the next one goes back into it.
        self.results = [r for r in self.results if r['id'] != summary['id']] + [summary]

    def persist(self):
        self.last_persist = self.now()

    def publish(self, now):
        self.last_publish = now


# Bump when a parser or accounting fix should rebuild history from the recordings.
# Releases that only change the interface keep it, and nothing is replayed (2026-11-15:
# every release replayed 30 days, 5.6 M frames, ~13 min of a CPU core, for nothing).
# r12: summaries carry 积分's inputs (basic_value, timeline mesos and basic); r13: ores count;
# r14: the timeline's consumable cost (积分 subtracts it); r15: 南瓜派 at a fixed 750;
# r16: the timeline's other (non-basic) drops, for 积分's optional term; r17: a change of
# grinding map splits the record (apply_results), the wait before the end is idle time.
REPLAY_VERSION = 'r17-2026-11-27'


def file_start(path):
    """When a recording starts: its first record's time (the name is local time, which a
    clock or time zone change can move), else the time in frames_YYYYMMDD_HHMMSS_<s>."""
    try:
        with open_frames(current_path(path)) as stream:
            return float(json.loads(stream.readline())['t'])
    except (OSError, ValueError, KeyError, TypeError, EOFError):
        pass
    try:
        stamp = '_'.join(frame_name(path).split('_')[1:3])
        return time.mktime(time.strptime(stamp, '%Y%m%d_%H%M%S'))
    except (ValueError, IndexError):
        return None


def opens_with_snapshot(path, lines=4000):
    """Whether a recording begins a connection with its full character snapshot (0x1a6 /
    0x1a9: bags, mesos), as a login or channel change does. A collector restart takes over
    the same connection under a new session name without one (2026-11-15: replay cut
    there, its runs lost their bags and counted no loot or consumables)."""
    try:
        with open_frames(current_path(path)) as stream:
            for _ in range(lines):
                line = stream.readline()
                if not line:
                    break
                record = json.loads(line)
                hexed = record.get('h') or ''
                if not record.get('c') and len(hexed) >= 1024 and hexed[:4] in ('a601', 'a901'):
                    return True
    except (OSError, ValueError, EOFError):
        pass
    return False


def frame_groups(files, spans=()):
    """Recordings in independent stretches, newest first, each replayed forward.

    A stretch starts where a new game connection does (its first file opens with the login
    or channel-change snapshot that bags and buffs build up from) and no run in `spans`
    ((start, end) of saved and open runs) is going on, so no run is split between two.
    The client records around the clock, an hour per file without gaps, so time gaps
    alone never split 30 days (2026-11-15: rebuilding the open run still read them all)."""
    groups, seen = [], set()
    for path, size in files:
        start = file_start(path)
        if start is None:
            continue
        session = frame_name(path).rsplit('_', 1)[-1].split('.', 1)[0]
        cut = (session not in seen and groups
               and not any(a < start < b for a, b in spans) and opens_with_snapshot(path))
        seen.add(session)
        if cut or not groups:
            groups.append([(path, size)])
        else:
            groups[-1].append((path, size))
    return [(frame_name(g[0][0]), g) for g in reversed(groups)]


def replay_once(folder, version, stop=None, force=False, fetch=None):
    """Rebuild saved history from the recordings, newest stretch first; each stretch
    replaces its runs as soon as it is done, and progress survives a restart."""
    folder = Path(folder)
    data = folder / 'grind'
    status = data / 'replay.json'
    previous = {}
    try:
        previous = json.loads(status.read_text(encoding='utf-8'))
        if (not force and previous.get('version') == version and previous.get('state') == 'done'
                and (data / 'replay-results.json').exists()):
            return previous
    except (OSError, ValueError):
        previous = {}
    if not load_settings(data / 'settings.json')['record_frames']:
        return None
    now = time.time()
    # Snapshot file sizes: never chase a live writer or read a partial last line.
    files = []
    for p in frame_files(data / 'frames'):
        try:
            if p.stat().st_mtime >= now - RETENTION_SECONDS:
                files.append((p, frame_size(p)))
        except OSError:
            continue   # compressed or pruned meanwhile; listed again next version
    resume = not force and previous.get('version') == version and previous.get('state') in ('running', 'failed')
    done = set(previous.get('groups') or []) if resume else set()
    totals = {k: (previous.get(k) or 0) if resume else 0 for k in ('frames', 'rebuilt', 'updated', 'identities')}
    started = previous.get('started_at', now) if resume else now
    results = []
    if resume:
        try:
            results = json.loads((data / 'replay-results.json').read_text(encoding='utf-8')).get('runs') or []
        except (OSError, ValueError):
            results = []

    def progress(state, **extra):
        write_json(status, dict(version=version, state=state, started_at=started, groups=sorted(done), **totals, **extra))

    progress('running')
    try:
        settings = load_settings(data / 'settings.json')
        settings.update(enabled=True, record_frames=False, upload=False)
        prices = Prices(data / 'prices.json', fetch)
        # Rebuilt history uses today's prices: fetch them first rather than
        # pricing with a cache an older client filled.
        prices.refresh_now(list(prices.rows))
        boundaries = []
        if (data / 'history.sqlite').exists():
            with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db:
                for raw, in db.execute('SELECT summary FROM runs'):
                    old = json.loads(raw)
                    if old.get('ended_at') and old.get('started_at'):
                        boundaries.append((old['ended_at'], old['started_at'], old.get('character', {}).get('key')))
        boundaries.sort(key=lambda row: row[0], reverse=True)
        from grind_history_repair import HistoryRepair, apply_identities
        spans = [(start, end) for end, start, _ in boundaries]
        for key, group in frame_groups(files, spans):
            if key in done:
                continue
            outcome = replay_group(settings, prices, group, list(boundaries), now, stop, HistoryRepair(data))
            if outcome is None:
                return None   # stopped: finished stretches stay applied, the rest resumes
            runs, first, last, count, repair = outcome
            totals['frames'] += count
            totals['rebuilt'] += len(runs)
            totals['updated'] += apply_results(data, runs, first, last, version)
            totals['identities'] += apply_identities(data, repair.results, prices, version)
            results += runs
            if not write_json(data / 'replay-results.json', dict(version=version, runs=results)):
                raise OSError('Could not save replay results')
            done.add(key)
            progress('running')
        repriced = reprice_history(data, prices, version)
        result = dict(version=version, state='done', **totals, repriced=repriced, finished_at=time.time())
        write_json(status, result)
        return result
    except Exception as error:
        progress('failed', error=type(error).__name__)
        return None


def replay_group(settings, prices, group, boundaries, now, stop, repair):
    """One stretch, forward, in a fresh tracker: (runs, first, last, frames, repair),
    or None when stopped."""
    with tempfile.TemporaryDirectory(prefix='grind-replay-') as temporary:
        write_json(Path(temporary) / 'grind/settings.json', settings)
        clock = [0.0]
        tracker = ReplayTracker(temporary, prices, now=lambda: clock[0])
        inventories, first, last = {}, {}, {}
        ticks = count = 0
        for path, size in group:
            with open_frames(current_path(path)) as stream:
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
                                       dict(id=f'replay-{frame_name(path)}-{stream.tell()}', action=record['a'], at=clock[0]))
                            tracker.command(clock[0])
                            for character in tracker.characters.values():
                                if character.key:
                                    last[character.key] = clock[0]
                            continue
                        stamp, session = float(record['t']), str(record['s'])
                        payload = server_payload(record)
                    except (ValueError, KeyError, TypeError):
                        continue
                    if stamp < now - RETENTION_SECONDS:
                        continue
                    # Older logs omitted UI commands. Preserve explicit saved
                    # end boundaries rather than inventing new combined runs.
                    while boundaries and boundaries[-1][0] <= stamp:
                        end, start, key = boundaries.pop()
                        for character in tracker.characters.values():
                            run = character.run
                            if (character.key == key and run
                                    and min(abs(run.started_at - start), abs((run.chain_started or 0) - start)) <= 5):
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
                        if record.get('i') is not None and character.table is None:
                            character.table = []  # Mapping index was saved with the frame.
                        tracker.observe_client(session, payload, recorded_index=recorded_index(record))
                    else:
                        inv = inventories.setdefault(session, Inventory())
                        inv.observe(payload, session)
                        tracker.observe(session, payload, inv)
                        character = tracker.characters.get(session)
                        if character and character.character_id:
                            key = character.key
                            first.setdefault(key, stamp)
                            last[key] = stamp
                    repair.frame(tracker, stamp, session)
            # Yield to the real-time capture worker between files.
            time.sleep(.01)
        for character in list(tracker.characters.values()):
            if character.run:
                tracker.end(character, clock[0])
        for run in list(tracker.restored):
            tracker.finish(run, clock[0])
        return tracker.results, first, last, count, repair


def reprice_history(data, prices, version):
    """Today's prices for runs the frames could not rebuild (older recordings, or
    boundaries that no longer match): loot and every consumable, with the totals and
    hourly net. Sync re-uploads what changed."""
    path = data / 'history.sqlite'
    if not path.exists():
        return 0
    with contextlib.closing(sqlite3.connect(path, timeout=30)) as db:
        rows = db.execute('SELECT id, summary FROM runs').fetchall()
    runs = [(ident, json.loads(raw)) for ident, raw in rows]
    wanted = {r.get('item_id') for _, s in runs for r in (s.get('loot') or []) + (s.get('consumables') or [])}
    prices.refresh_now([i for i in wanted if i])
    changed = []
    for ident, summary in runs:
        if summary.get('replay_version') == version or summary.get('repriced') == version:
            continue
        item_value = 0.0
        for row in summary.get('loot') or []:
            item = row.get('item_id')
            gear = bool(item) and item // 1_000_000 == 1
            piece = None
            if gear and row.get('stats') is not None:
                # Rows before v0.8.3 have no remaining upgrades: a drop is unscrolled, so
                # it has all of the item's (the site sends them); without, its value stays.
                slots = row['remaining_upgrades'] if 'remaining_upgrades' in row else (prices.row(item) or {}).get('upgrades')
                if slots is not None:
                    piece = dict(stats=row['stats'], remaining_upgrades=slots)
            if item and (not gear or piece is not None):
                unit, label = prices.loot(item, piece)
                if unit is not None:
                    row.update(unit=unit, basis=label, value=unit * (row.get('quantity') or 0), priced=True)
            item_value += row.get('value') or 0
        cost = 0.0
        for row in summary.get('consumables') or []:
            unit, _ = prices.consumable(row['item_id'])
            if unit is not None:
                row['cost'] = unit * (row.get('used') or 0)
            cost += row.get('cost') or 0
        if not summary.get('loot'):
            item_value = summary.get('item_value') or 0
        mesos, spent = summary.get('mesos') or 0, summary.get('mesos_spent') or 0
        net = mesos + item_value - cost - spent
        hours = (summary.get('active_seconds') or 0) / 3600
        from grind_tracker import basic_drop
        # 积分 (绩效模式) of runs the frames could not rebuild: from the repriced loot rows.
        summary['basic_value'] = round(sum(row.get('value') or 0 for row in summary.get('loot') or [] if basic_drop(row.get('item_id'))))
        summary.update(item_value=round(item_value), consume_cost=round(cost), net=round(net),
                       net_per_hour=net / hours if hours else summary.get('net_per_hour'), repriced=version)
        home = home_map(summary.get('segments'))
        if home is not None and home != summary.get('map_id'):
            # Named after the map with the most grinding time, not the last one (Run.home).
            summary.update(map_id=home, map_name=(prices.map(home) or {}).get('name'))
        changed.append((json.dumps(summary, ensure_ascii=False), ident))
    if changed:
        with contextlib.closing(sqlite3.connect(path, timeout=30)) as db, db:
            db.executemany('UPDATE runs SET summary=? WHERE id=?', changed)
    return len(changed)


def piece_id(ident, index):
    """The ID of a later record split from saved run `ident`: the same on every replay."""
    return ident if index == 0 else hashlib.md5(f'{ident}:{index}'.encode()).hexdigest()


def pieces_of(old, results):
    """The rebuilt records that make up saved run `old`: the one starting with it and those
    split from the same continuous grind after it, up to its end. A record that waited out
    the end now ends where grinding stopped, before the saved end; none ends after it."""
    char = (old.get('character') or {}).get('key')
    start, end = old['started_at'], old['ended_at']
    inside = sorted((r for r in results if r.get('character', {}).get('key') == char
                     and start - 5 <= r['started_at'] < end - 1 and r.get('ended_at') and r['ended_at'] <= end + 10),
                    key=lambda r: r['started_at'])
    heads = [r for r in inside if abs(r['started_at'] - start) <= 5]
    if len(heads) != 1:
        return []
    chain = heads[0].get('chain') or heads[0]['id']
    later = [r for r in inside if r is not heads[0]]
    if any(r.get('chain') != chain for r in later):
        return []   # another grind inside: boundaries changed, don't overwrite
    return heads + later


def home_map(segments):
    time = {}
    for s in segments or []:
        if s.get('map_id') is not None:
            time[s['map_id']] = time.get(s['map_id'], 0) + (s.get('active_seconds') or 0)
    return max(time, key=time.get) if time else None


def apply_results(data, results, first, last, version):
    """Only replace fully covered, completed history; keep live runs untouched. A saved run
    the rebuild splits by map becomes its records: the first keeps the run's ID (and so its
    share links), the others get IDs derived from it; the run as it was stays in split_runs."""
    path = data / 'history.sqlite'
    if not path.exists():
        return 0
    updated = 0
    with contextlib.closing(sqlite3.connect(path, timeout=30)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS split_runs (id TEXT PRIMARY KEY, summary TEXT, pieces TEXT, version TEXT)')
        originals = db.execute('SELECT id, summary FROM runs').fetchall()
        for ident, raw in originals:
            old = json.loads(raw)
            char = (old.get('character') or {}).get('key')
            start, end = old.get('started_at'), old.get('ended_at')
            if not char or not start or not end or first.get(char, float('inf')) > start or last.get(char, 0) < end:
                continue
            pieces = pieces_of(old, results)
            if not pieces:
                continue  # Missing frames or changed session boundaries: don't overwrite.
            ids = [piece_id(ident, n) for n in range(len(pieces))]
            if len(pieces) > 1:
                db.execute('INSERT OR IGNORE INTO split_runs VALUES (?,?,?,?)', (ident, raw, json.dumps(ids), version))
            for n, (piece, new) in enumerate(zip(pieces, ids)):
                fresh = dict(piece, id=new, replay_version=version, chain=None, chain_started=None, previous_id=None)
                if len(pieces) > 1 or old.get('chain'):
                    # The replay's own IDs are new each time: link the records by the saved ones.
                    fresh.update(chain=old.get('chain') or ident, chain_started=old.get('chain_started') or start,
                                 previous_id=ids[n - 1] if n else old.get('previous_id'))
                db.execute('INSERT OR REPLACE INTO runs VALUES (?,?,?,?)',
                           (new, fresh['started_at'], fresh['ended_at'], json.dumps(fresh, ensure_ascii=False)))
                updated += 1
    return updated
