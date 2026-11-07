"""Local-first market repository and read-only HTTP API. No game requests."""
import argparse
import hashlib
import json
import multiprocessing
import sqlite3
import statistics
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager, closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from market_health import classify
from monitor_market import connections
from market_pricing import recommend
from market_views import view, opportunities, list_view, json_body, not_modified
from urllib.parse import urlsplit, parse_qs
from market_equipment import decode_equipment
from market_location import LocationTimeline
from market_watchlist import search_catalog,report_listings,parse_item_ids
import web_assets
from market_sales import SOLD_OUT_KINDS, sale_id, sales_stats, recent_sales, sales_query

ROOT = Path(__file__).resolve().parent
CATEGORIES = {1:'装备',2:'消耗品',3:'装饰',4:'其他',5:'商城物品',6:'其他'}


def item_category(item_id, cash=False):
    # Cash-shop equipment (时装/暖暖) belongs with the other cash-shop items.
    if cash and item_id//1000000 == 1:
        return '商城物品'
    return CATEGORIES.get(item_id//1000000, '未知')
SALE_METHODS = {'drop':'库存减少推定成交','sold_out':'售光推定成交','found_sold':'售光推定成交'}
SALE_EVIDENCE = {
    'drop':'两次观察之间库存减少；非订单回执，成交在两次观察之间',
    'sold_out':'两次观察之间库存变为0；非订单回执，成交在两次观察之间',
    'found_sold':'首次看到时库存已为0；非订单回执，成交数量和时间未知',
}


def listing_shop(world, source, shop_key, visit):
    """Shop identity for listing state and latest snapshots. Shared visit keys
    include the UTC day; state keyed by them recounted rows already sold when a
    new day began and kept yesterday's snapshot as a second shop."""
    if source != 'shared':
        return shop_key
    location = visit.get('market_location')
    identity = ['shared-listing-v1', world, location, visit['shop_id'], visit['title'], None if location else visit.get('session')]
    return hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def equipment_jobs(record):
    mask=((record.get('mapledex_reference') or {}).get('data') or {}).get('reqJob')
    if mask is None:return []
    if mask==0:return ['通用']
    if mask==-1:return ['新手']
    return [label for bit,label in ((1,'战士'),(2,'魔法师'),(4,'弓箭手'),(8,'飞侠'),(16,'海盗')) if mask&bit]


class Repository:
    def __init__(self, folder, catalog=ROOT/'item_database/items.sqlite'):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.db = self.folder/'market.sqlite'
        self.catalog = catalog
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, collector TEXT, world TEXT, observed REAL, shop_key TEXT, source TEXT, payload TEXT)')
            db.execute('CREATE INDEX IF NOT EXISTS visits_time ON visits(observed)')

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.db, timeout=10)) as db:
            with db:
                yield db

    def ingest(self, path, collector='local', world='ClassicWorld'):
        d = json.loads(path.read_text(encoding='utf-8'))
        if not all(k in d for k in ('session','time','shop_id','items')):
            return
        # Stable source identity: repeated scans and translated copies cannot add visits.
        identity = hashlib.sha256(json.dumps([collector, world, d['session'], d['time'], d['shop_id']]).encode()).hexdigest()
        shop = json.dumps([world, d.get('host','legacy'), d.get('port',0), d['shop_id'], d['title']])
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO visits VALUES (?,?,?,?,?,?,?)',
                (identity, collector, world, d['time'], shop, str(path.resolve()), json.dumps(d,ensure_ascii=False)))

    def item_detail(self, item_id):
        if not self.catalog.exists():
            return None
        with closing(sqlite3.connect(self.catalog)) as db:
            row=db.execute('SELECT record_json FROM items WHERE item_id=?',(item_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def report(self, hours=72):
        names = {}
        if self.catalog.exists():
            with closing(sqlite3.connect(self.catalog)) as db:
                for iid,zh,en,icon,record,sub in db.execute('SELECT item_id,name_zh,name_en,icon_url,record_json,category FROM items'):
                    record=json.loads(record)
                    names[iid]=dict(name_zh=zh, name_en=en, icon_url=icon, level=record.get('level'),
                                    jobs=equipment_jobs(record), subcategory=sub, cash=record.get('cash') is True)
        with self.connect() as db:
            visits = db.execute('SELECT id,collector,world,observed,shop_key,source,payload FROM visits ORDER BY observed,id').fetchall()
        locations = LocationTimeline(ROOT/'network_captures/market_live/map_observations.jsonl')
        latest, history, sales, previous = {}, [], [], {}
        excluded = 0
        for vid,collector,world,observed,shop,source,payload in visits:
            d = json.loads(payload)
            state = listing_shop(world, source, shop, d)
            experimental = d.get('triggered_by_python',False)
            if experimental:
                excluded += 1
            items=[]
            for r in d['items']:
                iid=r['item_id']; price=r['price_mesos_candidate']; bundle=r['bundle_quantity_candidate']; stock=r['available_quantity_candidate']
                raw=r.get('raw_record_hex','')
                # Equipment with different serialized attributes remains separate.
                variant=r.get('shared_variant') or (hashlib.sha256(bytes.fromhex(raw)[20:]).hexdigest()[:16] if iid//1000000==1 and raw else ('unknown' if iid//1000000==1 else 'standard'))
                row=dict(visit_id=vid,collector=collector,world=world,time=observed,shop=d['title'],shop_id=d['shop_id'],
                    item_id=iid,category=item_category(iid,names.get(iid,{}).get('cash')),variant=variant,slot=r['slot'],
                    price=price,bundle=bundle,unit_price=price/bundle if bundle else None,stock=stock,
                    name_zh=names.get(iid,{}).get('name_zh') or str(iid),name_en=names.get(iid,{}).get('name_en') or '',
                    icon_url=names.get(iid,{}).get('icon_url'),level=names.get(iid,{}).get('level'),
                    jobs=names.get(iid,{}).get('jobs',[]),
                    subcategory=names.get(iid,{}).get('subcategory','未知'),
                    experimental=experimental,requires_validation=d.get('prices_require_screen_validation',True),
                    source=source,raw_source=d.get('raw_source'),raw_available=bool(raw),shop_key=state)
                row['equipment']=r.get('shared_equipment') or decode_equipment(raw, iid)
                row['location']=locations.resolve(d['session'], observed, d.get('market_location'))
                row['server_endpoint']=f"{d.get('host','未知')}:{d.get('port','未知')}"
                history.append(row); items.append(row)
                if not experimental:
                    key=(state,r['slot'],iid,variant)
                    old=previous.get(key)
                    kind=None
                    if stock==0 and (old is None or old['stock']>0):
                        kind='sold_out' if old else 'found_sold'
                    elif old and 0<stock<old['stock'] and (old['price'],old['bundle'])==(price,bundle):
                        kind='drop'
                    if kind:
                        sold=(old['stock']-stock)*(old['bundle'] or 0) if old else 0
                        sale=dict(row,kind=kind,id=sale_id(vid,r['slot']),method=SALE_METHODS[kind],
                                  sale_price=old['price'] if old else price,
                                  sale_unit_price=old['unit_price'] if old else row['unit_price'],
                                  quantity=sold or None,previous_time=old['time'] if old else None,
                                  evidence=SALE_EVIDENCE[kind])
                        sales.append(sale)
                    previous[key]=row
            if not experimental:
                latest[state]=(observed,items)
        now=time.time()
        cutoff=now-hours*3600 if hours is not None else float("-inf")
        groups={}
        for observed,items in latest.values():
            if observed<cutoff: continue
            for r in items:
                if r['stock']<=0 or r['unit_price'] is None: continue
                key=(r['world'],r['item_id'],r['variant'])
                groups.setdefault(key,[]).append(r)
        aggregates=[]
        sold_by_key=defaultdict(list)
        for s in sales:
            if s['time']>=cutoff and s['sale_unit_price'] is not None and s['kind'] in SOLD_OUT_KINDS:
                sold_by_key[(s['world'],s['item_id'],s['variant'])].append(s)
        for key,rows in groups.items():
            values=[r['unit_price'] for r in rows]
            base={k:rows[0][k] for k in ('world','item_id','name_zh','name_en','category','variant','icon_url','level','subcategory')}
            matching=sold_by_key.get(key,())
            aggregates.append(dict(base,low=min(values),median=statistics.median(values),high=max(values),
                listings=len(rows),shops=len({r['shop_key'] for r in rows}),last_seen=max(r['time'] for r in rows),
                sold_out_count=len(matching),sold_out_median=statistics.median([s['sale_unit_price'] for s in matching]) if matching else None,
                requires_validation=any(r['requires_validation'] for r in rows),listings_detail=rows))
        products={}
        for r in history:
            if r['experimental']: continue
            key=(r['world'],r['item_id'])
            if key not in products:
                products[key]=dict({k:r[k] for k in ('world','item_id','name_zh','name_en','category','icon_url','level','jobs','subcategory')},
                                   last_seen=r['time'],quotes=[],variants=[],sales=[])
            products[key]['last_seen']=max(products[key]['last_seen'],r['time'])
        for a in aggregates:
            p=products[(a['world'],a['item_id'])]
            p['quotes'].extend(a['listings_detail']);p['variants'].append(a['variant'])
        by_item=defaultdict(list)
        for s in sales:
            by_item[(s['world'],s['item_id'])].append(s)
            if s['time']>=cutoff:
                products[(s['world'],s['item_id'])]['sales'].append(s)
        # Collection is bursty: sale windows end at the latest observation, not
        # the wall clock, so "last 24h" means the last day of collected data.
        as_of=max((t for t,_ in latest.values()),default=None)
        anchor=(as_of//60+1)*60 if as_of is not None else now
        for p in products.values():
            p['sales'].sort(key=lambda s:s['time'],reverse=True)
            values=[r['unit_price'] for r in p['quotes']]
            inferred=[r['sale_unit_price'] for r in p['sales'] if r['sale_unit_price'] is not None and r['kind'] in SOLD_OUT_KINDS]
            p.update(low=min(values) if values else None,median=statistics.median(values) if values else None,
                     high=max(values) if values else None,listings=len(values),shops=len({r['shop_key'] for r in p['quotes']}),
                     sold_out_count=len(inferred),sold_out_median=statistics.median(inferred) if inferred else None,
                     sales_count=len(p['sales']))
            p.update(sales_stats(by_item[(p['world'],p['item_id'])],anchor))
            p['hours']=hours
            p['recommendation']=recommend(p)
        return dict(schema_version=1,generated_at=now,as_of=as_of,hours=hours,visits=len(visits),
            manual_visits=len(visits)-excluded,experimental_visits=excluded,observations=len(history),
            manual_observations=sum(not r['experimental'] for r in history),
            observed_shops=len(latest),active_shops=sum(t>=cutoff for t,_ in latest.values()),
            item_count=len({r['item_id'] for r in history if not r['experimental']}),
            items=sorted(aggregates,key=lambda r:(r['category'],r['item_id'])),products=list(products.values()),
            sales=list(reversed(sales)),history=list(reversed(history)),
            limitation='仅覆盖手动访问并成功解析的摊位；不是全市场。报价与库存字段待画面核对。装备不同序列化记录分组，属性未完整解析。售光是推定，不是成交回执。')


def build_reports(folder, catalog):
    """Run bulk pricing outside the process serving latency-sensitive alerts."""
    repo=Repository(Path(folder),Path(catalog))
    reports={}
    for window in (72,None):
        report=repo.report(window)
        report['opportunities']=opportunities(report)
        reports[window]=report
    from market_selling import catalog as selling_catalog
    reports['selling']=selling_catalog(reports[72])
    return reports


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    repo=Repository(ROOT/'market_data')
    report_worker=ProcessPoolExecutor(max_workers=1,mp_context=multiprocessing.get_context('spawn'))
    health={'last_scan':None,'errors':[]}
    connection_health={}
    cached={'report':None,'at':0}
    scanned={}
    updates=threading.Condition()
    revision=0
    last_state=None
    last_network_check=0
    records=[];network_error=None
    deal_events=deque(maxlen=128)
    deal_revision=0
    def emit_deals(payload):
        nonlocal deal_revision
        with updates:
            deal_revision+=1;deal_events.append((deal_revision,payload));updates.notify_all()
    watch_dirs=[ROOT/'network_captures/proxy_live',ROOT/'network_captures/market_live',ROOT/'network_captures/market_passive_live']
    try:watch_dirs.extend(Path(p) for p in json.loads((repo.folder/'capture_sources.json').read_text(encoding='utf-8-sig')))
    except (OSError,ValueError):pass
    try:
        from market_realtime_alerts import start_alert_watcher
        alert_watcher=start_alert_watcher(watch_dirs,lambda:cached['report'],emit_deals,health)
    except Exception as error:health['fast_alert_error']=str(error)
    def scan():
        nonlocal last_network_check,records,network_error,revision,last_state
        while True:
            errors=[];changed=False
            if time.monotonic()-last_network_check>30:
                try:_,records=connections();network_error=None
                except Exception as exc:records=[];network_error=str(exc)
                last_network_check=time.monotonic()
            try:
                capture_status=json.loads((ROOT/'network_captures/market_live/status.json').read_text())
            except (OSError,ValueError): capture_status={}
            connection_health.clear()
            connection_health.update(classify(capture_status,records,network_error))
            directories=[ROOT/'network_captures/proxy_live',ROOT/'network_captures/market_live',ROOT/'network_captures/market_passive_live']
            try:directories.extend(Path(p) for p in json.loads((repo.folder/'capture_sources.json').read_text(encoding='utf-8-sig')))
            except (OSError,ValueError):pass
            passive=[]
            for directory in dict.fromkeys(directories):
                try:
                    state=json.loads((directory/'passive_status.json').read_text(encoding='utf-8'))
                    if time.time()-state['time']<10:
                        if state.get('decoding'):
                            try:
                                entries=(directory/'map_observations.jsonl').read_text(encoding='utf-8').splitlines()
                                state['location']=json.loads(entries[-1]).get('location') if entries else None
                            except (OSError,ValueError):pass
                        passive.append(state)
                except (OSError,ValueError,KeyError):pass
            if passive:
                decoding=sum(s.get('decoding',0) for s in passive)
                connection_health.clear()
                connection_health.update(state='ready' if decoding else 'waiting_handshake',
                    message='旁路采集正常，正在统计商品' if decoding else '旁路已启动，等待游戏重新建立频道连接')
                active=sorted((s for s in passive if s.get('decoding')),key=lambda s:s['time'])
                if active:connection_health['location']=active[-1].get('location')
            for directory in dict.fromkeys(directories):
                for path in directory.glob('shop_*.json'):
                    if path.stem.endswith('_zh'): continue
                    try:
                        stat=path.stat();signature=(stat.st_mtime_ns,stat.st_size)
                        if scanned.get(path)==signature:continue
                        repo.ingest(path);scanned[path]=signature
                        changed=True
                    except Exception as exc: errors.append(dict(file=path.name,error=str(exc)))
            health.update(last_scan=time.time(),errors=errors[-20:])
            try:
                if changed or cached['report'] is None or time.time()-cached['at']>30:
                    started=time.perf_counter()
                    reports=report_worker.submit(build_reports,str(repo.folder),str(repo.catalog)).result()
                    cached.update(report=reports,at=time.time())
                    health['report_build_ms']=round((time.perf_counter()-started)*1000,1)
            except Exception as exc: health['errors'].append(dict(error=str(exc)))
            state=(cached['at'],connection_health.get('state'),json.dumps(connection_health.get('location'),sort_keys=True))
            if state!=last_state:
                with updates:
                    revision+=1;last_state=state;updates.notify_all()
            time.sleep(.25)
    threading.Thread(target=scan,daemon=True).start()
    class Handler(BaseHTTPRequestHandler):
        # Flush small SSE frames immediately, even with another frame in flight.
        disable_nagle_algorithm=True

        def do_GET(self):
            path=self.path.split('?')[0]
            if path=='/api/v1/events':
                self.send_response(200)
                self.send_header('Content-Type','text/event-stream')
                self.send_header('Cache-Control','no-cache')
                self.send_header('X-Accel-Buffering','no')
                self.end_headers()
                self.connection.settimeout(20)
                seen=-1
                seen_deal=0
                try:
                    while True:
                        with updates:
                            updates.wait_for(lambda: revision!=seen or deal_revision!=seen_deal,timeout=15)
                            current=revision
                            fast=[(n,p) for n,p in deal_events if n>seen_deal]
                            seen_deal=deal_revision
                        for _,payload in fast:
                            self.wfile.write(('event: deals\ndata: '+json.dumps(payload,ensure_ascii=False)+'\n\n').encode('utf-8'))
                        if current!=seen:
                            self.wfile.write(f'event: market\ndata: {current}\n\n'.encode());seen=current
                        else:self.wfile.write(b': heartbeat\n\n')
                        self.wfile.flush()
                except (OSError,ConnectionError):pass
                return
            if path=='/':
                try:
                    native=json.loads((ROOT/'shared_data/native-runtime.json').read_text(encoding='utf-8'))
                except (OSError,ValueError):native={}
                if native.get('enabled'):
                    self.send_response(302)
                    self.send_header('Location','http://127.0.0.1:8766/')
                    self.send_header('Cache-Control','no-store')
                    self.send_header('Content-Length','0')
                    self.end_headers();return
            if path in ('/','/legacy','/alerts'):
                body=(ROOT/'market_index.html').read_text(encoding='utf-8').replace('<body>', '<body class="alerts-page">' if path=='/alerts' else '<body class="market-page">').encode(); kind='text/html; charset=utf-8'
            elif path=='/selling':
                body=(ROOT/'web/index.html').read_bytes();kind='text/html; charset=utf-8'
            elif path in ('/market_ui.js','/market_ui.css','/market_selling_ui.js','/market_i18n.js','/market_watchlist.js'):
                body=(ROOT/path[1:]).read_bytes()
                kind='text/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8'
            elif web_assets.page(path,local=True) is not None:
                body=web_assets.page(path,local=True);kind='text/html; charset=utf-8'
            elif web_assets.asset(path) is not None:
                target,kind=web_assets.asset(path);body=target.read_bytes()
            elif path.startswith('/api/v1/items/') and path.rsplit('/',1)[-1].isdigit():
                detail=repo.item_detail(int(path.rsplit('/',1)[-1]))
                if detail is None:
                    self.send_error(404);return
                body=json.dumps(detail,ensure_ascii=False).encode();kind='application/json; charset=utf-8'
            elif path=='/api/v1/watchlist/catalog':
                query=parse_qs(urlsplit(self.path).query).get('q',[''])[0]
                body=json.dumps(search_catalog(repo.catalog,query),ensure_ascii=False).encode();kind='application/json; charset=utf-8'
            elif path=='/api/v1/watchlist/listings':
                try:ids=parse_item_ids(parse_qs(urlsplit(self.path).query).get('ids',[''])[0])
                except ValueError:
                    self.send_error(400,'Invalid item IDs');return
                reports=cached['report']
                if reports is None:
                    self.send_error(503,'Market warming up');return
                body=json.dumps(report_listings(reports[72],ids),ensure_ascii=False).encode();kind='application/json; charset=utf-8'
            elif path=='/api/v1/search-preview':
                # Only public search HTML from the fixed local native service.
                from urllib.request import urlopen
                from urllib.parse import urlencode
                params=parse_qs(urlsplit(self.path).query)
                query=urlencode({k:params[k][0] for k in ('q','kind','lang','page') if k in params})
                try:
                    with urlopen('http://127.0.0.1:8766/search?'+query,timeout=10) as response:
                        body=response.read(2_000_000)
                    kind='text/html; charset=utf-8'
                except OSError:
                    self.send_error(502,'Search unavailable');return
            elif path=='/api/v1/selling':
                reports=cached['report']
                if reports is None:
                    self.send_error(503,'Market warming up');return
                body=json.dumps(reports['selling'],ensure_ascii=False).encode();kind='application/json; charset=utf-8'
            elif path=='/api/v1/sales/recent':
                reports=cached['report']
                if reports is None:
                    self.send_error(503,'Market warming up');return
                try:query=sales_query(parse_qs(urlsplit(self.path).query))
                except ValueError:
                    self.send_error(400,'Invalid sales query');return
                self.send_json(recent_sales(reports[72],**query));return
            elif path=='/api/v1/market':
                reports=cached['report']
                if reports is None:
                    self.send_error(503,'Market warming up');return
                query=parse_qs(urlsplit(self.path).query)
                window=query.get('hours',['72'])[0]
                if window not in ('72','all'):
                    self.send_error(400,'hours must be 72 or all');return
                layout=query.get('view',[''])[0]
                if layout not in ('','list'):
                    self.send_error(400,'view must be list');return
                base=reports[None if window=='all' else 72]
                item=query.get('item_id',[''])[0]
                if layout=='list' and not item:
                    data=list_view(base);data.update(connection_health=dict(connection_health),realtime=True)
                    self.send_json(data);return
                data=dict(view(base,summary=query.get('summary')==['1'],item_id=int(item) if item.isdigit() else None));data['health']=dict(health)
                data['connection_health']=dict(connection_health)
                data['realtime']=True
                status=ROOT/'network_captures/market_live/status.json'
                try:
                    s=json.loads(status.read_text()); locations=LocationTimeline(status.parent/'map_observations.jsonl'); data['capture']=dict(updated_at=s['updated_at'],fresh=time.time()-s['updated_at']<5,
                        sessions=[dict(id=x['id'],location=locations.resolve(x['id'],s['updated_at'],x.get('market_location'))) for x in s['sessions'] if not x['closed']],
                        active_sessions=sum(not x['closed'] for x in s['sessions']),allow_requests=s['allow_requests'])
                except (OSError,ValueError): data['capture']=None
                body=json.dumps(data,ensure_ascii=False).encode();kind='application/json; charset=utf-8'
            else:
                self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',kind)
            self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)))
            self.end_headers();self.wfile.write(body)
        def send_json(self,data):
            body,tag=json_body(data)
            if not_modified(self.headers.get('If-None-Match'),tag):
                self.send_response(304);self.send_header('ETag',tag);self.end_headers();return
            self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Cache-Control','no-store');self.send_header('ETag',tag)
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

        def log_message(self,*args): pass
    print(f'http://127.0.0.1:{args.port}',flush=True)
    try:
        ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
    finally:
        if 'alert_watcher' in locals():alert_watcher.stop()
        report_worker.shutdown(wait=False,cancel_futures=True)


if __name__=='__main__':
    multiprocessing.freeze_support()
    main()
