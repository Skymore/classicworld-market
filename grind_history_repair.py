"""Repair historical identity from exact start-frame/session evidence.

Keep original interval totals unless the full-run replay can replace them.
Never merge or add overlapping anonymous intervals into an existing run.
"""
import contextlib
import copy
import json
import sqlite3
from grind_data import job_name


class HistoryRepair:
    def __init__(self, data):
        self.pending, self.results = [], []
        path = data / 'history.sqlite'
        if path.exists():
            with contextlib.closing(sqlite3.connect(path)) as db:
                self.pending = [json.loads(r[0]) for r in db.execute('SELECT summary FROM runs')]
        self.pending = [r for r in self.pending if r.get('started_at')]

    def frame(self, base, stamp, session):
        c = base.characters.get(session)
        if not c or not c.key:
            return
        for old in list(self.pending):
            # Original start is the exact gain timestamp, never a UI minute.
            if abs(old['started_at'] - stamp) > .002:
                continue
            key = old.get('character', {}).get('key')
            if key and key != c.key:
                continue
            fresh = copy.deepcopy(old)
            fresh['character'] = c.facts()
            fresh['job_name'] = job_name(c.job)
            fresh['level'] = fresh.get('level') or c.level
            fresh['level_start'] = fresh.get('level_start') or c.level
            if fresh.get('map_id') is None:
                fresh['map_id'] = c.map_id
            for segment in fresh.get('segments', []):
                if segment.get('map_id') is None and abs(segment.get('started_at', 0) - stamp) <= .002:
                    segment['map_id'] = c.map_id
            self.results.append(fresh)
            self.pending.remove(old)


def apply_identities(data, results, prices, version):
    path = data / 'history.sqlite'
    if not path.exists():
        return 0
    evidence = {r['id']: r for r in results}
    updated = 0
    with contextlib.closing(sqlite3.connect(path, timeout=30)) as db, db:
        for ident, raw in db.execute('SELECT id,summary FROM runs').fetchall():
            row = json.loads(raw)
            original = copy.deepcopy(row)
            if ident in evidence:
                candidate = evidence[ident]
                for key in ('character', 'job_name', 'level', 'level_start', 'map_id'):
                    row[key] = candidate[key]
                for segment, recovered in zip(row.get('segments', []), candidate.get('segments', [])):
                    if segment.get('map_id') is None:
                        segment['map_id'] = recovered.get('map_id')
            for target in [row, *row.get('segments', [])]:
                name = (prices.map(target.get('map_id')) or {}).get('name')
                if name:
                    target['map_name'] = name
            if row != original:
                row['identity_replay_version'] = version
                db.execute('UPDATE runs SET summary=? WHERE id=?', (json.dumps(row, ensure_ascii=False), ident))
                updated += 1
    return updated
