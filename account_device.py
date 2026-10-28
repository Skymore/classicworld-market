"""Collector device login and the device API (SWEEP.md sections 1 and 2).

Browser login uses an authorization code with PKCE S256 and a loopback callback (RFC 8252,
RFC 7636). The device token stays in Python and in DPAPI-protected storage, never in a WebView.
"""
import base64
import ctypes
import hashlib
import html
import json
import os
import re
import secrets
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

TOKEN_FILE = 'device-token.bin'
ENTROPY = b'ClassicWorldMarket device token v1'
TOPICS = ('data', 'sweep', 'devices')
TOKEN = re.compile(r'cwd_[A-Za-z0-9_-]{43}')
CODE = re.compile(r'[A-Za-z0-9_-]{43}')
MAX_RESPONSE = 8*1024*1024


def challenge_for(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()


def pkce():
    verifier = secrets.token_urlsafe(32)
    return verifier, challenge_for(verifier)


def device_name():
    raw = os.environ.get('COMPUTERNAME') or socket.gethostname() or ''
    return ''.join(c for c in raw if c.isprintable()).strip()[:40] or '采集器'


class _Blob(ctypes.Structure):
    _fields_ = [('size', ctypes.c_uint32), ('data', ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect):
    from ctypes import wintypes
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    function = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    function.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.POINTER(_Blob), ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    def blob(value):
        buffer = ctypes.create_string_buffer(value, len(value))
        return _Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer
    source, keep_source = blob(data)
    salt, keep_salt = blob(ENTROPY)
    out = _Blob()
    # CRYPTPROTECT_UI_FORBIDDEN: never show a prompt from a background process.
    if not function(ctypes.byref(source), None, ctypes.byref(salt), None, None, 1, ctypes.byref(out)):
        raise OSError(ctypes.get_last_error(), 'DPAPI failed')
    try:
        return ctypes.string_at(out.data, out.size)
    finally:
        kernel.LocalFree(out.data)


def protect(data):
    return _dpapi(data, True) if os.name == 'nt' else data


def unprotect(data):
    return _dpapi(data, False) if os.name == 'nt' else data


def valid_record(value):
    token, account, device = value['token'], value['account'], value['device']
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('Invalid device token')
    record = dict(token=token,
        account=dict(id=str(account['id'])[:64], nickname=str(account.get('nickname') or '')[:40]),
        device=dict(id=str(device['id'])[:64], name=str(device.get('name') or '')[:40]))
    if not record['account']['id'] or not record['device']['id']:
        raise ValueError('Invalid device identity')
    return record


class TokenStore:
    """The device token record: DPAPI-encrypted on Windows, a 0600 file elsewhere (tests)."""
    def __init__(self, home):
        self.path = Path(home)/TOKEN_FILE
        self.lock = threading.Lock()
        self.cached = (None, None)

    def load(self):
        try:
            stat = self.path.stat()
        except OSError:
            return None
        key = (stat.st_mtime_ns, stat.st_size)
        with self.lock:
            if self.cached[0] == key:
                return self.cached[1]
        try:
            value = valid_record(json.loads(unprotect(self.path.read_bytes())))
        except (OSError, ValueError, TypeError, KeyError):
            value = None
        with self.lock:
            self.cached = (key, value)
        return value

    def save(self, record):
        data = protect(json.dumps(valid_record(record)).encode())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name+'.tmp')
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as out:
            out.write(data)
        os.chmod(temporary, 0o600)
        for attempt in range(20):
            try:
                temporary.replace(self.path)
                break
            except PermissionError:  # Another process briefly holds a read handle.
                if attempt == 19:
                    raise
                time.sleep(.025)
        with self.lock:
            self.cached = (None, None)

    def clear(self):
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        with self.lock:
            self.cached = (None, None)


class DeviceError(Exception):
    """An HTTP rejection from the API; network failures stay OSError."""
    def __init__(self, status, body):
        self.status = status
        self.body = body if isinstance(body, dict) else {}
        self.code = str(self.body.get('error') or 'unavailable')
        super().__init__(f'{status} {self.code}')


class DeviceClient:
    def __init__(self, config, home, opener=None):
        self._config = config  # dict, or a callable while the collector identity loads
        self.store = TokenStore(home)
        self.opener = opener

    def configuration(self):
        return self._config() if callable(self._config) else self._config

    def endpoint(self):
        from collector_dashboard import safe_endpoint
        return safe_endpoint(self.configuration()['endpoint'])

    def record(self):
        return self.store.load()

    def token(self):
        record = self.record()
        return record['token'] if record else None

    def collector_token(self):
        return self.configuration().get('token')

    def _open(self, request, timeout):
        if self.opener is None:
            from shared_client import upload_opener
            self.opener = upload_opener()
        return self.opener.open(request, timeout=timeout)

    def send(self, method, path, body=None, bearer=None, timeout=10):
        import urllib.error
        import urllib.request
        headers = {'Accept': 'application/json'}
        if bearer:
            headers['Authorization'] = 'Bearer '+bearer
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.endpoint()+path, data=data, headers=headers, method=method)
        try:
            with self._open(request, timeout) as response:
                raw = response.read(MAX_RESPONSE+1)
        except urllib.error.HTTPError as error:
            try:
                answer = json.loads(error.read(4096))
            except (ValueError, OSError):
                answer = {}
            raise DeviceError(error.code, answer) from None
        try:
            if len(raw) > MAX_RESPONSE:
                raise ValueError('Response too large')
            return json.loads(raw)
        except ValueError:
            raise OSError('Invalid API response') from None

    def call(self, method, path, body=None, timeout=10):
        """A device-token request. A 401 means the token is gone, so it is forgotten."""
        token = self.token()
        if not token:
            raise DeviceError(401, {'error': 'login_required'})
        try:
            return self.send(method, path, body, token, timeout)
        except DeviceError as error:
            if error.status == 401 and self.token() == token:
                self.store.clear()
            raise

    def public(self, path, timeout=10):
        return self.send('GET', path, bearer=self.collector_token(), timeout=timeout)

    def exchange(self, code, verifier, redirect_uri):
        from collector_update import VERSION
        record = self.send('POST', '/api/v1/device/token', dict(code=code, verifier=verifier,
            redirect_uri=redirect_uri, client_version=VERSION), bearer=self.collector_token(), timeout=20)
        self.store.save(record)
        return self.record()

    def migrate(self):
        """An old linked collector receives a device token once, without a browser login."""
        if self.token() or not self.collector_token():
            return None
        try:
            record = self.send('POST', '/api/v1/device/migrate', {}, bearer=self.collector_token(), timeout=20)
        except DeviceError:
            return None
        if not self.token():
            self.store.save(record)
        return self.record()

    def logout(self):
        token = self.token()
        try:
            if token:
                self.send('POST', '/api/v1/device/logout', {}, token, timeout=8)
        except (OSError, DeviceError):
            pass  # Signing out locally still succeeds; the server expires unused tokens.
        finally:
            if self.token() == token:
                self.store.clear()

    def open_events(self):
        import urllib.error
        import urllib.request
        token = self.token()
        if not token:
            return None
        request = urllib.request.Request(self.endpoint()+'/api/v1/account/events',
            headers={'Authorization': 'Bearer '+token, 'Accept': 'text/event-stream'})
        try:
            response = self._open(request, 45)
        except urllib.error.HTTPError as error:
            if error.code == 401 and self.token() == token:
                self.store.clear()
            raise DeviceError(error.code, {}) from None
        if 'text/event-stream' not in response.headers.get('Content-Type', ''):
            response.close()
            raise OSError('Expected event stream')
        return response, lambda: self.token() == token


