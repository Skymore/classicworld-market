import errno
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import ssl
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collector_network as network
from shared_client import upload_opener


def address(family, name):
    return (family, socket.SOCK_STREAM, 6, '', (name, 443))


class Race:
    def __init__(self, outcomes):
        self.now = 0
        self.outcomes = outcomes
        self.created = []
        self.registered = {}

    def socket(self, *args):
        race = self
        class FakeSocket:
            closed = False
            ready = None
            error = 0
            def setblocking(self, value): pass
            def settimeout(self, value): self.timeout = value
            def bind(self, value): self.bound = value
            def close(self): self.closed = True
            def getsockopt(self, *args): return self.error
            def connect_ex(self, target):
                self.target = target[0]
                self.started = race.now
                outcome = race.outcomes[self.target]
                if outcome == 'fail': return errno.ECONNREFUSED
                if outcome == 'immediate': return 0
                if outcome == 'pending': return errno.EINPROGRESS
                self.ready = race.now + outcome[0]
                self.error = outcome[1]
                return errno.EINPROGRESS
        sock = FakeSocket()
        self.created.append(sock)
        return sock

    def selector(self):
        race = self
        class Selector:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def register(self, sock, events): race.registered[sock] = events
            def unregister(self, sock): del race.registered[sock]
            def select(self, timeout):
                ready_times = [sock.ready for sock in race.registered if sock.ready is not None]
                until = race.now + timeout if timeout is not None else min(ready_times)
                if ready_times: until = min(until, min(ready_times))
                race.now = max(race.now, until)
                return [(SimpleNamespace(fileobj=s), 2) for s in race.registered
                        if s.ready is not None and s.ready <= race.now]
        return Selector()

    def run(self, addresses, timeout=3):
        with ExitStack() as stack:
            stack.enter_context(patch.object(network.socket, 'getaddrinfo', return_value=addresses))
            stack.enter_context(patch.object(network.socket, 'socket', side_effect=self.socket))
            stack.enter_context(patch.object(network.selectors, 'DefaultSelector', side_effect=self.selector))
            stack.enter_context(patch.object(network.time, 'monotonic', side_effect=lambda:self.now))
            return network.connect(('test.invalid',443), timeout)


class ConnectionTests(unittest.TestCase):
    def test_two_stalled_ipv6_addresses_do_not_delay_ipv4_until_timeout(self):
        race=Race({'v6a':'pending','v6b':'pending','v4':(.01,0)})
        result=race.run([address(socket.AF_INET6,'v6a'),address(socket.AF_INET6,'v6b'),address(socket.AF_INET,'v4')])
        self.assertEqual(result.target,'v4')
        self.assertAlmostEqual(result.started,.25)
        self.assertLess(race.now,.3)
        self.assertEqual([s.target for s in race.created],['v6a','v4'])
        self.assertTrue(race.created[0].closed)
        self.assertFalse(result.closed)
        self.assertEqual(result.timeout,3)

    def test_working_ipv6_retains_priority_and_needs_no_ipv4_attempt(self):
        race=Race({'v6':(.02,0),'v4':'immediate'})
        result=race.run([address(socket.AF_INET6,'v6'),address(socket.AF_INET,'v4')])
        self.assertEqual(result.target,'v6')
        self.assertEqual(len(race.created),1)

    def test_stalled_ipv4_can_fall_back_to_ipv6_too(self):
        race=Race({'v4':'pending','v6':'immediate'})
        result=race.run([address(socket.AF_INET,'v4'),address(socket.AF_INET6,'v6')])
        self.assertEqual(result.target,'v6')
        self.assertAlmostEqual(race.now,.25)
        self.assertTrue(race.created[0].closed)

    def test_immediate_failure_does_not_wait_before_next_address(self):
        race=Race({'v6':'fail','v4':'immediate'})
        result=race.run([address(socket.AF_INET6,'v6'),address(socket.AF_INET,'v4')])
        self.assertEqual(result.started,0)
        self.assertTrue(race.created[0].closed)

    def test_late_failure_is_closed_and_remaining_address_can_win(self):
        race=Race({'v6':(.1,errno.ECONNREFUSED),'v4':(.01,0)})
        result=race.run([address(socket.AF_INET6,'v6'),address(socket.AF_INET,'v4')])
        self.assertEqual(result.target,'v4')
        self.assertTrue(race.created[0].closed)

    def test_deadline_closes_all_pending_attempts(self):
        race=Race({'v6':'pending','v4':'pending'})
        with self.assertRaises(TimeoutError):
            race.run([address(socket.AF_INET6,'v6'),address(socket.AF_INET,'v4')],timeout=.4)
        self.assertAlmostEqual(race.now,.4)
        self.assertTrue(all(sock.closed for sock in race.created))

    def test_all_failures_propagate_without_leaking_sockets(self):
        race=Race({'v6':'fail','v4':'fail'})
        with self.assertRaises(ConnectionRefusedError):
            race.run([address(socket.AF_INET6,'v6'),address(socket.AF_INET,'v4')])
        self.assertTrue(all(sock.closed for sock in race.created))

    def test_https_keeps_certificate_hostname_and_proxy_tunnel_behavior(self):
        opener=upload_opener()
        handler=next(h for h in opener.handlers if isinstance(h,network.HTTPSHandler))
        self.assertTrue(handler._context.check_hostname)
        self.assertEqual(handler._context.verify_mode,ssl.CERT_REQUIRED)
        connection=network.HTTPSConnection('proxy.invalid',context=handler._context)
        connection.set_tunnel('mxd.ruit.me',443)
        self.assertEqual(connection._tunnel_host,'mxd.ruit.me')
        self.assertIs(connection._create_connection,network.connect)

    def test_real_http_request_uses_new_connector(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body=b'{"ok":true}'
                self.send_response(200)
                self.send_header('Content-Length',str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self,*args): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with patch.object(network,'connect',wraps=network.connect) as connected:
                with upload_opener().open(f'http://127.0.0.1:{server.server_port}/',timeout=2) as response:
                    self.assertTrue(json.load(response)['ok'])
                connected.assert_called_once()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)


if __name__=='__main__': unittest.main()
