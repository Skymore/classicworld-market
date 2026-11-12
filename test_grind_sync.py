import contextlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from grind_sync import RunSync


def history(folder, runs):
    data = Path(folder) / 'grind'
    data.mkdir(parents=True, exist_ok=True)
    with contextlib.closing(sqlite3.connect(data / 'history.sqlite')) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at REAL, ended_at REAL, summary TEXT)')
        db.execute('DELETE FROM runs')
        for run in runs:
            db.execute('INSERT INTO runs VALUES (?,?,?,?)', (run['id'], run['started_at'], run['started_at'] + 60,
                                                             json.dumps(run, ensure_ascii=False)))


class Refused(Exception):
    code = 400


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.folder = Path(self.dir.name) / 'captures'
        self.sent = []
        self.refuse = set()

        def post(route, payload):
            run = payload['run']
            if run['id'] in self.refuse:
                raise Refused()
            self.sent.append((route, run['id'], run.get('exp'), payload.get('show_name')))
            return dict(ok=True, code='Abc2345', url='https://mxd.ruit.me/g/Abc2345')
        self.sync = RunSync(self.folder, post=post)

    def tearDown(self):
        self.dir.cleanup()

    def run_(self, ident, exp, status='ended'):
        return dict(id=ident * 32, started_at=1_800_000_000 + exp, status=status, exp=exp, recent=[1, 2])

    def test_each_finished_run_once_and_again_when_it_changes(self):
        history(self.folder, [self.run_('a', 10), self.run_('b', 20), self.run_('c', 30, status='active')])
        self.assertEqual(self.sync.sync_once(), 2)
        self.assertEqual(self.sync.sync_once(), 0)
        self.assertEqual({r for _, r, _, _ in self.sent}, {'a' * 32, 'b' * 32})
        history(self.folder, [self.run_('a', 11), self.run_('b', 20)])   # rebuilt from frames
        self.assertEqual(self.sync.sync_once(), 1)
        self.assertEqual(self.sent[-1][1:3], ('a' * 32, 11))

    def test_refused_runs_wait_for_a_change(self):
        history(self.folder, [self.run_('a', 10)])
        self.refuse.add('a' * 32)
        self.assertEqual(self.sync.sync_once(), 0)
        self.refuse.clear()
        self.assertEqual(self.sync.sync_once(), 0)
        history(self.folder, [self.run_('a', 12)])
        self.assertEqual(self.sync.sync_once(), 1)

    def test_share_returns_and_remembers_the_link(self):
        history(self.folder, [self.run_('a', 10)])
        result = self.sync.share('a' * 32, show_name=False, show_profit=True)
        self.assertEqual(result['url'], 'https://mxd.ruit.me/g/Abc2345')
        self.assertEqual(self.sent[-1][0], '/api/v1/collector/grind-share')
        self.assertIs(self.sent[-1][3], False)
        self.assertEqual(self.sync.shares(), {'a' * 32: 'https://mxd.ruit.me/g/Abc2345'})
        with self.assertRaises(ValueError):
            self.sync.share('z' * 32)

    def test_only_the_site_endpoint_is_used(self):
        self.folder.mkdir(parents=True)
        (self.folder.parent / 'member.json').write_text(json.dumps(dict(endpoint='https://evil.example', token='t' * 40)))
        self.assertIsNone(RunSync(self.folder).config())
        (self.folder.parent / 'member.json').write_text(json.dumps(dict(endpoint='https://mxd.ruit.me/', token='t' * 40)))
        self.assertEqual(RunSync(self.folder).config()['endpoint'], 'https://mxd.ruit.me')


if __name__ == '__main__':
    unittest.main()
