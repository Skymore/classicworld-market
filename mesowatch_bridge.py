"""Loopback-only job bridge to the user's existing Chrome profile.

The extension fetches public market JSON from its meso.watch tab. Browser
credentials stay in Chrome; the private bridge token never enters the page.
"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

PORT = 18767
MAX_BODY = 32 * 1024 * 1024
LIST_URL = 'https://meso.watch/data/list.json'
ITEM_RE = re.compile(r'https://meso\.watch/data/markets/Classic%20World/item/(?:basil|cash)_[0-9]{8}\.json')


class BrowserBlocked(RuntimeError):
    pass


def allowed_url(url):
    return url == LIST_URL or ITEM_RE.fullmatch(url) is not None


def prepare_extension(home, source):
    """Stage reviewable extension files privately; never install or enable it."""
    home, source = Path(home), Path(source)
    home.mkdir(parents=True, exist_ok=True)
    config_path = home / 'bridge.json'
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding='utf-8'))
    else:
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives import serialization
        public = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
        der = public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        key = base64.b64encode(der).decode('ascii')
        extension_id = ''.join(chr(ord('a') + int(n, 16)) for n in hashlib.sha256(der).hexdigest()[:32])
        config = dict(token=secrets.token_urlsafe(32), key=key, extension_id=extension_id, port=PORT)
        config_path.write_text(json.dumps(config), encoding='utf-8')
    destination = home / 'extension'
    destination.mkdir(exist_ok=True)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    manifest['key'] = config['key']
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    for name in ('background.js', 'protocol.js'):
        (destination / name).write_bytes((source / name).read_bytes())
    (destination / 'config.js').write_text('export default ' + json.dumps({
        'endpoint': f"http://127.0.0.1:{config['port']}", 'token': config['token'],
    }) + ';\n', encoding='utf-8')
    return destination, config['extension_id']


class BridgeReader:
    def __init__(self, home, *, delay=2.0, timeout=180, config=None):
        self.home = Path(home)
        self.config = config or json.loads((self.home / 'bridge.json').read_text(encoding='utf-8'))
        self.delay = max(1, delay)
        self.timeout = timeout
        self.condition = threading.Condition()
        self.job = self.result = None
        self.last_request = self.last_browser_seen = 0.0

    def __enter__(self):
        reader = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def authorized(self, preflight=False):
                if self.headers.get('Host') != f'127.0.0.1:{reader.port}':
                    return False
                origin = self.headers.get('Origin')
                expected = 'chrome-extension://' + reader.config['extension_id']
                if origin is not None and origin != expected:
                    return False
                if preflight:
                    return origin == expected
                return secrets.compare_digest(self.headers.get('Authorization', ''),
                                              'Bearer ' + reader.config['token'])

            def send_json(self, status, payload):
                raw = json.dumps(payload, ensure_ascii=True).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Cache-Control', 'no-store')
                origin = self.headers.get('Origin')
                if origin == 'chrome-extension://' + reader.config['extension_id']:
                    self.send_header('Access-Control-Allow-Origin', origin)
                    self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                    self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                    self.send_header('Access-Control-Allow-Private-Network', 'true')
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_OPTIONS(self):
                self.send_json(200 if self.authorized(preflight=True) else 403, {})

            def do_GET(self):
                if not self.authorized():
                    return self.send_json(403, {})
                if self.path != '/next':
                    return self.send_json(404, {})
                with reader.condition:
                    reader.last_browser_seen = time.time()
                    if reader.job is None:
                        reader.condition.wait(timeout=10)
                    job = reader.job
                self.send_json(200, job or {})

            def do_POST(self):
                if not self.authorized():
                    return self.send_json(403, {})
                if self.path != '/result':
                    return self.send_json(404, {})
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= MAX_BODY or self.headers.get('Content-Type') != 'application/json':
                        return self.send_json(413, {})
                    self.connection.settimeout(15)
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict):
                        raise ValueError('Invalid response')
                except (ValueError, OSError):
                    return self.send_json(400, {})
                with reader.condition:
                    if reader.job is None or payload.get('id') != reader.job['id'] or reader.result is not None:
                        return self.send_json(409, {})
                    reader.result = payload
                    reader.job = None
                    reader.last_browser_seen = time.time()
                    reader.condition.notify_all()
                self.send_json(200, {'accepted': True})

        self.server = ThreadingHTTPServer(('127.0.0.1', self.config['port']), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        with self.condition:
            self.job = None
            self.condition.notify_all()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, url):
        if not allowed_url(url):
            raise ValueError('Unexpected data URL')
        remaining = self.delay - (time.monotonic() - self.last_request)
        if remaining > 0:
            time.sleep(remaining)
        self.last_request = time.monotonic()
        with self.condition:
            self.result = None
            self.job = dict(id=secrets.token_hex(16), url=url)
            self.condition.notify_all()
            arrived = self.condition.wait_for(lambda: self.result is not None, timeout=self.timeout)
            self.job = None
            if not arrived:
                raise BrowserBlocked('Waiting for the sync extension in regular Chrome')
            response = self.result
            self.result = None
        if response.get('error'):
            raise BrowserBlocked('Chrome could not read the market page; check its sync tab')
        if response.get('status') in (401, 403, 429) or 'json' not in response.get('type', ''):
            raise BrowserBlocked(f"Browser access requires attention (HTTP {response.get('status')})")
        if response.get('status') != 200:
            raise RuntimeError(f"Source returned HTTP {response.get('status')}")
        return json.loads(response['text'])
