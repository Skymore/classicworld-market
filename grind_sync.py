"""Finished grind runs go to the site; shares get a public link.

Runs are uploaded as the parsed summary (never the recorded frames) and
belong to this client; when the client is linked to an account, the
account's grind pages list them. Every finished run is synced; there is no
switch. Progress lives in captures/grind/sync.sqlite so a run is sent again
only when its summary changed (repaired history, late prices).
"""
import contextlib
import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path

ALLOWED = ('https://mxd.ruit.me',)
EVERY = 60
BATCH = 20
DROP = ('recent',)


def clean(run):
    """What the site stores: the summary without rows duplicated elsewhere."""
    return {k: v for k, v in run.items() if k not in DROP}


def digest(run):
    return hashlib.sha256(json.dumps(clean(run), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class RunSync:
    def __init__(self, folder, post=None):
        self.folder = Path(folder)
        self.data = self.folder / 'grind'
        self.post = post or self.site_post
        self.lock = threading.Lock()
        self.error = None
        self.synced_at = None

    # ----- the site ------------------------------------------------------
    def config(self):
        try:
            config = json.loads((self.folder.parent / 'member.json').read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            return None
        endpoint = str(config.get('endpoint') or '').rstrip('/')
        if not config.get('token') or not (endpoint in ALLOWED or endpoint.startswith('http://127.0.0.1:')):
            return None
        return dict(endpoint=endpoint, token=config['token'])

    def site_post(self, route, payload):
        config = self.config()
        if config is None:
            raise ValueError('not_registered')
        from collector_http import request_json
        return request_json(config['endpoint'] + route, payload,
                            {'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'}, timeout=12)

    # ----- local state ---------------------------------------------------
    def db(self):
        self.data.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.data / 'sync.sqlite', timeout=5)
        db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, digest TEXT, synced_at REAL)')
        db.execute('CREATE TABLE IF NOT EXISTS shares (id TEXT, show_name INTEGER, show_profit INTEGER, code TEXT, url TEXT,'
                   ' created_at REAL, PRIMARY KEY (id, show_name, show_profit))')
        return db

    def history(self, limit=500):
        path = self.data / 'history.sqlite'
        if not path.exists():
            return []
        try:
            with contextlib.closing(sqlite3.connect(path, timeout=5)) as db:
                rows = db.execute('SELECT summary FROM runs ORDER BY started_at DESC LIMIT ?', (limit,)).fetchall()
        except sqlite3.Error:
            return []
        out = []
        for (raw,) in rows:
            try:
                out.append(json.loads(raw))
            except ValueError:
                continue
        return out

    def run(self, run_id):
        for run in self.history():
            if run.get('id') == run_id:
                return run
        try:
            live = json.loads((self.folder / 'grind_state.json').read_text(encoding='utf-8'))
            return next((r for r in live.get('runs') or [] if r.get('id') == run_id), None)
        except (OSError, ValueError):
            return None

    def shares(self):
        """{run id: share URL}, the most recent link of each run."""
        try:
            with contextlib.closing(self.db()) as db:
                rows = db.execute('SELECT id, url FROM shares ORDER BY created_at').fetchall()
        except sqlite3.Error:
            return {}
        return {run_id: url for run_id, url in rows}

    # ----- work ----------------------------------------------------------
    def sync_once(self):
        """Uploads finished runs whose summary is new or changed; returns how many."""
        with self.lock:
            with contextlib.closing(self.db()) as db:
                known = dict(db.execute('SELECT id, digest FROM runs'))
                sent = 0
                for run in self.history():
                    if not run.get('id') or run.get('status') not in (None, 'ended'):
                        continue
                    value = digest(run)
                    if known.get(run['id']) == value:
                        continue
                    try:
                        result = self.post('/api/v1/collector/grind-run', dict(run=clean(run)))
                    except Exception as error:
                        # A run the site refuses (400) is retried only when it changes.
                        code = getattr(error, 'code', None)
                        if code == 400:
                            db.execute('INSERT OR REPLACE INTO runs VALUES (?,?,?)', (run['id'], value, time.time()))
                            db.commit()
                            continue
                        self.error = type(error).__name__
                        break
                    if result.get('ok'):
                        db.execute('INSERT OR REPLACE INTO runs VALUES (?,?,?)', (run['id'], value, time.time()))
                        db.commit()
                        sent += 1
                        if sent >= BATCH:
                            break
                else:
                    self.error = None
                self.synced_at = time.time()
                return sent

    def share(self, run_id, show_name=True, show_profit=True):
        run = self.run(run_id)
        if run is None:
            raise ValueError('not_found')
        result = self.post('/api/v1/collector/grind-share',
                           dict(run=clean(run), show_name=bool(show_name), show_profit=bool(show_profit)))
        if not result.get('ok') or not result.get('url'):
            raise ValueError('unavailable')
        with contextlib.closing(self.db()) as db:
            db.execute('INSERT OR REPLACE INTO shares VALUES (?,?,?,?,?,?)',
                       (run_id, int(bool(show_name)), int(bool(show_profit)), result['code'], result['url'], time.time()))
            db.commit()
        return dict(code=result['code'], url=result['url'])

    def loop(self, stop):
        while not stop.wait(EVERY):
            try:
                self.sync_once()
            except Exception as error:
                self.error = type(error).__name__
