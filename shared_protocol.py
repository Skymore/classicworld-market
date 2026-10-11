"""Privacy boundary and versioned upload schema; never uploads network bodies."""
import hashlib
import json
import math
import time
from market_equipment import decode_equipment, FIELDS


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('Invalid integer')
    return value


def text(value, size):
    if not isinstance(value,str) or not value or len(value)>size or any(ord(c)<32 for c in value):
        raise ValueError('Invalid text')
    return value


def validate(data, now=None):
    now=time.time() if now is None else now
    if not isinstance(data,dict) or data.get('version')!=1:
        raise ValueError('Unsupported schema')
    observed=data.get('observed_at')
    if type(observed) not in (int,float) or not math.isfinite(observed) or not now-30*86400<=observed<=now+120:
        raise ValueError('Observation outside 30-day upload window or clock is ahead')
    location=data.get('location')
    if location is not None:
        channel=integer(location['channel'],1,18)
        room=integer(location['room'],0,22)
        location=dict(channel=channel,room=room,map_id=80002000+room)
    result=dict(version=1,observation_id=text(data['observation_id'],64),observed_at=observed,
                world='ClassicWorld',shop_id=integer(data['shop_id'],1,2**32-1),
                title=text(data['title'],120),location=location,items=[])
    if data.get('world')!='ClassicWorld' or data.get('complete') is not True:
        raise ValueError('Complete ClassicWorld snapshots required')
    result['complete']=True
    if not isinstance(data['items'],list) or len(data['items'])>200:
        raise ValueError('Too many items')
    slots=set()
    for row in data['items']:
        slot=integer(row['slot'],1,200)
        iid=integer(row['item_id'],1000000,5999999)
        category=integer(row.get('category',iid//1000000),1,6)
        if category!=6 and category!=iid//1000000:raise ValueError('Category mismatch')
        slots.add((category,slot))
        item=dict(slot=slot,category=category,item_id=iid,price=integer(row['price'],0,10**12),
                  bundle=integer(row['bundle'],1,10**6),stock=integer(row['stock'],0,10**6))
        eq=row.get('equipment')
        if iid//1000000==1:
            item['equipment']=dict(status='unsupported',stats=[],remaining_upgrades=None,unknown_fields=[])
            if isinstance(eq,dict) and eq.get('status')=='candidate':
                known={k:label for k,label in FIELDS.values()}; stats=[]; used=set()
                for stat in eq.get('stats',[]):
                    key=stat['key']
                    if key not in known or key in used:raise ValueError('Invalid equipment field')
                    used.add(key);stats.append(dict(key=key,label=known[key],value=integer(stat['value'],0,65535)))
                unknown=eq.get('unknown_fields',[])
                if len(unknown)>17:raise ValueError('Invalid unknown fields')
                unknown=[dict(bit=integer(s['bit'],0,16),value=integer(s['value'],0,65535)) for s in unknown]
                upgrades=eq.get('remaining_upgrades')
                if upgrades is not None:integer(upgrades,0,15)
                item['equipment']=dict(status='candidate',parser='cw_equipment_v1',
                    stats=sorted(stats,key=lambda s:s['key']),remaining_upgrades=upgrades,
                    unknown_fields=sorted(unknown,key=lambda s:s['bit']),note='包内解析值，待同件截图核对')
                if eq.get('enhancements') is not None:
                    item['equipment']['enhancements']=integer(eq['enhancements'],0,15)
        result['items'].append(item)
    result['items'].sort(key=lambda r:(r['category'],r['slot']))
    return result


def from_snapshot(data, location=None):
    if data.get('triggered_by_python'):raise ValueError('Active experiments cannot be shared')
    payload=dict(version=1,world='ClassicWorld',complete=True,
        observation_id=digest([data['session'],data['time'],data['shop_id']]),
        observed_at=data['time'],shop_id=data['shop_id'],title=data['title'],
        location=location if location is not None else data.get('market_location'),items=[])
    for row in data['items']:
        payload['items'].append(dict(item_id=row['item_id'],slot=row['slot'],
            category=row.get('category',row['item_id']//1000000),
            price=row['price_mesos_candidate'],bundle=row['bundle_quantity_candidate'],
            stock=row['available_quantity_candidate'],
            equipment=decode_equipment(row.get('raw_record_hex',''),row['item_id'])))
    return validate(payload)