def read_events(response, current=lambda: True):
    """Yield SSE event names. Data is always {} and comments only keep the stream alive."""
    name = None
    while current():
        line = response.readline(65537)
        if not line:
            return
        if len(line) > 65536:
            raise ValueError('Event line too long')
        text = line.decode('utf-8', 'replace').rstrip('\r\n')
        if not text:
            if name:
                yield name
            name = None
        elif text.startswith('event:'):
            name = text[6:].strip()[:32]


class EventStream:
    """Follow one SSE stream. Reconnects after 1, 2, 4 ... 30 s; while disconnected every
    topic is reported each 30 s so subscribers re-read the APIs."""
    def __init__(self, connect, on_event, stop=None):
        self.connect = connect  # () -> (response, still_current) | None when signed out
        self.on_event = on_event
        self.stop = stop or threading.Event()
        self.connected = False

    def start(self):
        thread = threading.Thread(target=self.run, name='account-events', daemon=True)
        thread.start()
        return thread

    def close(self):
        self.stop.set()

    def emit(self, name):
        try:
            self.on_event(name)
        except Exception:
            pass

    def run(self):
        delay, polled = 1, time.monotonic()
        while not self.stop.is_set():
            opened = failed = None
            try:
                opened = self.connect()
            except Exception:
                failed = True
            if opened is None and not failed:
                delay, polled = 1, time.monotonic()
                self.stop.wait(2)
                continue
            if opened:
                response, current = opened
                try:
                    with response:
                        for name in read_events(response, current):
                            if self.stop.is_set():
                                break
                            if name == 'hello':
                                delay, self.connected = 1, True
                                for topic in TOPICS:  # Catch up on anything missed while away.
                                    self.emit(topic)
                            elif name in TOPICS:
                                self.emit(name)
                except Exception:
                    pass
                finally:
                    if self.connected:  # Polling restarts from the moment the stream dropped.
                        polled = time.monotonic()
                    self.connected = False
            if time.monotonic()-polled >= 30:
                polled = time.monotonic()
                for topic in TOPICS:
                    self.emit(topic)
            self.stop.wait(delay)
            delay = min(delay*2, 30)


