"""Loopback-only personal alerts UI; collector credentials never enter the browser."""
from collections import OrderedDict
import json
import hashlib
from pathlib import Path
import queue
import threading
import time
import secrets
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit
import web_assets

ROOT = Path(__file__).resolve().parent
ASSETS = ('market_ui.js', 'market_ui.css', 'market_i18n.js', 'market_watchlist.js')
BRIDGE_ORIGINS={'https://mxd.ruit.me','http://127.0.0.1:8766','http://localhost:8766'}
BRIDGE_PATHS={'/api/v1/collector/status','/api/v1/collector/watch-listings'}


class Relay:
    """Fan the device's one upstream account stream out to local pages and the sweep engine."""
    def __init__(self, limit=32):
        self.lock = threading.Lock()
        self.queues = set()
        self.limit = limit

    def broadcast(self, name):
        from account_device import TOPICS
        if name not in TOPICS and name is not None:
            return
        with self.lock:
            for subscriber in self.queues:
                try:
                    subscriber.put_nowait(name)
                except queue.Full:
                    pass

    def close(self):
        self.broadcast(None)

    def serve(self, handler):
        subscriber = queue.Queue(64)
        with self.lock:
            if len(self.queues) >= self.limit:
                raise OverflowError('Too many local event streams')
            self.queues.add(subscriber)
        try:
            handler.send_response(200)
            handler.send_header('Content-Type', 'text/event-stream')
            handler.send_header('Cache-Control', 'no-store')
            handler.send_header('X-Content-Type-Options', 'nosniff')
            handler.end_headers()
            frame = b'event: hello\ndata: {}\n\n'
            while True:
                handler.wfile.write(frame)
                handler.wfile.flush()
                try:
                    name = subscriber.get(timeout=15)
                except queue.Empty:
                    frame = b': keepalive\n\n'
                    continue
                if name is None:
                    return
                frame = f'event: {name}\ndata: {{}}\n\n'.encode()
        except OSError:
            pass  # The page went away.
        finally:
            with self.lock:
                self.queues.discard(subscriber)


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

    def fetch(self, path, ttl, timeout=30):
        import urllib.request
        with self.lock:
            previous = self.cache.get(path)
            if previous and time.monotonic()-previous[0] < ttl:
                return previous[1]
            try:
                request = urllib.request.Request(self.endpoint+path,
                    headers={'Authorization': 'Bearer '+self.token})
                with self.opener.open(request, timeout=timeout) as response:
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

    def update(self, path, data):
        import urllib.request
        request=urllib.request.Request(self.endpoint+path,data=json.dumps(data).encode(),
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'},method='POST')
        with self.opener.open(request,timeout=20) as response:
            result=json.load(response)
        with self.lock:self.cache.clear()
        return result

    def status(self,now=None):
        now=time.time() if now is None else now
        state='offline';capture={}
        try:
            capture=json.loads((self.folder/'passive_status.json').read_text(encoding='utf-8'))
            if not isinstance(capture,dict):capture={}
            fresh=0<=now-float(capture['time'])<10
            if fresh:
                if capture.get('failed',0) and not capture.get('decoding',0):state='parse_error'
                elif capture.get('decoding',0):state='capturing' if isinstance(capture.get('last_shop_at'),(int,float)) and capture['last_shop_at']>0 and 0<=now-capture['last_shop_at']<=120 else 'connected'
                elif capture.get('connections',0):state='handshake'
                else:state='waiting'
                if capture.get('health_state') in ('no_game','no_inbound','handshake') and not capture.get('decoding',0):state=capture['health_state']
        except (OSError,ValueError,KeyError,TypeError):pass
        location=capture.get('location')
        # Older running collectors wrote map metadata separately. Read only the
        # latest bounded record; do not restart capture or expose raw evidence.
        if 'location' not in capture:
            try:
                with (self.folder/'map_observations.jsonl').open('rb') as source:
                    source.seek(0,2);size=source.tell();source.seek(max(0,size-8192));tail=source.read()
                last=json.loads(tail.splitlines()[-1]);location=last.get('location')
            except (OSError,ValueError,IndexError,TypeError):location=None
        if not isinstance(location,dict) or not all(type(location.get(k)) is int for k in ('channel','room')):location=None
        if location:location={key:location[key] for key in ('channel','room')}
        return dict(collector_id=self.namespace,local_collector=True,checked_at=now,
                    last_shop_at=capture.get('last_shop_at'),location=location,
                    connection_health=dict(state=state),
                    capture={key:capture.get(key) for key in ('time','mode','connections','decoding','failed','frames')})

    def stream_events(self, handler):
        import urllib.request
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler
        writer_lock=threading.Lock();closed=threading.Event()
        def emit(frame):
            if closed.is_set():return
            try:
                with writer_lock:handler.wfile.write(frame);handler.wfile.flush()
            except OSError:closed.set()
        def emit_status():emit(('event: collector\ndata: '+json.dumps(self.status())+'\n\n').encode())
        class Changes(FileSystemEventHandler):
            def on_any_event(inner,event):
                if Path(getattr(event,'dest_path','') or event.src_path).name=='passive_status.json':emit_status()
        request=urllib.request.Request(self.endpoint+'/api/v1/events',headers={'Authorization':'Bearer '+self.token,'Accept':'text/event-stream'})
        with self.opener.open(request,timeout=30) as response:
            if 'text/event-stream' not in response.headers.get('Content-Type',''):raise ValueError('Expected event stream')
            handler.send_response(200);handler.send_header('Content-Type','text/event-stream');handler.send_header('Cache-Control','no-store');handler.send_header('X-Accel-Buffering','no');handler.end_headers()
            emit_status();observer=Observer()
            if self.folder.exists():observer.schedule(Changes(),str(self.folder),recursive=False)
            observer.start()
            try:
                frame=bytearray()
                while not closed.is_set():
                    line=response.readline(65537)
                    if not line:return
                    frame.extend(line)
                    if len(frame)>65536:raise ValueError('Event frame too large')
                    if line in (b'\n',b'\r\n'):
                        if b'event: market' in frame:
                            with self.lock:self.cache.clear()
                        emit(bytes(frame));frame.clear()
            finally:closed.set();observer.stop();observer.join(timeout=2)

    def market(self, query):
        window = query.get('hours', ['72'])[0]
        if window not in ('1','6','24','48','72','168','all'):
            raise ValueError('Invalid quote window')
        args = {'hours': window}
        item = query.get('item_id', [''])[0]
        if item:
            if not item.isdecimal() or not 1000000 <= int(item) <= 5999999:
                raise ValueError('Invalid item ID')
            args['item_id'] = item
        elif query.get('view') == ['list']:
            args['view'] = 'list'
        elif query.get('summary') == ['1']:
            args['summary'] = '1'
        result = dict(self.fetch('/api/v1/market?'+urlencode(args), 0))
        if item:
            return result
        result.update(shared=True, personal_alerts=True, realtime=True, capture=None,
                      health={'errors': []}, alert_namespace=self.namespace)
        try:
            packet = self.fetch('/api/v1/collector/alerts?hours='+window, 0)
            result['opportunities'] = packet['opportunities']
        except Exception:
            result['opportunities'] = []
        result['connection_health']=self.status()['connection_health']
        result['dedup_note'] = '报价共享；低价提醒只来自当前采集身份的新观察'
        return result


def create_server(config, folder, port=8780, home=None):
    from account_device import DeviceClient, DeviceError, DeviceLogin, EventStream, callback_page
    gateway = Gateway(config, folder)
    device = DeviceClient(config, home or folder)
    login = DeviceLogin(device)
    relay = Relay()
    upstream = EventStream(device.open_events, relay.broadcast)
    ui_nonce = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def allow_origin(self):
            self.bridge_origin=None
            origin = f'http://127.0.0.1:{self.server.server_port}'
            other = f'http://localhost:{self.server.server_port}'
            if self.headers.get('Host') not in (origin[7:], other[7:]):
                self.send_error(403)
                return False
            incoming=self.headers.get('Origin')
            if incoming not in (None, origin, other):
                if incoming in BRIDGE_ORIGINS and urlsplit(self.path).path in BRIDGE_PATHS:
                    self.bridge_origin=incoming
                    return True
                self.send_error(403)
                return False
            return True

        def end_headers(self):
            if getattr(self,'bridge_origin',None):
                self.send_header('Access-Control-Allow-Origin',self.bridge_origin)
                self.send_header('Vary','Origin')
            super().end_headers()

        def reply(self, code, result):
            body=json.dumps(result,ensure_ascii=False).encode()
            self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store')
            self.send_header('Content-Length',str(len(body)));self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body)

        def callback(self, query):
            outcome = login.finish(query)
            if outcome is None:
                self.send_error(404);return
            if outcome[0]:
                for topic in ('data','sweep','devices'):relay.broadcast(topic)
            body = callback_page(*outcome)
            self.send_response(200 if outcome[0] else 400)
            self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers();self.wfile.write(body)

        def account_data(self, account, operations=None):
            # Embedded pages name the account they edit; it must be this device's account.
            record = device.record()
            if not record or not isinstance(account,str) or not secrets.compare_digest(account.encode(),record['account']['id'].encode()):
                raise DeviceError(403,{'error':'login_required'})
            if operations is None:
                result = device.call('GET','/api/v1/device/data')
            else:
                result = device.call('POST','/api/v1/device/data',{'operations':operations},timeout=20)
            if (result.get('account') or {}).get('id') != account:
                raise DeviceError(403,{'error':'login_required'})
            return result

        def do_OPTIONS(self):
            if not self.allow_origin():return
            method = self.headers.get('Access-Control-Request-Method')
            if not getattr(self,'bridge_origin',None) or method != 'GET':
                self.send_error(403);return
            requested={v.strip().lower() for v in self.headers.get('Access-Control-Request-Headers','').split(',') if v.strip()}
            if requested-{'accept'}:self.send_error(403);return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Methods','GET')
            self.send_header('Access-Control-Allow-Headers','Accept')
            self.send_header('Access-Control-Allow-Private-Network','true')
            self.send_header('Access-Control-Max-Age','600')
            self.end_headers()

        def do_GET(self):
            if not self.allow_origin():return
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            if parsed.path=='/api/v1/events':
                try:gateway.stream_events(self)
                except (OSError,ValueError):pass
                return
            if parsed.path=='/callback':
                self.callback(query);return
            if parsed.path=='/api/v1/account/events':
                try:relay.serve(self)
                except OverflowError:self.send_error(503)
                return
            if parsed.path in ('/collect','/collect/','/web/download.html'):
                self.send_response(302);self.send_header('Location',gateway.endpoint+parsed.path);self.end_headers();return
            if parsed.path=='/search' or any(parsed.path.startswith(prefix) and parsed.path[len(prefix):].isdigit() for prefix in ('/item/','/mob/','/map/')):
                import urllib.request
                try:
                    target=gateway.endpoint+parsed.path+('?' + urlencode({k:v[0] for k,v in query.items()}) if query else '')
                    request=urllib.request.Request(target,headers={'Authorization':'Bearer '+gateway.token,'Accept':'text/html'})
                    with gateway.opener.open(request,timeout=15) as response:body=response.read(8*1024*1024+1)
                    if len(body)>8*1024*1024:raise ValueError('Page too large')
                    self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body)
                except Exception:self.send_error(503,'Page temporarily unavailable')
                return
            try:
                if parsed.path in ('/', '/alerts','/watch','/prices','/sales','/account','/contributors','/privacy','/selling'):
                    body = (web_assets.WEB/'index.html').read_bytes()
                    kind = 'text/html; charset=utf-8'
                elif parsed.path[1:] in ASSETS:
                    asset = parsed.path[1:]
                    body = (ROOT/asset).read_bytes()
                    kind = 'text/css; charset=utf-8' if asset.endswith('.css') else 'text/javascript; charset=utf-8'
                elif web_assets.page(parsed.path) is not None:
                    body = web_assets.page(parsed.path)
                    kind = 'text/html; charset=utf-8'
                elif web_assets.asset(parsed.path) is not None:
                    target, kind = web_assets.asset(parsed.path)
                    body = target.read_bytes()
                elif parsed.path == '/healthz':
                    body = b'{"ok":true,"personal_dashboard":true}'
                    kind = 'application/json; charset=utf-8'
                else:
                    if parsed.path == '/api/v1/account':
                        profile=gateway.fetch('/api/v1/collector/profile',0)
                        if gateway.last_error:raise OSError('Account sync unavailable')
                        record=device.record()
                        result={**profile,'mode':'collector','signed_in':True,'csrf':ui_nonce,
                                'linked':record is not None,'public_id':record['account']['id'] if record else None,
                                'sync_scope':'watch'}
                    elif parsed.path == '/api/v1/account/data':
                        result=self.account_data(query.get('account',[''])[0])
                    elif parsed.path == '/api/v1/device/login':
                        result={'pending':login.active(),'csrf':ui_nonce}
                    elif parsed.path == '/api/v1/contributors':
                        period=query.get('period',['week'])[0]
                        if period not in ('week','month','all'):raise ValueError('Invalid period')
                        result=gateway.fetch('/api/v1/contributors?'+urlencode({'period':period}),0)
                    elif parsed.path == '/api/v1/collector/status':
                        result=gateway.status()
                    elif parsed.path == '/api/v1/collector/watch-listings':
                        ids=query.get('ids',[''])[0]
                        if len(ids)>1100 or len(ids.split(','))>100 or any(not v.isdigit() or not 1000000<=int(v)<=5999999 for v in ids.split(',') if v):raise ValueError('Invalid item IDs')
                        result=gateway.fetch('/api/v1/collector/watch-listings?'+urlencode({'ids':ids}),0)
                    elif parsed.path == '/api/v1/collector/inventory':
                        # The stall planner reads this PC's bag directly; nothing is uploaded.
                        from market_inventory import read_inventory
                        result={'holdings':read_inventory(gateway.folder)}
                    elif parsed.path in ('/api/v1/market/selected','/api/v1/npc-sell'):
                        ids=query.get('ids',[''])[0]
                        if len(ids)>1100 or len(ids.split(','))>100 or any(not v.isdigit() or not 1000000<=int(v)<=5999999 for v in ids.split(',') if v):raise ValueError('Invalid item IDs')
                        args={'ids':ids}
                        if parsed.path=='/api/v1/market/selected':
                            hours=query.get('hours',['72'])[0]
                            if hours not in ('72','all'):raise ValueError('Invalid quote window')
                            args={'hours':hours,'ids':ids}
                        result=gateway.fetch(parsed.path+'?'+urlencode(args),30 if parsed.path=='/api/v1/market/selected' else 3600)
                    elif parsed.path == '/api/v1/collector/alerts':
                        hours=query.get('hours',['72'])[0]
                        if hours not in ('72','all'):raise ValueError('Invalid quote window')
                        result=gateway.fetch('/api/v1/collector/alerts?'+urlencode({'hours':hours}),0)
                    elif parsed.path in ('/api/v1/market/period-default','/api/v1/dex/counts','/api/v1/dex/dropped-items','/api/v1/crafting/prices'):
                        result=gateway.fetch(parsed.path,0)
                    elif parsed.path.startswith('/api/v1/item/') and parsed.path.rsplit('/',1)[-1].isdigit():
                        result=gateway.fetch(parsed.path,0)
                    elif parsed.path == '/api/v1/catalog/page':
                        target=query.get('url',[''])[0]
                        route=urlsplit(target)
                        if len(target)>2048 or route.scheme or route.netloc or not (
                            route.path=='/search' or any(route.path.startswith(p) and route.path[len(p):].isdigit() for p in ('/item/','/mob/','/map/'))):
                            raise ValueError('Invalid catalogue page')
                        args={'url':target}
                        if query.get('preview')==['true']:args['preview']='true'
                        result=gateway.fetch(parsed.path+'?'+urlencode(args),0)
                    elif parsed.path == '/api/v1/market/records':
                        kind=query.get('kind',['quotes'])[0]
                        hours=query.get('hours',['72'])[0]
                        if kind not in ('quotes','sales') or hours not in ('1','6','24','48','72','168','all'):
                            raise ValueError('Invalid records query')
                        result=gateway.fetch(parsed.path+'?'+urlencode({'kind':kind,'hours':hours}),0)
                    elif parsed.path == '/api/v1/market':
                        result = gateway.market(query)
                    elif parsed.path == '/api/v1/sales/recent':
                        from market_sales import sales_query
                        args = {k: v for k, v in sales_query(query).items() if k != 'limit' or v != 50}
                        result = gateway.fetch('/api/v1/sales/recent'+('?'+urlencode(args) if args else ''), 10)
                    elif parsed.path == '/api/v1/watchlist/catalog':
                        result = gateway.fetch('/api/v1/watchlist/catalog?'+urlencode({'q': query.get('q', [''])[0][:100]}), 60)
                    elif parsed.path == '/api/v1/watchlist/listings':
                        from market_watchlist import parse_item_ids
                        ids = query.get('ids', [''])[0]
                        parse_item_ids(ids)
                        result = gateway.fetch('/api/v1/watchlist/listings?'+urlencode({'ids': ids}), 0)
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
            except DeviceError as error:
                self.reply(error.status if error.status in (400,401,403,409,429) else 503,error.body or {'error':error.code})
                return
            except Exception:
                self.send_error(503, 'Shared service unavailable; retry shortly')
                return
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; frame-ancestors http://127.0.0.1:*; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not self.allow_origin():return
            origin=f'http://127.0.0.1:{self.server.server_port}'
            other=f'http://localhost:{self.server.server_port}'
            path=urlsplit(self.path).path
            if (self.headers.get('Origin') not in (origin,other)
                or not secrets.compare_digest(self.headers.get('X-CSRF-Token',''),ui_nonce)
                or self.headers.get('Content-Type','').split(';')[0]!='application/json'):
                self.send_error(403);return
            is_watch = path == '/api/v1/account/data'
            is_login = path in ('/api/v1/device/login','/api/v1/account/link')
            if path != '/api/v1/account' and not is_watch and not is_login:self.send_error(404);return
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=(512*1024 if is_watch else 2048):raise ValueError('Invalid request length')
                data=json.loads(self.rfile.read(length))
                if not isinstance(data,dict):raise ValueError('Invalid request')
                if is_watch:
                    # The device may only edit watches and watch preferences. The cloud
                    # validates the account binding and every record version again.
                    if not isinstance(data.get('account'),str) or not isinstance(data.get('operations'),list):
                        raise ValueError('Invalid watch changes')
                    result=self.account_data(data['account'],data['operations'])
                elif is_login:
                    result={'url':login.begin()}
                else:
                    result=gateway.update('/api/v1/collector/profile',data)
                code=200
            except (ValueError,TypeError,AttributeError):
                code=400
                result={'error':'Invalid request'}
            except DeviceError as error:
                code=error.status if error.status in (400,401,403,409,429) else 503
                result=error.body or {'error':error.code}
            except Exception as error:
                import urllib.error
                code=error.code if isinstance(error,urllib.error.HTTPError) and error.code in (400,401,403,409,429) else 503
                result={'error':'unavailable'}
                if isinstance(error,urllib.error.HTTPError):
                    try:result=json.loads(error.read(2048))
                    except (ValueError,OSError):pass
            self.reply(code,result)

        def log_message(self, *args):
            pass

    class LoopbackServer(ThreadingHTTPServer):
        # Windows SO_REUSEADDR permits multiple listeners on the same port,
        # leaving requests at an old dashboard after a restart.
        allow_reuse_address = os.name != 'nt'
        def server_bind(self):
            if os.name == 'nt':
                self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            super().server_bind()
    try:
        server = LoopbackServer(('127.0.0.1', port), Handler)
    except OSError as error:
        if not port or error.errno not in (48, 98, 10048, 10013):
            raise
        server = LoopbackServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    login.redirect_uri = f'http://127.0.0.1:{server.server_port}/callback'
    server.device, server.login, server.relay, server.upstream = device, login, relay, upstream
    def start_device():
        upstream.start()
        # Old linked collectors move to a device token once, without a browser login.
        threading.Thread(target=device.migrate,name='device-migrate',daemon=True).start()
    def stop_device():
        upstream.close();relay.close()
    server.start_device, server.stop_device = start_device, stop_device
    return server


