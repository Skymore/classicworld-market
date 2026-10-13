"""Loopback-only personal alerts UI; collector credentials never enter the browser."""
from collections import OrderedDict
import json
import hashlib
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent
ASSETS = ('market_ui.js', 'market_ui.css', 'market_i18n.js', 'market_watchlist.js')


def safe_endpoint(value):
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('Unsupported shared endpoint')
    if parsed.scheme == 'https' and parsed.hostname == 'mxd.ruit.me' and parsed.port in (None, 443):
        return value.rstrip('/')
    if parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port and 1 <= parsed.port <= 65535:
        return value.rstrip('/')
    raise ValueError('Unsupported shared endpoint')


class Gateway:
    def __init__(self, config, folder):
        from shared_client import upload_opener
        self.endpoint = safe_endpoint(config['endpoint'])
        self.token = config['token']
        self.namespace = config.get('member_id') or hashlib.sha256(self.token.encode()).hexdigest()[:16]
        self.folder = Path(folder)
        self.opener = upload_opener()
        self.cache = OrderedDict()
        self.lock = threading.RLock()
        self.last_error = False

    def fetch(self, path, ttl):
        import urllib.request
        with self.lock:
            previous = self.cache.get(path)
            if previous and time.monotonic()-previous[0] < ttl:
                return previous[1]
            try:
                request = urllib.request.Request(self.endpoint+path,
                    headers={'Authorization': 'Bearer '+self.token})
                with self.opener.open(request, timeout=30) as response:
                    raw = response.read(64*1024*1024+1)
                if len(raw) > 64*1024*1024:
                    raise ValueError('Shared response too large')
                data = json.loads(raw)
                self.cache[path] = (time.monotonic(), data)
                self.cache.move_to_end(path)
                while len(self.cache) > 128:
                    self.cache.popitem(last=False)
                self.last_error = False
                return data
            except Exception:
                self.last_error = True
                if previous:
                    return previous[1]
                raise

    def market(self, query):
        window = query.get('hours', ['72'])[0]
        if window not in ('72', 'all'):
            raise ValueError('Invalid quote window')
        args = {'hours': window}
        item = query.get('item_id', [''])[0]
        if item:
            if not item.isdecimal() or not 1000000 <= int(item) <= 5999999:
                raise ValueError('Invalid item ID')
            args['item_id'] = item
        elif query.get('summary') == ['1']:
            args['summary'] = '1'
        result = dict(self.fetch('/api/v1/market?'+urlencode(args), 15))
        if item:
            return result
        result.update(shared=True, personal_alerts=True, realtime=False, capture=None,
                      health={'errors': []}, alert_namespace=self.namespace)
        try:
            packet = self.fetch('/api/v1/collector/alerts?hours='+window, 5)
            result['opportunities'] = packet['opportunities']
        except Exception:
            result['opportunities'] = []
        state, message = 'ready', '个人低价提醒 · 等待打开摊位'
        try:
            capture = json.loads((self.folder/'passive_status.json').read_text(encoding='utf-8'))
            if time.time()-capture['time'] >= 10:
                state, message = 'offline', '个人低价提醒 · 采集器未连接'
            elif capture.get('decoding'):
                message = '个人低价提醒 · 正在采集'
        except (OSError, ValueError, KeyError, TypeError):
            state, message = 'offline', '个人低价提醒 · 采集器未连接'
        if self.last_error:
            state, message = 'offline', '共享服务暂不可用，保留上次数据'
        result['connection_health'] = dict(state=state, message=message)
        result['dedup_note'] = '报价共享；低价提醒只来自当前采集身份的新观察'
        return result


def create_server(config, folder, port=8780):
    gateway = Gateway(config, folder)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            other = f'http://localhost:{self.server.server_port}'
            if self.headers.get('Host') not in (origin[7:], other[7:]):
                self.send_error(403)
                return
            if self.headers.get('Origin') not in (None, origin, other):
                self.send_error(403)
                return
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            try:
                if parsed.path in ('/', '/alerts'):
                    body = (ROOT/'market_index.html').read_text(encoding='utf-8')
                    body = body.replace('<body>', '<body class="alerts-page">' if parsed.path == '/alerts' else '<body class="market-page">')
                    body = body.encode('utf-8')
                    kind = 'text/html; charset=utf-8'
                elif parsed.path[1:] in ASSETS:
                    asset = parsed.path[1:]
                    body = (ROOT/asset).read_bytes()
                    kind = 'text/css; charset=utf-8' if asset.endswith('.css') else 'text/javascript; charset=utf-8'
                elif parsed.path == '/healthz':
                    body = b'{"ok":true,"personal_dashboard":true}'
                    kind = 'application/json; charset=utf-8'
                else:
                    if parsed.path == '/api/v1/market':
                        result = gateway.market(query)
                    elif parsed.path == '/api/v1/watchlist/catalog':
                        result = gateway.fetch('/api/v1/watchlist/catalog?'+urlencode({'q': query.get('q', [''])[0][:100]}), 60)
                    elif parsed.path == '/api/v1/watchlist/listings':
                        from market_watchlist import parse_item_ids
                        ids = query.get('ids', [''])[0]
                        parse_item_ids(ids)
                        result = gateway.fetch('/api/v1/watchlist/listings?'+urlencode({'ids': ids}), 15)
                    elif parsed.path.startswith('/api/v1/items/'):
                        item = parsed.path.rsplit('/', 1)[-1]
                        if not item.isdecimal() or not 1000000 <= int(item) <= 5999999:
                            raise ValueError('Invalid item ID')
                        result = gateway.fetch('/api/v1/items/'+item, 3600)
                    else:
                        self.send_error(404)
                        return
                    body = json.dumps(result, ensure_ascii=False).encode('utf-8')
                    kind = 'application/json; charset=utf-8'
            except ValueError:
                self.send_error(400, 'Invalid request')
                return
            except Exception:
                self.send_error(503, 'Shared service unavailable; retry shortly')
                return
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    try:
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError as error:
        if not port or error.errno not in (48, 98, 10048):
            raise
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    return server


def run(home, config, folder, port=8780, instance=''):
    import os
    server = create_server(config, folder, port)
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    ready = dict(url=f'http://127.0.0.1:{server.server_port}/alerts', pid=os.getpid(),
                 instance=instance, started_at=time.time())
    temporary = home/'dashboard.json.tmp'
    temporary.write_text(json.dumps(ready), encoding='utf-8')
    temporary.replace(home/'dashboard.json')
    print('Personal alerts: '+ready['url'], flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