class DeviceLogin:
    """One pending browser login; the loopback /callback answers only while it is pending."""
    TTL = 900

    def __init__(self, client, name=None):
        self.client = client
        self.name = name or device_name()
        self.redirect_uri = None
        self.lock = threading.Lock()
        self.pending = None

    def begin(self):
        if not self.redirect_uri:
            raise ValueError('Login callback unavailable')
        verifier, challenge = pkce()
        state = secrets.token_urlsafe(32)
        with self.lock:
            self.pending = dict(state=state, verifier=verifier, expires=time.monotonic()+self.TTL)
        return self.client.endpoint()+'/device?'+urlencode(dict(redirect_uri=self.redirect_uri,
            state=state, challenge=challenge, name=self.name))

    def active(self):
        with self.lock:
            return bool(self.pending and time.monotonic() < self.pending['expires'])

    def finish(self, query):
        """(ok, message) for a callback, or None when no login is pending."""
        failed = (False, '登录未完成，请回到采集器重新登录')
        state = query.get('state', [''])[0]
        with self.lock:
            pending = self.pending
            if not pending or time.monotonic() >= pending['expires']:
                self.pending = None
                return None
            # A forged callback must not cancel the real pending login.
            if not secrets.compare_digest(state.encode(), pending['state'].encode()):
                return failed
            self.pending = None
        if query.get('error'):
            return False, '已取消登录'
        code = query.get('code', [''])[0]
        if not CODE.fullmatch(code):
            return failed
        try:
            self.client.exchange(code, pending['verifier'], self.redirect_uri)
        except (OSError, ValueError, KeyError, TypeError, DeviceError):
            return failed
        return True, '已登录，可以关闭此页'


def callback_page(ok, message):
    title = '已登录' if ok else '登录未完成'
    return (f'<!doctype html><html lang="zh"><meta charset="utf-8"><title>{title}</title>'
            f'<body style="font:16px system-ui,sans-serif;margin:4em 1em;text-align:center">'
            f'<p>{html.escape(message)}</p></body></html>').encode()
