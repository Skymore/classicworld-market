import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from collector_diagnostics import Diagnostics, RETENTION, redact, clean_text


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.token = 'private-collector-token-for-testing'
        runtime = SimpleNamespace(home=self.home, folder=self.home/'captures', stop_event=threading.Event(),
            configuration=lambda: {'token':self.token, 'endpoint':'https://mxd.ruit.me'})
        with patch.object(threading.Thread, 'start'):
            self.client = Diagnostics(runtime)
        self.client.paths = lambda: [('scan-recovery.jsonl', self.home/'scan-recovery.jsonl'),
                                    ('player_position.json', self.home/'player_position.json')]

    def test_automatic_start_ignores_old_disabled_preference(self):
        (self.home/'diagnostic-settings.json').write_text('{"enabled":false}')
        self.client.wake.set()
        with patch.object(self.client, 'cycle', side_effect=lambda *args: self.client.runtime.stop_event.set()) as cycle:
            self.client.run()
        cycle.assert_called_once_with(False, None)
        self.assertFalse(hasattr(self.client, 'configure'))

    def test_selected_screenshot_is_validated_and_queued_with_report(self):
        import base64, io
        from PIL import Image
        output = io.BytesIO()
        Image.new('RGB', (20,20), 'red').save(output, format='PNG')
        self.client.report(base64.b64encode(output.getvalue()).decode())
        screenshot = self.client.manual
        self.assertTrue(base64.b64decode(screenshot).startswith(b'\xff\xd8'))
        with patch('collector_http.request_json', side_effect=TimeoutError):
            with self.assertRaises(TimeoutError): self.client.cycle(True, screenshot)
        pending = list(self.client.root.glob('????????????????????????????????.json'))
        saved = json.loads(pending[0].read_text())
        self.assertEqual(saved['screenshot'], screenshot)
        self.assertEqual(saved['kind'], 'manual')
        with patch('collector_http.request_json', side_effect=lambda url,body,*args,**kwargs: {'report_id':body['id']}):
            self.client.cycle()
        self.assertEqual(self.client.view()['report_id'], saved['id'])
        self.assertNotIn('screenshot', self.client.collect())
        for invalid in ('bad base64', '', 'a'*1400001):
            with self.assertRaises(ValueError): self.client.report(invalid)

    def test_redaction_and_incremental_logs(self):
        path=self.home/'scan-recovery.jsonl'
        path.write_text(json.dumps({'event':'failed', 'token':self.token, 'reason':'No position',
            'nested':{'password':'hidden'},'message':self.token})+'\n',encoding='utf-8')
        (self.home/'player_position.json').write_text(json.dumps({'valid':False,'reason':'Missing directional SYN'}))
        first=self.client.collect()
        self.assertNotIn(self.token,json.dumps(first))
        self.assertNotIn('hidden',json.dumps(first))
        self.assertIn('Missing directional SYN',json.dumps(first))
        second=self.client.collect()
        self.assertEqual(second['files'],{})
        with path.open('a',encoding='utf-8') as out:out.write('{"event":"recovered"}\n')
        third=self.client.collect()
        self.assertIn('recovered',json.dumps(third))
        self.assertNotIn('No position',json.dumps(third))

    def test_network_failure_keeps_queue_and_retry_is_idempotent(self):
        with patch('collector_http.request_json',side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):self.client.cycle()
        pending=list(self.client.root.glob('????????????????????????????????.json'))
        original=json.loads(pending[0].read_text())['id']
        ids=[]
        def upload(url,body,headers,**kwargs):
            ids.append(body['id']);return {'report_id':body['id']}
        with patch('collector_http.request_json',side_effect=upload):self.client.cycle()
        self.assertIn(original,ids)
        self.assertEqual(list(self.client.root.glob('????????????????????????????????.json')),[])

    def test_retention_only_removes_own_expired_batches(self):
        report=self.client.collect()
        path=self.client.root/(report['id']+'.json')
        before=time.time()-RETENTION-10
        os.utime(path,(before,before))
        self.client.prune()
        self.assertFalse(path.exists())
        self.assertTrue((self.client.root/'cursors.json').exists())

    def test_plaintext_secrets_and_local_paths(self):
        output=clean_text('Authorization: Bearer abcdefghijklmnop\nFile "C:\\Users\\alice\\test.py"\nerror: alice@example.com 192.168.1.2',())
        for secret in ('abcdefghijklmnop','alice','192.168.1.2'):
            self.assertNotIn(secret,output)

    def test_shutdown_does_not_drain_automatic_batches(self):
        self.client.collect()
        self.client.runtime.stop_event.set()
        with patch('collector_http.request_json',return_value={}) as upload:
            self.client.cycle()
        upload.assert_not_called()


if __name__=='__main__':unittest.main()
