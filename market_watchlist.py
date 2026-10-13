"""Catalogue lookup and observed listings for browser-owned watchlists."""
from contextlib import closing
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import time
from market_equipment import decode_equipment

ARCHER_PRESET = (1452003,1452004,1462003,1462004)


def search_catalog(path, query='', limit=40):
    if not Path(path).exists():
        return dict(items=[], presets=[])
    query=str(query).strip()[:100]
    with closing(sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
        def item(row):
            iid,zh,en,icon,raw=row
            record=json.loads(raw)
            return dict(item_id=iid,name_zh=zh or str(iid),name_en=en or '',icon_url=icon,
                        level=record.get('level'),subcategory=record.get('category'))
        select='SELECT item_id,name_zh,name_en,icon_url,record_json FROM items'
        if query.isdecimal():
            iid=int(query)
            results=db.execute(select+' WHERE item_id=?',(iid,)).fetchall() if 1000000<=iid<=5999999 else []
        elif query:
            pattern='%'+query.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
            results=db.execute(select+" WHERE name_zh LIKE ? ESCAPE '\\' OR name_en LIKE ? ESCAPE '\\' ORDER BY item_id LIMIT ?",
                               (pattern,pattern,limit)).fetchall()
        else:
            results=[]
        presets=db.execute(select+' WHERE item_id IN (?,?,?,?) ORDER BY item_id',ARCHER_PRESET).fetchall()
    return dict(items=[item(row) for row in results],
                presets=[dict(id='archer_25_30',name_zh='25 / 30级弓与弩',
                              name_en='Level 25 / 30 bows & crossbows',items=[item(row) for row in presets])])


def listing(row):
    """Keep instance stats; stock-only changes retain the same notification ID."""
    iid,slot=row.get('item_id'),row.get('slot')
    if type(iid) is not int or not 1000000<=iid<=5999999 or type(slot) is not int or slot<1:return None
    price,bundle,stock=row.get('price'),row.get('bundle'),row.get('stock')
    if (any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (price,bundle,stock))
            or price<0 or bundle<=0 or stock<=0 or not math.isfinite(price/bundle) or row.get('experimental')):
        return None
    observed=row.get('time')
    if isinstance(observed,bool) or not isinstance(observed,(int,float)) or not math.isfinite(observed):return None
    world=row.get('world','ClassicWorld')
    # A shop ID can be reused across dates. Do not suppress tomorrow's offer.
    identity=[world,row['shop_key'],int(observed//86400),row['item_id'],row['slot'],row.get('variant','standard')]
    key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()[:24]
    offer=hashlib.sha256(json.dumps([key,price,bundle]).encode()).hexdigest()[:24]
    return dict(id=offer,listing_key=key,world=world,item_id=row['item_id'],slot=row['slot'],
                observed=observed,shop=row['shop'],location=row.get('location'),price=price,bundle=bundle,
                unit_price=price/bundle,stock=stock,equipment=row.get('equipment'),
                name_zh=row.get('name_zh'),name_en=row.get('name_en'),
                requires_validation=row.get('requires_validation',True))


def report_listings(report, item_ids, limit=200):
    selected=set(item_ids)
    results=[]
    for product in report.get('products',[]):
        if product['item_id'] not in selected:continue
        for row in product.get('quotes',[]):
            result=listing(row)
            if result:results.append(result)
    results.sort(key=lambda r:(-r['observed'],r['id']))
    return dict(listings=results[:limit],total=len(results),truncated=len(results)>limit,
                generated_at=report.get('generated_at'),hours=report.get('hours'))


def visit_listings(visit,now=None):
    """Fresh completed passive visits, independent of price-reference readiness."""
    now=time.time() if now is None else now
    observed=visit.get('time')
    if (visit.get('triggered_by_python') or isinstance(observed,bool)
            or not isinstance(observed,(int,float)) or not 0<=now-observed<=120):return []
    world=visit.get('world','ClassicWorld')
    shop_key=json.dumps([world,visit.get('host','legacy'),visit.get('port',0),visit['shop_id'],visit['title']])
    results=[]
    for item in visit.get('items',[]):
        iid=item['item_id'];raw=item.get('raw_record_hex','')
        variant=(hashlib.sha256(bytes.fromhex(raw)[20:]).hexdigest()[:16] if iid//1000000==1 and raw
                 else 'unknown' if iid//1000000==1 else 'standard')
        row=dict(world=world,shop_key=shop_key,shop=visit['title'],item_id=iid,slot=item['slot'],variant=variant,
                 time=observed,price=item['price_mesos_candidate'],bundle=item['bundle_quantity_candidate'],
                 stock=item['available_quantity_candidate'],location=visit.get('market_location'),
                 equipment=item.get('shared_equipment') or decode_equipment(raw,iid),
                 requires_validation=visit.get('prices_require_screen_validation',True))
        result=listing(row)
        if result:results.append(result)
    return results


def parse_item_ids(value):
    parts=value.split(',') if value else []
    if len(parts)>100 or any(not p.isdecimal() or not 1000000<=int(p)<=5999999 for p in parts):
        raise ValueError('Expected at most 100 item IDs')
    return set(map(int,parts))