def run(home, config, folder, port=8780, instance='', parent_pid=0, parent_created=0):
    import os
    parent=None
    if parent_pid:
        import psutil
        try:
            parent=psutil.Process(parent_pid)
            if abs(parent.create_time()-parent_created)>0.001:return
        except psutil.NoSuchProcess:return
    server = create_server(config, folder, port, home)
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    ready = dict(url=f'http://127.0.0.1:{server.server_port}/alerts', pid=os.getpid(),
                 instance=instance, started_at=time.time())
    temporary = home/'dashboard.json.tmp'
    temporary.write_text(json.dumps(ready), encoding='utf-8')
    # The parent reads this file while waiting for readiness. On Windows its
    # brief read handle can deny replacement; retry without restarting capture.
    deadline = time.monotonic() + 3
    while True:
        try:
            temporary.replace(home/'dashboard.json')
            break
        except PermissionError:
            if time.monotonic() >= deadline:
                server.server_close()
                raise
            time.sleep(.025)
    print('Personal alerts: '+ready['url'], flush=True)
    if parent:
        def stop_with_parent():
            parent.wait()
            server.shutdown()
        threading.Thread(target=stop_with_parent,daemon=True).start()
    try:
        server.start_device()
        server.serve_forever()
    finally:
        server.stop_device()
        server.server_close()
