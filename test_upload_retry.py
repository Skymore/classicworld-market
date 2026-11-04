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
from urllib.error import HTTPError, URLError

from shared_client import upload_once, upload_failure_event
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

    def rejected(self, ahead=0):
        return HTTPError('', 400, '', {'Date': formatdate(time.time()-ahead, usegmt=True)},
                         io.BytesIO(b'{"error":"Invalid observation schema"}'))

    def reject(self, *args, **kwargs):
        raise self.rejected()

    def age_out(self):
        """Pretend the hourly back-off has passed, without touching retry budget."""
        with closing(sqlite3.connect(self.ledger)) as db:
            db.execute('UPDATE sent SET updated=0'); db.commit()

    def status(self, name):
        with closing(sqlite3.connect(self.ledger)) as db:
            return db.execute('SELECT status FROM sent WHERE path=?', (name,)).fetchone()[0]

    def test_failures_stay_visible_and_back_off(self):
        self.capture('shop_new.json')
        with patch('shared_client.request_json', side_effect=self.reject) as send:
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.events[-1]['pending'], 1)
        detail = json.loads(self.ledger.with_suffix('.last-error.json').read_text())
        self.assertEqual(detail['reason'], 'Invalid observation schema')
        self.assertFalse(detail['final'])
        self.assertNotIn('synthetic', json.dumps(detail))

    def test_clock_ahead_rejection_is_final_and_never_retried(self):
        path = self.capture('shop_ahead.json'); original = path.read_bytes()
        with patch('shared_client.request_json', side_effect=self.rejected(ahead=3600)) as send:
            self.assertEqual(self.run_upload(), 0)
            self.age_out()
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.status(path.name), 'rejected_clock')
        rejected = [e for e in self.events if e['type'] == 'upload_rejected']
        self.assertEqual(rejected[0]['reason'], 'capture_time_ahead')
        self.assertTrue(rejected[0]['final'])
        self.assertEqual(self.events[-1]['pending'], 0)
        self.assertEqual(path.read_bytes(), original)

    def test_rejected_record_is_tried_at_most_three_times(self):
        path = self.capture('shop_bad.json')
        with patch('shared_client.request_json', side_effect=self.reject) as send:
            for _ in range(5):
                self.run_upload(); self.age_out()
            self.assertEqual(send.call_count, 3)
        self.assertEqual(self.status(path.name), 'rejected_final')
        self.assertEqual(self.events[-1]['pending'], 0)
        self.assertTrue(path.exists())

    def test_legacy_rejection_counts_as_one_failed_attempt(self):
        self.capture('shop_legacy.json'); self.seed('shop_legacy.json', 'rejected_400')
        with patch('shared_client.request_json', side_effect=self.reject) as send:
            for _ in range(4):
                self.run_upload(); self.age_out()
            self.assertEqual(send.call_count, 2)
        self.assertEqual(self.status('shop_legacy.json'), 'rejected_final')

    def test_out_of_window_record_is_never_retried(self):
        for name, data in (('shop_old.json', dict(session='test', time=time.time()-31*86400, shop_id=12, title='TEST', items=[])),
                           ('roster_old.json', dict(observed_at=time.time()-31*86400))):
            (self.root/name).write_text(json.dumps(data)); self.seed(name, 'rejected_400')
        with patch('shared_client.request_json') as send:
            self.run_upload(); self.run_upload()
            send.assert_not_called()
        self.assertEqual(self.status('shop_old.json'), 'rejected_final')
        self.assertEqual(self.status('roster_old.json'), 'rejected_final')
        self.assertEqual(self.events[-1]['pending'], 0)

    def test_hourly_retry_budget_leaves_quota_for_new_captures(self):
        import shared_client
        for n in range(80):
            name = f'shop_a{n:02}.json'; self.capture(name); self.seed(name, 'rejected_400')
        sent = []
        def accept(url, payload, headers, stop=None):
            sent.append(payload['shop_id']); return {'ok': True}
        clock = [time.time()]
        with patch('shared_client.request_json', side_effect=accept), \
             patch.object(shared_client.time, 'time', side_effect=lambda: clock[0]):
            for minute in range(10):
                # One fresh capture each minute is always uploaded first.
                fresh = self.root/f'shop_z{minute}.json'
                fresh.write_text(json.dumps(dict(session='test', time=clock[0], shop_id=1000+minute,
                                                 title='TEST', items=[])))
                before = len(sent)
                self.run_upload(); self.run_upload()
                self.assertEqual(sent[before], 1000+minute)
                self.assertLessEqual(len(sent)-before-1, shared_client.RETRY_PER_MINUTE)
                clock[0] += 61
        self.assertEqual(len([s for s in sent if s < 1000]), shared_client.RETRY_PER_HOUR)
        self.assertEqual(self.events[-1]['pending'], 20)

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

    def mixed_captures(self):
        for n in range(3):
            (self.root/f'presence_{n}.json').write_text(json.dumps(dict(
                version=1, world='ClassicWorld', parser='cw_player_departure_v1',
                event_id=str(n)*32, name='Example', character_id=123,
                seen_at=10, observed_at=11, location=dict(channel=26, room=1))))
        (self.root/'roster_1.json').write_text(json.dumps(dict(
            version=1, world='ClassicWorld', parser='cw_room_roster_v1', complete=True,
            event_id='a'*32, started_at=10, observed_at=11, character_ids=[123],
            location=dict(channel=26, room=1))))
        self.capture('shop_new.json')

    def test_slow_route_does_not_starve_other_routes_or_lose_pending_files(self):
        self.mixed_captures()
        calls=[]
        failure=URLError(TimeoutError())
        def send(url, *args, **kwargs):
            calls.append(url)
            if url.endswith('player-departure'):raise failure
            return {'ok':True}
        with patch('shared_client.request_json', side_effect=send):
            with self.assertRaises(URLError) as caught:self.run_upload()
        self.assertIs(caught.exception, failure)
        self.assertEqual(caught.exception.uploaded_count, 1)
        self.assertEqual(sum(u.endswith('player-departure') for u in calls), 1)
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.events[-1]['pending'], 3)
        self.assertEqual(self.status('shop_new.json'), 'sent')
        with patch('shared_client.request_json', return_value={'ok':True}) as send:
            self.assertEqual(self.run_upload(), 0)
            self.assertEqual(send.call_count, 3)
        self.assertEqual(self.events[-1]['pending'], 0)

    def test_global_quota_and_auth_stop_all_routes_preserving_retry_headers(self):
        self.mixed_captures()
        for code in (401,403,429):
            failure=HTTPError('',code,'',{'Retry-After':'60'},None)
            with patch('shared_client.request_json', side_effect=failure) as send:
                with self.assertRaises(HTTPError) as caught:self.run_upload()
                self.assertIs(caught.exception, failure)
                self.assertEqual(send.call_count, 1)
                self.assertEqual(caught.exception.headers['Retry-After'], '60')

    def test_cancellation_is_not_deferred_as_a_network_failure(self):
        self.mixed_captures()
        with patch('shared_client.request_json', side_effect=InterruptedError) as send:
            with self.assertRaises(InterruptedError):self.run_upload()
            self.assertEqual(send.call_count, 1)

    def test_http_server_failure_isolated_and_acknowledged_count_preserved(self):
        self.mixed_captures()
        def send(url, *args, **kwargs):
            if url.endswith('room-roster'):raise HTTPError('',503,'',{},None)
            return {'ok':True}
        with patch('shared_client.request_json', side_effect=send):
            with self.assertRaises(HTTPError) as caught:self.run_upload()
        self.assertEqual(caught.exception.uploaded_count, 1)
        self.assertEqual(self.events[-1]['pending'], 1)

    def test_real_ledger_lock_reports_sqlite_code_without_stopping_capture(self):
        self.capture('shop_new.json')
        self.seed('shop_old.json','sent')
        with closing(sqlite3.connect(self.ledger)) as holder:
            holder.execute('BEGIN EXCLUSIVE')
            with closing(sqlite3.connect(self.ledger, timeout=0)) as blocked:
                try:blocked.execute('SELECT * FROM sent')
                except sqlite3.OperationalError as error:event=upload_failure_event(error)
                else:self.fail('Expected SQLite lock')
            holder.rollback()
        self.assertEqual(event['type'], 'upload_error')
        self.assertEqual(event['diagnostic']['sqlite_name'], 'SQLITE_BUSY')
        self.assertNotIn(str(self.root),json.dumps(event))
        with patch('shared_client.request_json',return_value={'ok':True}):
            self.assertEqual(self.run_upload(),1)


if __name__ == '__main__':
    unittest.main()
