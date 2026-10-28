import base64
import hashlib
import io
import json
import os
import re
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch
import account_device
from account_device import (DeviceClient, DeviceError, DeviceLogin, EventStream, TokenStore,
                            challenge_for, pkce, read_events)

TOKEN = 'cwd_'+'A'*43
RECORD = dict(token=TOKEN, account=dict(id='acct-1', nickname='Tester'), device=dict(id='dev-1', name='PC'))


class Clock:
    def __init__(self):
        self.now = 1000.0
    def __call__(self):
        return self.now


class Stop:
    """Stops after `limit` waits; each wait advances the fake clock instead of sleeping."""
    def __init__(self, clock, limit):
        self.clock, self.limit, self.waits, self.flag = clock, limit, [], False
    def is_set(self):
        return self.flag
    def set(self):
        self.flag = True
    def wait(self, seconds):
        self.waits.append(seconds)
        self.clock.now += seconds
        self.flag = self.flag or len(self.waits) >= self.limit
        return self.flag


class Response(io.BytesIO):
    headers = {'Content-Type': 'text/event-stream'}


class PkceAndLoginTests(unittest.TestCase):
    def test_pkce_is_s256_base64url_without_padding(self):
        verifier, challenge = pkce()
        self.assertRegex(verifier, r'^[A-Za-z0-9_-]{43}$')
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(challenge, expected)
        self.assertEqual(len(challenge), 43)
        self.assertNotEqual(pkce()[0], verifier)

    def login(self):
        client = Mock()
        client.endpoint.return_value = 'https://mxd.ruit.me'
        login = DeviceLogin(client, name='书房电脑')
        login.redirect_uri = 'http://127.0.0.1:8780/callback'
        url = login.begin()
        query = dict(re.findall(r'([a-z_]+)=([^&]+)', url.split('?', 1)[1]))
        return client, login, url, query

    def test_begin_builds_device_url_with_loopback_redirect(self):
        client, login, url, query = self.login()
        self.assertTrue(url.startswith('https://mxd.ruit.me/device?'))
        self.assertEqual(query['redirect_uri'], 'http%3A%2F%2F127.0.0.1%3A8780%2Fcallback')
        self.assertEqual(query['challenge'], challenge_for(login.pending['verifier']))
        self.assertEqual(query['state'], login.pending['state'])
        self.assertTrue(login.active())
        with self.assertRaises(ValueError):
            DeviceLogin(client).begin()  # No loopback port yet.

    def test_callback_validates_state_code_and_is_single_use(self):
        client, login, url, query = self.login()
        state, code = login.pending['state'], 'C'*43
        self.assertEqual(login.finish({'state': ['wrong'], 'code': [code]})[0], False)
        self.assertTrue(login.active(), 'a forged callback cannot cancel the real login')
        client.exchange.assert_not_called()
        self.assertEqual(login.finish({'state': [state], 'code': [code]}), (True, '已登录，可以关闭此页'))
        client.exchange.assert_called_once()
        self.assertEqual(client.exchange.call_args.args, (code, client.exchange.call_args.args[1], 'http://127.0.0.1:8780/callback'))
        self.assertIsNone(login.finish({'state': [state], 'code': [code]}), 'no replay after completion')

    def test_cancel_bad_code_failed_exchange_and_expiry(self):
        client, login, _, _ = self.login()
        self.assertEqual(login.finish({'state': [login.pending['state']], 'error': ['access_denied']}), (False, '已取消登录'))
        self.assertFalse(login.active())
        login.begin()
        self.assertFalse(login.finish({'state': [login.pending['state']], 'code': ['short']})[0])
        login.begin()
        client.exchange.side_effect = DeviceError(400, {'error': 'invalid_grant'})
        self.assertFalse(login.finish({'state': [login.pending['state']], 'code': ['C'*43]})[0])
        login.begin()
        login.pending['expires'] = time.monotonic()-1
        self.assertIsNone(login.finish({'state': [login.pending['state']], 'code': ['C'*43]}))

    def test_callback_page_escapes_message(self):
        self.assertIn(b'&lt;b&gt;', account_device.callback_page(False, '<b>'))


class TokenStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = TokenStore(self.temp.name)

    def test_round_trip_clear_and_private_file(self):
        self.assertIsNone(self.store.load())
        self.store.save(RECORD)
        self.assertEqual(self.store.load(), RECORD)
        if os.name != 'nt':
            self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.store.clear()
        self.assertIsNone(self.store.load())
        self.store.clear()

    def test_another_process_update_is_seen_and_garbage_is_ignored(self):
        self.store.save(RECORD)
        other = TokenStore(self.temp.name)
        changed = dict(RECORD, token='cwd_'+'B'*43)
        other.save(changed)
        os.utime(self.store.path, ns=(1, time.time_ns()+10**9))
        self.assertEqual(self.store.load()['token'], changed['token'])
        self.store.path.write_bytes(b'not json')
        self.assertIsNone(self.store.load())
        for bad in [dict(RECORD, token='cwd_short'), dict(RECORD, account={'id': ''}), {'token': TOKEN}]:
            with self.assertRaises((ValueError, KeyError)):
                self.store.save(bad)

    def test_record_on_disk_is_the_protected_form(self):
        with patch.object(account_device, 'protect', side_effect=lambda b: b'P'+b[::-1]), \
             patch.object(account_device, 'unprotect', side_effect=lambda b: b[1:][::-1]):
            self.store.save(RECORD)
            raw = self.store.path.read_bytes()
            self.assertNotIn(TOKEN.encode(), raw)
            self.assertEqual(TokenStore(self.temp.name).load(), RECORD)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.opener = Mock()
        self.client = DeviceClient({'endpoint': 'https://mxd.ruit.me', 'token': 'collector-secret'}, self.temp.name, self.opener)

    def answer(self, value):
        response = Mock()
        response.read.return_value = json.dumps(value).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def http_error(self, code, body):
        return urllib.error.HTTPError('https://mxd.ruit.me/x', code, 'error', {}, io.BytesIO(json.dumps(body).encode()))

    def test_exchange_sends_collector_bearer_version_and_stores_token(self):
        self.opener.open.return_value = self.answer(RECORD)
        self.assertEqual(self.client.exchange('C'*43, 'v'*43, 'http://127.0.0.1:1/callback'), RECORD)
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://mxd.ruit.me/api/v1/device/token')
        self.assertEqual(request.get_header('Authorization'), 'Bearer collector-secret')
        body = json.loads(request.data)
        self.assertEqual(set(body), {'code', 'verifier', 'redirect_uri', 'client_version'})
        self.assertEqual(self.client.token(), TOKEN)

    def test_rejections_carry_codes_and_401_forgets_the_token(self):
        self.client.store.save(RECORD)
        self.opener.open.side_effect = self.http_error(409, {'error': 'sync_conflict'})
        with self.assertRaises(DeviceError) as error:
            self.client.call('POST', '/api/v1/device/data', {'operations': []})
        self.assertEqual((error.exception.status, error.exception.code), (409, 'sync_conflict'))
        self.assertEqual(self.client.token(), TOKEN)
        self.assertEqual(self.opener.open.call_args.args[0].get_header('Authorization'), 'Bearer '+TOKEN)
        self.opener.open.side_effect = self.http_error(401, {'error': 'login_required'})
        with self.assertRaises(DeviceError):
            self.client.call('GET', '/api/v1/device/account')
        self.assertIsNone(self.client.token())
        with self.assertRaises(DeviceError) as error:
            self.client.call('GET', '/api/v1/device/account')
        self.assertEqual(error.exception.status, 401)

    def test_logout_clears_locally_even_when_offline_and_migrate_only_once(self):
        self.client.store.save(RECORD)
        self.opener.open.side_effect = OSError('offline')
        self.client.logout()
        self.assertIsNone(self.client.token())
        self.opener.open.side_effect = None
        self.opener.open.return_value = self.answer(RECORD)
        self.assertEqual(self.client.migrate(), RECORD)
        self.assertEqual(self.opener.open.call_args.args[0].full_url, 'https://mxd.ruit.me/api/v1/device/migrate')
        self.opener.open.reset_mock()
        self.client.migrate()
        self.opener.open.assert_not_called()
        self.client.store.clear()
        self.opener.open.side_effect = self.http_error(401, {'error': 'login_required'})
        self.assertIsNone(self.client.migrate())

    def test_endpoint_must_be_official_or_loopback(self):
        client = DeviceClient({'endpoint': 'https://evil.example'}, self.temp.name, self.opener)
        with self.assertRaises(ValueError):
            client.send('GET', '/api/v1/device/account')


class EventTests(unittest.TestCase):
    def test_parser_reads_names_ignores_comments_and_data(self):
        stream = Response(b': keepalive\n\nevent: hello\ndata: {}\n\nevent: sweep\r\ndata: {}\r\n\r\ndata: {}\n\nevent: data\n\n')
        self.assertEqual(list(read_events(stream)), ['hello', 'sweep', 'data'])
        with self.assertRaises(ValueError):
            list(read_events(Response(b'event: '+b'x'*70000+b'\n')))

    def test_parser_stops_when_the_token_changes(self):
        current = iter([True, False])
        self.assertEqual(list(read_events(Response(b'event: sweep\n\nevent: data\n\n'), lambda: next(current))), [])

    def test_reconnect_backoff_and_polling_while_disconnected(self):
        clock = Clock()
        stop = Stop(clock, 9)
        seen = []
        with patch('account_device.time.monotonic', clock):
            EventStream(Mock(side_effect=OSError('down')), lambda name: seen.append((clock.now, name)), stop).run()
        self.assertEqual(stop.waits, [1, 2, 4, 8, 16, 30, 30, 30, 30])
        polls = sorted({at for at, _ in seen})
        self.assertTrue(len(polls) >= 3 and all(b-a >= 30 for a, b in zip(polls, polls[1:])))
        self.assertEqual({name for _, name in seen}, {'data', 'sweep', 'devices'})

    def test_hello_resets_backoff_and_catches_up(self):
        clock = Clock()
        stop = Stop(clock, 4)
        streams = [OSError('down'), OSError('down'), (Response(b'event: hello\n\nevent: sweep\n\n'), lambda: True), OSError('down')]
        seen = []
        def connect():
            item = streams.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        with patch('account_device.time.monotonic', clock):
            EventStream(connect, seen.append, stop).run()
        self.assertEqual(stop.waits, [1, 2, 1, 2])
        self.assertEqual(seen, ['data', 'sweep', 'devices', 'sweep'])

    def test_signed_out_stream_idles_without_polling(self):
        clock = Clock()
        stop = Stop(clock, 3)
        seen = []
        with patch('account_device.time.monotonic', clock):
            EventStream(lambda: None, seen.append, stop).run()
        self.assertEqual(stop.waits, [2, 2, 2])
        self.assertEqual(seen, [])


if __name__ == '__main__':
    unittest.main()
