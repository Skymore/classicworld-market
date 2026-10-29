"""Race resolved TCP addresses; urllib still owns proxies, HTTP and TLS checks.

Use RFC 8305-style address interleaving and a 250 ms attempt delay. A broken
IPv6 route must not consume the whole request deadline before IPv4 is tried.
DNS and the complete request remain bounded by collector_http's worker.
"""
from collections import deque
import errno
import http.client
import os
import selectors
import socket
import time
import urllib.request

ATTEMPT_DELAY = .25
PENDING = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY,
           getattr(errno, 'WSAEWOULDBLOCK', 10035), getattr(errno, 'WSAEINPROGRESS', 10036)}


def interleave(addresses):
    groups = {}
    for address in addresses:
        group = groups.setdefault(address[0], deque())
        if address not in group:
            group.append(address)
    while any(groups.values()):
        for group in groups.values():
            if group:
                yield group.popleft()


def connect(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    if timeout is socket._GLOBAL_DEFAULT_TIMEOUT:
        timeout = socket.getdefaulttimeout()
    addresses = deque(interleave(socket.getaddrinfo(*address, 0, socket.SOCK_STREAM)))
    if not addresses:
        raise OSError('No addresses returned')
    deadline = None if timeout is None else time.monotonic() + timeout
    next_attempt = 0
    pending = set()
    winner = None
    last_error = OSError('No connection succeeded')
    with selectors.DefaultSelector() as selector:
        try:
            while addresses or pending:
                now = time.monotonic()
                if deadline is not None and now >= deadline:
                    raise TimeoutError('TCP connection timed out')
                if addresses and (not pending or now >= next_attempt):
                    family, kind, protocol, _, target = addresses.popleft()
                    sock = None
                    try:
                        sock = socket.socket(family, kind, protocol)
                        sock.setblocking(False)
                        if source_address:
                            sock.bind(source_address)
                        result = sock.connect_ex(target)
                        if result == 0:
                            sock.settimeout(timeout)
                            winner = sock
                            return sock
                        if result not in PENDING:
                            raise OSError(result, os.strerror(result))
                        selector.register(sock, selectors.EVENT_WRITE)
                        pending.add(sock)
                    except OSError as error:
                        last_error = error
                        if sock is not None:
                            sock.close()
                    next_attempt = time.monotonic() + ATTEMPT_DELAY
                if not pending:
                    continue
                waits = []
                now = time.monotonic()
                if addresses:
                    waits.append(max(0, next_attempt - now))
                if deadline is not None:
                    waits.append(max(0, deadline - now))
                for key, _ in selector.select(min(waits) if waits else None):
                    sock = key.fileobj
                    error = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                    selector.unregister(sock)
                    pending.remove(sock)
                    if not error:
                        try:
                            sock.settimeout(timeout)
                        except OSError:
                            sock.close()
                            raise
                        winner = sock
                        return sock
                    last_error = OSError(error, os.strerror(error))
                    sock.close()
            raise last_error
        finally:
            for sock in pending:
                if sock is not winner:
                    sock.close()


class HTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect


class HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect


class HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, request):
        return self.do_open(HTTPConnection, request)


class HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(HTTPSConnection, request, context=self._context)
