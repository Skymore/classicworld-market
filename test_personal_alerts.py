import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from werkzeug.serving import make_server
from collector_dashboard import create_server, safe_endpoint
from shared_client import start_dashboard, stop_dashboard
from shared_server import create_app
from shared_store import SharedStore


class PersonalAlertsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = SharedStore(self.root/'server', self.root/'no_catalog')
        self.a, self.ta = self.store.invite('TEST CLIENT A')
        self.b, self.tb = self.store.invite('TEST CLIENT B')
        self.reference, _ = self.store.invite('TEST REFERENCES')
        self.now = time.time()
        self.app = create_app(self.store, public_read=True)
        self.client = self.app.test_client()
        for index in range(8):
            self.upload(self.reference, 100+index, 100+index, 'REFERENCE '+str(index), self.now-30)

    def tearDown(self):
        self.temp.cleanup()

    def upload(self, member, shop, price, title, observed):
        self.store.upload(member, dict(version=1, world='ClassicWorld', complete=True,
            observation_id=str(shop)+':'+str(observed), observed_at=observed, shop_id=shop,
            title=title, location=dict(channel=1, room=1),
            items=[dict(item_id=4010001, category=4, slot=1, price=price, bundle=1, stock=5)]))

    def test_authenticated_candidates_are_isolated_and_duplicates_merge(self):
        self.upload(self.a, 1, 30, 'A ONLY', self.now-2)
        self.upload(self.b, 2, 35, 'B ONLY', self.now-1)
        self.upload(self.a, 1, 30, 'A ONLY', self.now)
        endpoint = '/api/v1/collector/alerts'
        self.assertEqual(self.client.get(endpoint).status_code, 401)
        self.assertEqual(self.client.get(endpoint, headers={'Authorization':'Bearer invalid'}).status_code, 401)
        a = self.client.get(endpoint+'?member='+self.b, headers={'Authorization':'Bearer '+self.ta}).get_json()
        b = self.client.get(endpoint, headers={'Authorization':'Bearer '+self.tb}).get_json()
        self.assertTrue(a['personal_alerts'])
        self.assertEqual([d['shop'] for d in a['opportunities']], ['A ONLY'])
        self.assertEqual([d['shop'] for d in b['opportunities']], ['B ONLY'])
        self.assertNotIn(self.ta, json.dumps(a))
        self.assertNotIn(self.a, json.dumps(a))
        public = self.client.get('/api/v1/market?summary=1').get_json()
        self.assertNotIn('opportunities', public)
        self.assertNotIn('personal_alerts', public)
        self.store.revoke(self.a)
        self.assertEqual(self.client.get(endpoint, headers={'Authorization':'Bearer '+self.ta}).status_code, 401)

    def test_current_shop_cannot_supply_the_eighth_reference(self):
        with self.store.repo.connect() as db:
            db.execute("DELETE FROM visits WHERE json_extract(payload,'$.shop_id')=107")
        self.upload(self.a, 1, 30, 'A ONLY', self.now)
        self.assertEqual(self.store.personal_alerts(self.a, self.store.report(72)), [])

    def test_old_uploads_are_not_new_alerts(self):
        self.upload(self.a, 1, 30, 'OLD A', self.now-600)
        self.assertEqual(self.store.personal_alerts(self.a, self.store.report(72)), [])

    def test_newer_stock_or_price_supersedes_old_low_quote_even_if_uploaded_out_of_order(self):
        self.upload(self.a, 1, 130, 'A ONLY', self.now)
        self.upload(self.a, 1, 30, 'A ONLY', self.now-1)
        self.assertEqual(self.store.personal_alerts(self.a, self.store.report(72)), [])
        newest = dict(version=1, world='ClassicWorld', complete=True, observation_id='sold-out-test',
            observed_at=self.now, shop_id=2, title='A SOLD OUT', location=dict(channel=1, room=1),
            items=[dict(item_id=4010001, category=4, slot=1, price=30, bundle=1, stock=0)])
        self.store.upload(self.a, newest)
        self.upload(self.a, 2, 30, 'A SOLD OUT', self.now-1)
        self.assertEqual(self.store.personal_alerts(self.a, self.store.report(72)), [])

    def test_loopback_ui_assets_credentials_and_actual_child_startup(self):
        self.upload(self.a, 1, 30, 'A ONLY', self.now)
        upstream = make_server('127.0.0.1', 0, self.app, threaded=True)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        config = dict(endpoint=f'http://127.0.0.1:{upstream.server_port}', token=self.ta)
        local = create_server(config, self.root/'captures', 0)
        local_thread = threading.Thread(target=local.serve_forever, daemon=True)
        local_thread.start()
        url = f'http://127.0.0.1:{local.server_port}'
        child = None
        try:
            for path in ('/alerts', '/market_ui.js', '/market_ui.css', '/market_i18n.js', '/market_watchlist.js'):
                with urllib.request.urlopen(url+path, timeout=10) as response:
                    body = response.read()
                    self.assertEqual(response.status, 200)
                    self.assertNotIn(self.ta.encode(), body)
            with urllib.request.urlopen(url+'/api/v1/market?summary=1', timeout=10) as response:
                data = json.load(response)
            self.assertTrue(data['personal_alerts'])
            self.assertEqual([d['shop'] for d in data['opportunities']], ['A ONLY'])
            for headers in ({'Origin':'https://unrelated.example'}, {'Host':'unrelated.example'}):
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(urllib.request.Request(url+'/api/v1/market', headers=headers))
                self.assertEqual(failure.exception.code, 403)
            home = self.root/'client'
            home.mkdir()
            cfg = home/'member.json'
            cfg.write_text(json.dumps(config), encoding='utf-8')
            child = start_dashboard(home, cfg, self.root/'captures', 0, open_browser=False)
            ready = json.loads((home/'dashboard.json').read_text(encoding='utf-8'))
            with urllib.request.urlopen(ready['url'], timeout=10) as response:
                self.assertIn(b'market_ui.js', response.read())
            self.assertIsNone(child.poll())
        finally:
            stop_dashboard(child)
            local.shutdown(); local.server_close(); local_thread.join(timeout=5)
            upstream.shutdown(); upstream.server_close(); thread.join(timeout=5)

    def test_credentials_only_go_to_supported_endpoints(self):
        self.assertEqual(safe_endpoint('https://mxd.ruit.me/'), 'https://mxd.ruit.me')
        for value in ('https://elsewhere.example', 'http://127.0.0.1:80@elsewhere.example',
                      'https://mxd.ruit.me@elsewhere.example', 'https://mxd.ruit.me/redirect'):
            with self.assertRaises(ValueError):
                safe_endpoint(value)


if __name__ == '__main__':
    unittest.main()
