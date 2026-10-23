"""File-event driven local deal alerts, independent of full market reports."""
import json
import hashlib
import queue
import threading
import time
from pathlib import Path
from market_views import opportunities
from market_watchlist import visit_listings


def same_shop(row, visit):
    """Match a local visit to shared evidence without relying on server addresses."""
    if (row.get('shop_id') != visit.get('shop_id') or row.get('shop') != visit.get('title')
            or int(row.get('time', 0)//86400) != int(visit['time']//86400)):
        return False
    left, right = row.get('location'), visit.get('market_location')
    if left and right:
        return all(left.get(key) == right.get(key) for key in ('channel', 'room'))
    return True


def visit_opportunities(report, visit, now=None):
    now=time.time() if now is None else now
    if visit.get('triggered_by_python') or not 0<=now-visit['time']<=120:return []
    shop=json.dumps(['ClassicWorld',visit.get('host','legacy'),visit.get('port',0),visit['shop_id'],visit['title']])
    by_id={p['item_id']:p for p in report['products']}
    rows={}
    for item in visit['items']:
        iid=item['item_id'];bundle=item['bundle_quantity_candidate'];stock=item['available_quantity_candidate']
        if iid//1000000==1 or bundle<=0 or stock<=0 or iid not in by_id:continue
        rows.setdefault(iid,[]).append(dict(item_id=iid,time=visit['time'],collector='local',
            shop_key=shop,shop=visit['title'],slot=item['slot'],price=item['price_mesos_candidate'],
            bundle=bundle,unit_price=item['price_mesos_candidate']/bundle,stock=stock,
            location=visit.get('market_location')))
    products=[]
    cutoff=now-report['hours']*3600 if report.get('hours') is not None else float('-inf')
    for iid,current in rows.items():
        product=by_id[iid]
        # Existing recent rows remain pricing evidence, but only this visit is
        # eligible as the alert candidate in this event.
        prior=[dict(r,collector='reference') for r in product['quotes']
               if r['shop_key']!=shop and not same_shop(r,visit) and r['time']>=cutoff]
        products.append(dict(product,quotes=prior+current,
                             sales=[r for r in product.get('sales',[]) if not same_shop(r,visit) and r['time']>=cutoff]))
    found=opportunities(dict(products=products),now=now)
    for deal in found:deal['reference_generated_at']=report.get('generated_at')
    return found


def start_alert_watcher(directories, reports, emit, health):
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
    pending=queue.Queue(maxsize=4096)
    signatures={}
    contents={}
    class Handler(FileSystemEventHandler):
        def on_any_event(self,event):
            if event.is_directory or event.event_type not in ('created','modified','moved'):return
            path=Path(getattr(event,'dest_path','') or event.src_path)
            if not path.name.startswith('shop_') or path.suffix!='.json' or path.stem.endswith('_zh'):return
            try:pending.put_nowait((path,time.perf_counter()))
            except queue.Full:health['fast_alert_error']='File event queue overflow; regular scan remains active'
    def work():
        while True:
            path,detected=pending.get()
            dequeued=time.perf_counter()
            try:
                for attempt in range(10):
                    try:
                        stat=path.stat();signature=(stat.st_mtime_ns,stat.st_size)
                        if signatures.get(path)==signature:break
                        raw=path.read_bytes()
                        digest=hashlib.sha256(raw).digest()
                        # Windows can deliver a final timestamp change after the
                        # complete JSON was already read. Do not emit it twice.
                        if contents.get(path)==digest:
                            signatures[path]=signature
                            break
                        visit=json.loads(raw)
                        base=reports()
                        generated=time.time()
                        # Reports also contain selling metadata, which is not a
                        # pricing window. Watch alerts need no pricing reference.
                        windows={('all' if window is None else str(window)):visit_opportunities(base[window],visit,generated)
                                 for window in (72,None) if base and window in base}
                        watched=visit_listings(visit,generated)
                        signatures[path]=signature
                        contents[path]=digest
                        latency=round((time.time()-stat.st_mtime)*1000,1)
                        health.update(fast_alert_last_at=time.time(),fast_alert_file_to_push_ms=latency,
                                      fast_alert_compute_ms=round((time.time()-generated)*1000,1),
                                      fast_alert_queue_ms=round((dequeued-detected)*1000,1),
                                      fast_alert_event_to_push_ms=round((time.perf_counter()-detected)*1000,1),
                                      fast_alert_error=None)
                        emit(dict(windows=windows,watch_listings=watched,generated_at=time.time(),file_to_push_ms=latency))
                        break
                    except (OSError,ValueError):
                        if attempt==9:raise
                        time.sleep(.02)
            except Exception as error:health['fast_alert_error']=str(error)
    observer=Observer();handler=Handler()
    for directory in dict.fromkeys(directories):
        directory=Path(directory)
        if directory.is_dir():observer.schedule(handler,str(directory),recursive=False)
    observer.start();threading.Thread(target=work,daemon=True).start()
    health['fast_alerts']=True
    return observer
