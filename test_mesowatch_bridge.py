import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from mesowatch_bridge import BridgeReader, BrowserBlocked, LIST_URL, allowed_url, prepare_extension


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = dict(port=0, token='test-private-token', extension_id='a'*32)
        self.reader = BridgeReader(self.temp.name, config=self.config, timeout=3)
        self.reader.__enter__()
        self.addCleanup(self.reader.__exit__)

    def request(self, path, data=None, **headers):
        headers.setdefault('Authorization', 'Bearer '+self.config['token'])
        headers.setdefault('Content-Type', 'application/json')
        raw = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(f'http://127.0.0.1:{self.reader.port}'+path, data=raw, headers=headers)
        with urllib.request.urlopen(request,timeout=5) as response:
            return json.load(response)

    def test_delivers_matching_result_and_rejects_replay(self):
        values = []
        worker = threading.Thread(target=lambda: values.append(self.reader.get(LIST_URL)))
        worker.start()
        job = self.request('/next')
        self.assertEqual(job['url'],LIST_URL)
        result = dict(id=job['id'],status=200,type='application/json',text='{"items":[]}')
        self.request('/result',result)
        worker.join(5)
        self.assertEqual(values,[{'items':[]}])
        with self.assertRaises(urllib.error.HTTPError) as error: self.request('/result',result)
        self.assertEqual(error.exception.code,409)

    def test_wrong_origin_missing_secret_and_rebound_host_are_denied(self):
        for headers in [dict(Origin='https://meso.watch'),dict(Authorization='Bearer wrong'),dict(Host='attacker.test')]:
            with self.assertRaises(urllib.error.HTTPError) as error: self.request('/next',**headers)
            self.assertEqual(error.exception.code,403)

    def test_block_page_is_not_parsed_as_evidence(self):
        errors = []
        def wait():
            try: self.reader.get(LIST_URL)
            except BrowserBlocked as error: errors.append(str(error))
        worker=threading.Thread(target=wait);worker.start()
        job=self.request('/next')
        self.request('/result',dict(id=job['id'],status=403,type='text/html'))
        worker.join(5)
        self.assertIn('HTTP 403',errors[0])

    def test_urls_cannot_be_used_for_general_browser_access(self):
        for url in ['https://meso.watch/api/me','https://evil.test/data/list.json',LIST_URL+'?token=secret',
                    'https://meso.watch/data/markets/Classic%20World/item/../secret.json']:
            self.assertFalse(allowed_url(url))
            with self.assertRaises(ValueError):self.reader.get(url)

    def test_staged_identity_is_stable_and_has_no_cookie_permissions(self):
        source=Path(__file__).parent/'tools/mesowatch-extension'
        folder, identity=prepare_extension(Path(self.temp.name), source)
        folder2, identity2=prepare_extension(Path(self.temp.name), source)
        self.assertEqual((folder,identity),(folder2,identity2))
        manifest=json.loads((folder/'manifest.json').read_text())
        self.assertEqual(manifest['permissions'],['alarms','scripting','storage'])
        self.assertNotIn('cookies',manifest['permissions'])
        self.assertNotIn('token',(folder/'manifest.json').read_text())


if __name__ == '__main__':unittest.main()
