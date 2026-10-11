"""Local-first market repository and read-only HTTP API. No game requests."""
import argparse
import hashlib
import json
import sqlite3
import statistics
import threading
import time
from contextlib import contextmanager, closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from market_health import classify
from monitor_market import connections
from market_pricing import recommend
from market_equipment import decode_equipment
from market_location import LocationTimeline

ROOT = Path(__file__).resolve().parent
CATEGORIES = {1:'装备',2:'消耗品',3:'装饰',4:'其他',5:'商城物品',6:'其他'}


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

    def report(self, hours=24):
        names = {}
        if self.catalog.exists():
            with closing(sqlite3.connect(self.catalog)) as db:
                names = {r[0]:dict(name_zh=r[1], name_en=r[2], icon_url=r[3],
                                  level=json.loads(r[4]).get('level'),subcategory=r[5])
                         for r in db.execute('SELECT item_id,name_zh,name_en,icon_url,record_json,category FROM items')}
        with self.connect() as db:
            visits = db.execute('SELECT id,collector,world,observed,shop_key,source,payload FROM visits ORDER BY observed,id').fetchall()
        locations = LocationTimeline(ROOT/'network_captures/market_live/map_observations.jsonl')
        latest, history, sales, previous = {}, [], [], {}
        excluded = 0
        for vid,collector,world,observed,shop,source,payload in visits:
            d = json.loads(payload)
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
                    item_id=iid,category=CATEGORIES.get(iid//1000000,'未知'),variant=variant,slot=r['slot'],
                    price=price,bundle=bundle,unit_price=price/bundle if bundle else None,stock=stock,
                    name_zh=names.get(iid,{}).get('name_zh') or str(iid),name_en=names.get(iid,{}).get('name_en') or '',
                    icon_url=names.get(iid,{}).get('icon_url'),level=names.get(iid,{}).get('level'),
                    subcategory=names.get(iid,{}).get('subcategory','未知'),
                    experimental=experimental,requires_validation=d.get('prices_require_screen_validation',True),
                    source=source,raw_source=d.get('raw_source'),raw_available=bool(raw),shop_key=shop)
                row['equipment']=r.get('shared_equipment') or decode_equipment(raw, iid)
                row['location']=locations.resolve(d['session'], observed, d.get('market_location'))
                row['server_endpoint']=f"{d.get('host','未知')}:{d.get('port','未知')}"
                history.append(row); items.append(row)
                if not experimental:
                    key=(shop,r['slot'],iid,variant)
                    old=previous.get(key)
                    if stock==0 and (old is None or old['stock']>0):
                        sale=dict(row,method='售光推定成交',sale_price=old['price'] if old else price,
                                  sale_unit_price=old['unit_price'] if old else row['unit_price'],
                                  quantity=None,previous_time=old['time'] if old else None,
                                  evidence='库存候选字段为0；非订单回执，成交数量和时间未知')
                        sales.append(sale)
                    previous[key]=row
            if not experimental:
                latest[shop]=(observed,items)
        cutoff=time.time()-hours*3600
        groups={}
        for observed,items in latest.values():
            if observed<cutoff: continue
            for r in items:
                if r['stock']<=0 or r['unit_price'] is None: continue
                key=(r['world'],r['item_id'],r['variant'])
                groups.setdefault(key,[]).append(r)
        aggregates=[]
        for key,rows in groups.items():
            values=[r['unit_price'] for r in rows]
            base={k:rows[0][k] for k in ('world','item_id','name_zh','name_en','category','variant','icon_url','level','subcategory')}
            matching=[s for s in sales if (s['world'],s['item_id'],s['variant'])==key and s['time']>=cutoff and s['sale_unit_price'] is not None]
            aggregates.append(dict(base,low=min(values),median=statistics.median(values),high=max(values),
                listings=len(rows),shops=len({r['shop_key'] for r in rows}),last_seen=max(r['time'] for r in rows),
                sold_out_count=len(matching),sold_out_median=statistics.median([s['sale_unit_price'] for s in matching]) if matching else None,
                requires_validation=any(r['requires_validation'] for r in rows),listings_detail=rows))
        products={}
        for r in history:
            if r['experimental']: continue
            key=(r['world'],r['item_id'])
            if key not in products:
                products[key]=dict({k:r[k] for k in ('world','item_id','name_zh','name_en','category','icon_url','level','subcategory')},
                                   last_seen=r['time'],quotes=[],variants=[],sales=[])
            products[key]['last_seen']=max(products[key]['last_seen'],r['time'])
        for a in aggregates:
            p=products[(a['world'],a['item_id'])]
            p['quotes'].extend(a['listings_detail']);p['variants'].append(a['variant'])
        for s in sales:
            if s['time']>=cutoff:
                products[(s['world'],s['item_id'])]['sales'].append(s)
        for p in products.values():
            values=[r['unit_price'] for r in p['quotes']]
            inferred=[r['sale_unit_price'] for r in p['sales'] if r['sale_unit_price'] is not None]
            p.update(low=min(values) if values else None,median=statistics.median(values) if values else None,
                     high=max(values) if values else None,listings=len(values),shops=len({r['shop_key'] for r in p['quotes']}),
                     sold_out_count=len(inferred),sold_out_median=statistics.median(inferred) if inferred else None)
            p['recommendation']=recommend(p)
        return dict(schema_version=1,generated_at=time.time(),hours=hours,visits=len(visits),
            manual_visits=len(visits)-excluded,experimental_visits=excluded,observations=len(history),
            manual_observations=sum(not r['experimental'] for r in history),
            observed_shops=len(latest),active_shops=sum(t>=cutoff for t,_ in latest.values()),
            item_count=len({r['item_id'] for r in history if not r['experimental']}),
            items=sorted(aggregates,key=lambda r:(r['category'],r['item_id'])),products=list(products.values()),
            sales=list(reversed(sales)),history=list(reversed(history)),
            limitation='仅覆盖手动访问并成功解析的摊位；不是全市场。报价与库存字段待画面核对。装备不同序列化记录分组，属性未完整解析。售光是推定，不是成交回执。')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    repo=Repository(ROOT/'market_data')
    health={'last_scan':None,'errors':[]}
    connection_health={}
    def scan():
        while True:
            errors=[]
            try:
                _,records=connections(); network_error=None
            except Exception as exc:
                records=[]; network_error=str(exc)
            try:
                capture_status=json.loads((ROOT/'network_captures/market_live/status.json').read_text())
            except (OSError,ValueError): capture_status={}
            connection_health.clear()
            connection_health.update(classify(capture_status,records,network_error))
            for directory in (ROOT/'network_captures/proxy_live',ROOT/'network_captures/market_live'):
                for path in directory.glob('shop_*.json'):
                    if path.stem.endswith('_zh'): continue
                    try: repo.ingest(path)
                    except Exception as exc: errors.append(dict(file=path.name,error=str(exc)))
            health.update(last_scan=time.time(),errors=errors[-20:])
            try:
                data=json.dumps(repo.report(),ensure_ascii=False)
                temp=repo.folder/'latest.tmp'
                temp.write_text(data,encoding='utf-8');temp.replace(repo.folder/'latest.json')
            except Exception as exc: health['errors'].append(dict(error=str(exc)))
            time.sleep(5)
    threading.Thread(target=scan,daemon=True).start()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path=self.path.split('?')[0]
            if path=='/':
                body=(ROOT/'market_index.html').read_bytes(); kind='text/html; charset=utf-8'
            elif path in ('/market_ui.js','/market_ui.css'):
                body=(ROOT/path[1:]).read_bytes()
                kind='text/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8'
            elif path.startswith('/api/v1/items/') and path.rsplit('/',1)[-1].isdigit():
                detail=repo.item_detail(int(path.rsplit('/',1)[-1]))
                if detail is None:
                    self.send_error(404);return
                body=json.dumps(detail,ensure_ascii=False).encode();kind='application/json; charset=utf-8'
            elif path=='/api/v1/market':
                data=repo.report();data['health']=dict(health)
                data['connection_health']=dict(connection_health)
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
        def log_message(self,*args): pass
    print(f'http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()


if __name__=='__main__': main()
