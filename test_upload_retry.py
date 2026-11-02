import io
import json
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from email.utils import formatdate
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from shared_client import upload_once
from collector_upload_diagnostics import rejection
from collector_http import request_json


def error_worker(pipe):
    pipe.recv()
    pipe.send(('http', 400, '', 'Mon, 02 Nov 2026 02:00:00 GMT',
               b'{"error":"Invalid observation schema"}'))
    pipe.close()


class UploadRetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ledger = self.root/'upload.sqlite'
        self.config = dict(endpoint='http://127.0.0.1:9999', token='synthetic')
        self.events = []

    def capture(self, name):
        path = self.root/name
        path.write_text(json.dumps(dict(session='test', time=time.time(), shop_id=12,
                                       title='TEST', items=[])))
        return path

    def seed(self, name, status, updated=0):
        with closing(sqlite3.connect(self.ledger)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS sent(path TEXT PRIMARY KEY,status TEXT,updated REAL)')
            db.execute('INSERT INTO sent VALUES (?,?,?)', (name, status, updated))
            db.commit()

    def run_upload(self):
        return upload_once(self.root, self.config, self.ledger, on_event=self.events.append)

    def test_legacy_rejections_retry_without_resending_success_or_changing_capture(self):
        path = self.capture('shop_old.json'); original = path.read_bytes()
        self.seed(path.name, 'rejected_400')
        self.capture('shop_sent.json'); self.seed('shop_sent.json', 'sent')
        with patch('shared_client.request_json', return_value={'ok': True}) as send:
            self.assertEqual(self.run_upload(), 1)
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(self.events[-1]['pending'], 0)

    def test_failures_stay_visible_and_back_off(self):
        self.capture('shop_new.json')
        error = HTTPError('', 400, '', {'Date': formatdate(time.time()-3600, usegmt=True)},
                          io.BytesIO(b'{"error":"Invalid observation schema"}'))
        with patch('shared_client.request_json', side_effect=error) as send:
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.events[-1]['pending'], 1)
        detail = json.loads(self.ledger.with_suffix('.last-error.json').read_text())
        self.assertEqual(detail['reason'], 'capture_time_ahead')
        self.assertNotIn('synthetic', json.dumps(detail))

    def test_retry_batch_is_bounded_and_fresh_capture_goes_first(self):
        for n in range(15):
            name = f'shop_a{n}.json'; self.capture(name); self.seed(name, 'rejected_400')
        self.capture('shop_znew.json')
        with patch('shared_client.request_json', return_value={'ok': True}) as send:
            self.assertEqual(self.run_upload(), 11)
            self.assertEqual(send.call_count, 11)
        self.assertEqual(self.events[-1]['pending'], 5)

    def test_nonretryable_conflict_stays_visible_without_loop(self):
        self.capture('shop_conflict.json'); self.seed('shop_conflict.json', 'rejected_409')
        with patch('shared_client.request_json') as send:
            self.assertEqual(self.run_upload(), 0); send.assert_not_called()
        self.assertEqual(self.events[-1]['pending'], 1)

    def test_invalid_old_files_do_not_starve_valid_retry(self):
        for n in range(12):
            name = f'shop_a{n}.json'
            (self.root/name).write_text('{}')
            self.seed(name, 'rejected_400')
        self.capture('shop_zvalid.json'); self.seed('shop_zvalid.json', 'rejected_400')
        with patch('shared_client.request_json', return_value={'ok': True}) as send:
            self.assertEqual(self.run_upload(), 1)
            send.assert_called_once()

    def test_http_worker_boundary_retains_bounded_diagnostics(self):
        with self.assertRaises(HTTPError) as caught:
            request_json('unused', {}, {}, worker=error_worker)
        self.assertEqual(caught.exception.headers['Date'], 'Mon, 02 Nov 2026 02:00:00 GMT')
        self.assertEqual(json.load(caught.exception)['error'], 'Invalid observation schema')

    def test_gateway_body_is_not_logged(self):
        error = HTTPError('', 400, '', {}, io.BytesIO(b'<html>secret-token</html>'))
        self.assertEqual(rejection(error, {})['reason'], 'http_400')


if __name__ == '__main__':
    unittest.main()
