"""Rebuild an open run from frames, then catch up on the capture thread.

Do not add historical aggregates: every frame is replayed once, with byte
offsets defining the handoff to live capture. Retire proven fragments only
after the replacement run is persisted successfully.
"""
import contextlib
import json
import sqlite3
import tempfile
import time
from pathlib import Path

from grind_handoff import encode, decode, snapshot, restore
from grind_pricing import Prices
from grind_tracker import Tracker, load_settings, write_json
from market_inventory import Inventory


class Rebuild(Tracker):
    def __init__(self, folder, prices, target, clock):
        self.target = target
        self.results = []
        super().__init__(folder, prices, now=lambda: clock[0])

    def gain(self, character, now, exp=0):
        if now + .002 >= self.target['started_at'] and character.key == self.target['character']['key']:
            super().gain(character, now, exp)

    def save_history(self, result):
        self.results.append(result)

    def persist(self):
        self.last_persist = self.now()

    def publish(self, now):
        self.last_publish = now


def replay_record(tracker, inventories, record, clock):
    clock[0] = max(clock[0], float(record['t']))
    if record.get('a'):
        if clock[0] >= tracker.target['started_at']:
            write_json(tracker.data/'command.json', dict(id=str(clock[0]), action=record['a'], at=clock[0]))
            tracker.command(clock[0])
        return
    session, payload = record['s'], bytes.fromhex(record['h'])
    if record.get('c'):
        tracker.observe_client(session, payload, recorded_index=record.get('i'))
    else:
        inv = inventories.setdefault(session, Inventory())
        inv.observe(payload, session)
        tracker.observe(session, payload, inv)
    if clock[0] - tracker.last_publish >= 5:
        tracker.tick()


def frames(data, offsets=None):
    for path in sorted((data/'frames').glob('frames_*.jsonl')):
        start = (offsets or {}).get(path.name, 0)
        size = path.stat().st_size
        if size < start:
            raise ValueError('Recording was truncated')
        with path.open('rb') as stream:
            stream.seek(start)
            while stream.tell() < size:
                line = stream.readline()
                if not line.endswith(b'\n') or stream.tell() > size:
                    break
                yield path.name, stream.tell(), json.loads(line)


def setup(folder, target, clock, prices, settings=None):
    settings = dict(settings or load_settings(folder/'settings.json'))
    settings.update(enabled=True, record_frames=False, upload=False)
    write_json(folder/'settings.json', settings)
    return Rebuild(folder.parent, prices, target, clock)


def prepare(folder):
    data = Path(folder)/'grind'
    current = json.loads((data/'current.json').read_text(encoding='utf-8'))
    with contextlib.closing(sqlite3.connect(data/'history.sqlite')) as db:
        history = [json.loads(r[0]) for r in db.execute('SELECT summary FROM runs')]
    for target in current['runs']:
        key = target['character'].get('key')
        if not key or target.get('status') == 'ended':
            continue
        fragments = [r for r in history if r['character'].get('key') == key
                     and target['started_at'] < r['started_at'] <= target['last_gain']
                     and r.get('ended_at', 0) <= current['saved_at']]
        if not fragments:
            continue
        clock, offsets, inventories, evidence = [0.0], {}, {}, set()
        with tempfile.TemporaryDirectory(prefix='grind-reconcile-') as tmp:
            tracker = setup(Path(tmp)/'grind', target, clock, Prices(data/'prices.json'), load_settings(data/'settings.json'))
            tracker.profile = __import__('grind_protocol').load_profile(data/'protocol.json')
            for name, offset, record in frames(data):
                replay_record(tracker, inventories, record, clock)
                offsets[name] = offset
                c = tracker.characters.get(record.get('s'))
                if c and c.key == key:
                    evidence.update(r['id'] for r in fragments if abs(r['started_at'] - record['t']) <= .002)
            candidates = [c.run for c in tracker.characters.values() if c.run and c.key == key
                          and abs(c.run.started_at - target['started_at']) <= .002]
            if len(candidates) != 1 or not evidence:
                continue
            rebuilt = candidates[0]
            rebuilt.id = target['id']
            proposal = dict(target=target, cutoff=clock[0], offsets=offsets, retire=sorted(evidence),
                            state=snapshot(tracker, set(tracker.characters)), inventories=encode({s: vars(v) for s, v in inventories.items()}),
                            before=dict(exp=sum(s['exp'] for s in target['segments']), kills=sum(s['kills'] for s in target['segments'])),
                            after=dict(exp=sum(s.exp for s in rebuilt.segments), kills=sum(s.kills for s in rebuilt.segments)))
            if not write_json(data/'reconcile-pending.json', proposal):
                raise OSError('Could not save reconciliation')
            return {k: proposal[k] for k in ('cutoff', 'retire', 'before', 'after')}
    return None


