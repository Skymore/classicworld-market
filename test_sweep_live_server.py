"""End-to-end against a locally running server: device login, watch sync, a web-started run,
purchases through the live engine with a fake purchaser, and the run accounting.

    CWM_TEST_SERVER=http://127.0.0.1:PORT CWM_TEST_ORIGIN=https://<server hostname> python -m unittest test_sweep_live_server

The server checks Origin against its configured hostname; CWM_TEST_ORIGIN must be https://<that hostname>.
"""
import json
import os
import secrets
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

SERVER = os.environ.get('CWM_TEST_SERVER', '').rstrip('/')
ORIGIN = os.environ.get('CWM_TEST_ORIGIN', 'https://mxd.ruit.me')
ITEM = 1002000
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(base, method, path, body=None, headers=None):
    request = urllib.request.Request(base+path, method=method, headers=dict(headers or {}),
                                     data=None if body is None else json.dumps(body).encode())
    if body is not None:
        request.add_header('Content-Type', 'application/json')
    try:
        with OPENER.open(request, timeout=20) as response:
            return json.load(response), response.headers
    except urllib.error.HTTPError as error:
        raise AssertionError(f'{method} {path} -> {error.code} {error.read(500)!r}') from None


@unittest.skipUnless(SERVER, 'set CWM_TEST_SERVER to a locally running server')
class LiveSweepTests(unittest.TestCase):
    def web(self, method, path, body=None):
        headers = {'Origin': ORIGIN, 'Cookie': 'cwm_account='+self.cookie}
        if self.csrf:
            headers['X-CSRF-Token'] = self.csrf
        return call(SERVER, method, path, body, headers)[0]

    def local(self, method, path, body=None):
        headers = {'Origin': self.base, 'X-CSRF-Token': self.nonce} if body is not None else {}
        return call(self.base, method, path, body, headers)[0]

    def setUp(self):
        from collector_dashboard import create_server
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.folder = self.home/'captures'
        self.folder.mkdir()
        self.password = 'live-test-'+secrets.token_hex(8)
        self.cookie, self.csrf = '', ''
        username = 'sw'+secrets.token_hex(6)
        _, headers = call(SERVER, 'POST', '/api/v1/account/register', {'username': username, 'password': self.password}, {'Origin': ORIGIN})
        self.cookie = next(c.split(';')[0].split('=', 1)[1] for c in headers.get_all('Set-Cookie') if c.startswith('cwm_account='))
        self.csrf = self.web('GET', '/api/v1/account')['csrf']
        collector = call(SERVER, 'POST', '/api/v1/register', {})[0]
        self.config = {'endpoint': SERVER, 'token': collector['token'], 'member_id': collector['member_id']}
        self.server = create_server(self.config, self.folder, 0, self.home)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.server.start_device()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.stop_device)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        (self.home/'dashboard.json').write_text(json.dumps({'url': self.base+'/alerts'}))
        self.nonce = self.local('GET', '/api/v1/device/login')['csrf']

    def login(self):
        url = self.local('POST', '/api/v1/device/login', {})['url']
        query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        code = self.web('POST', '/api/v1/device/authorize', {k: query[k] for k in ('redirect_uri', 'challenge', 'name')})['code']
        with OPENER.open(self.base+'/callback?'+urlencode({'code': code, 'state': query['state']}), timeout=30) as response:
            self.assertIn('已登录', response.read().decode())

    def capture(self, name, owner, price, stock):
        raw = dict(session='live', time=time.time(), shop_id=4242, title='Live shop', triggered_by_python=False,
                   market_location=dict(room=5, channel=7), owner=dict(character_id=owner, name='Owner%d' % owner, parser='cw_shop_owner_v1'),
                   items=[dict(item_id=ITEM, slot=1, price_mesos_candidate=price, bundle_quantity_candidate=1, available_quantity_candidate=stock)])
        path = self.folder/name
        path.write_text(json.dumps(raw), encoding='utf-8')
        return {'file': str(path.resolve())}

    def test_device_login_sync_web_run_and_accounting(self):
        from account_device import DeviceClient
        from collector_sweep import SweepEngine
        from sweep_purchase import PurchaseResult, PurchaserStatus
        self.login()
        profile = self.local('GET', '/api/v1/account')
        self.assertTrue(profile['linked'])
        account = profile['public_id']
        self.assertEqual(account, self.web('GET', '/api/v1/account')['public_id'])
        watch = {'kind': 'watch', 'key': str(ITEM), 'version': 0, 'value': {'cap': None, 'notify': True, 'position': 0, 'buyLimit': 5,
                 'groups': [{'id': 'g1', 'name': 'Rule', 'cap': 100, 'notify': False, 'buy': True, 'reminder': {}}]}}
        saved = self.local('POST', '/api/v1/account/data', {'account': account, 'operations': [watch]})
        self.assertEqual([r['key'] for r in saved['records'] if r['kind'] == 'watch'], [str(ITEM)])
        self.assertEqual(self.local('GET', '/api/v1/account/data?'+urlencode({'account': account}))['records'], saved['records'])

        class Purchaser:
            orders = []
            def status(self):
                return PurchaserStatus(True, '', None)
            def buy(self, order, window):
                self.orders.append(order)
                return PurchaseResult('bought', order.quantity, order.quantity*order.price)
        purchaser = Purchaser()
        engine = SweepEngine(self.folder, DeviceClient(self.config, self.home), purchaser, game=lambda: True, dashboard=self.home/'dashboard.json')
        engine.save_settings({'allow_web_start': True, 'max_spend': 100000, 'max_order': 0, 'reserve_mesos': 0})
        device = engine.status()['device']['id']
        listed = self.web('GET', '/api/v1/account/devices')['devices']
        self.assertEqual([d['state']['sweep']['executor']['ready'] for d in listed if d['id'] == device], [True])
        # The desktop shows the account's devices and renames itself through the device token.
        self.assertEqual(engine.devices()['devices'], listed)
        engine.rename({'name': ' 测试电脑 '})
        self.assertEqual(engine.status()['device']['name'], '测试电脑')
        self.assertEqual([d['name'] for d in self.web('GET', '/api/v1/account/devices')['devices'] if d['id'] == device], ['测试电脑'])
        # While idle, the rules table comes from the plan a run started now would freeze.
        engine.refresh_rules()
        rules = engine.status()['sweep']['rules']
        self.assertEqual([(w['item_id'], w['limit']) for w in rules['watches']], [(ITEM, 5)])

        deadline = time.monotonic()+15
        while not self.server.upstream.connected and time.monotonic() < deadline:
            time.sleep(.1)
        self.assertTrue(self.server.upstream.connected, 'device account stream did not connect')
        time.sleep(.5)
        events = socket.create_connection(('127.0.0.1', self.server.server_port), timeout=15)
        events.sendall(f'GET /api/v1/account/events HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n\r\n'.encode())
        reader = events.makefile('rb')
        self.addCleanup(events.close)

        self.web('POST', '/api/v1/account/sweep/start', {'devices': [device], 'budget': 10000, 'minutes': 30, 'current_password': self.password})
        lines = []
        while b'event: sweep\n' not in lines:
            lines.append(reader.readline())
        engine.poll()
        self.assertTrue(engine.buying(), engine.message)
        engine.on_shop_open(self.capture('shop_a.json', 1, 100, 3), 'window')
        engine.on_shop_open(self.capture('shop_b.json', 2, 90, 3), 'window')
        engine.on_shop_open(self.capture('shop_c.json', 3, 80, 3), 'window')
        engine.heartbeat()
        self.assertEqual([o.quantity for o in purchaser.orders], [3, 2], 'buyLimit 5 bounds the second shop; the third is skipped')
        self.assertEqual(engine.status()['sweep']['recent'][0]['reason'], 'item_limit')

        run = self.web('GET', '/api/v1/account/sweep')['run']
        self.assertEqual((run['status'], run['spent'], run['reserved'], run['unknown'], run['remaining']), ('running', 480, 0, 0, 9520))
        self.assertEqual(run['items'], [{'item_id': ITEM, 'limit': 5, 'units': 5, 'bought': 5}])
        self.assertEqual(sorted((p['status'], p['quantity'], p['spent'], p['device']) for p in run['purchases']),
                         [('bought', 2, 180, device), ('bought', 3, 300, device)])
        self.assertEqual([(d['id'], d['state'], d['spent']) for d in run['devices']], [(device, 'active', 480)])
        engine.poll()  # Re-reads the device view, which now carries the run-wide totals.
        here = engine.status()['sweep']
        self.assertEqual((here['run']['spent_here'], here['run']['spent'], here['run']['bought']), (480, 480, 5))
        self.assertEqual(here['run']['items'], run['items'])
        self.assertEqual([(w['item_id'], w['limit']) for w in here['rules']['watches']], [(ITEM, 5)], 'running: rules from the run plan')

        engine.stop_run()
        run = self.web('GET', '/api/v1/account/sweep')['run']
        self.assertEqual((run['status'], run['stop_reason']), ('stopped', 'stopped_on_device'))
        engine.logout()
        self.assertFalse(self.local('GET', '/api/v1/account')['linked'])
        self.assertNotIn(device, [d['id'] for d in self.web('GET', '/api/v1/account/devices')['devices']])


if __name__ == '__main__':
    unittest.main()