def apply_pending(live):
    path = live.data/'reconcile-pending.json'
    if not path.exists():
        return
    proposal = json.loads(path.read_text(encoding='utf-8'))
    target = proposal['target']
    current = next((c for c in live.characters.values() if c.run and c.run.id == target['id']), None)
    if current is None:
        return  # Wait for handoff to attach the live character.
    if current.key != target['character'].get('key') or abs(current.run.started_at - target['started_at']) > .002:
        raise ValueError('Live run changed during reconstruction')
    if live.frames is None or live.frames.failed:
        return
    live.frames.flush()
    clock = [proposal['cutoff']]
    with tempfile.TemporaryDirectory(prefix='grind-catchup-') as tmp:
        tracker = setup(Path(tmp)/'grind', target, clock, live.prices, live.settings)
        tracker.profile = live.profile
        sessions = {c['session'] for c in proposal['state']['characters']}
        restore(tracker, proposal['state'], sessions)
        inventories = {}
        for session, fields in decode(proposal['inventories']).items():
            inventories[session] = Inventory()
            vars(inventories[session]).update(fields)
        for name, offset, record in frames(live.data, proposal['offsets']):
            replay_record(tracker, inventories, record, clock)
        clock[0] = live.now()
        tracker.tick()
        candidates = [c.run for c in tracker.characters.values() if c.run and c.run.id == target['id']]
        if len(candidates) != 1:
            return  # A manual end or different run is not safe to replace.
        rebuilt = candidates[0]
        if rebuilt.status != current.run.status or rebuilt.pause_reason != current.run.pause_reason:
            return
        # Keep all current parser baselines and pending item matches. Only the
        # ledger and counters are replaced, after replay catches up to this tick.
        before = live.summarize(current.run, live.now(), current)
        previous, current.run = current.run, rebuilt
        live.dirty = True
        runs = [c.run.to_json() for c in live.characters.values() if c.run] + [r.to_json() for r in live.restored]
        if not write_json(live.data/'current.json', dict(saved_at=live.now(), runs=runs)):
            current.run = previous
            raise OSError('Could not persist repaired run')
        with contextlib.closing(sqlite3.connect(live.data/'history.sqlite')) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS reconciled_runs (fragment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL)')
            for ident in proposal['retire']:
                db.execute('INSERT OR IGNORE INTO reconciled_runs VALUES (?,?)', (ident, target['id']))
                db.execute('DELETE FROM runs WHERE id=?', (ident,))
        live.finished = [r for r in live.finished if r['id'] not in proposal['retire']]
        after = live.summarize(rebuilt, live.now(), current)
        metrics = ('exp', 'kills', 'mesos', 'item_value', 'consume_cost', 'net', 'active_seconds')
        write_json(live.data/'reconcile-result.json', dict(run_id=target['id'], retired=proposal['retire'],
                   before={k: before[k] for k in metrics}, after={k: after[k] for k in metrics}, applied_at=live.now()))
        path.unlink()
        live.publish(live.now())
