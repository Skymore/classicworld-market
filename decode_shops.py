"""Infer shop list rows, validating count and duplicate bytes in the shop-open record."""
from pathlib import Path
from datetime import datetime, timezone
import json
import struct
import sys
import csv
from decode_market import messages, subtract, length_string


def rows(data):
    if len(data)<8 or data[:6]!=b'\x78\x05\0\0\0\0':
        raise ValueError('Unexpected list header')
    count=int.from_bytes(data[6:8],'little')
    candidates=[]
    for pos in range(8,len(data)-26+1):
        category,slot,stock,bundle,price=struct.unpack_from('<HHIIQ',data,pos)
        marker,kind=data[pos+20:pos+22]
        item_id=int.from_bytes(data[pos+22:pos+26],'little')
        if (1<=category<=6 and 1<=slot<=200 and stock<=1000000 and 1<=bundle<=1000000
            and 0<=price<=1000000000000 and marker==1 and kind in (1,2,3)
            and 1<=item_id//1000000<=5 and (category==6 or item_id//1000000==category)
            and (kind==1)==(item_id//1000000==1)):
            candidates.append(dict(offset=pos,category=category,slot=slot,
                available_quantity_candidate=stock,bundle_quantity_candidate=bundle,
                price_mesos_candidate=price,item_id=item_id,item_kind=kind))
    if len(candidates)!=count or (count and candidates[0]['offset']!=8):
        raise ValueError(f'Row count mismatch: expected {count}, found {len(candidates)}')
    for i,r in enumerate(candidates):
        end=candidates[i+1]['offset'] if i+1<len(candidates) else len(data)
        r['record_bytes']=end-r['offset']
        if r['record_bytes']<26:
            raise ValueError('Overlapping candidate rows')
    return candidates


def decode(folder):
    shops=[]
    errors=[]
    pending={}
    for index,msg in enumerate(messages(folder)):
        if msg['flow'][1] not in range(8500,8600) or len(msg['body'])<2:
            continue
        # Hypothesis: these server opcodes have high byte 0x05.
        d=subtract(msg['body'],(msg['body'][1]-5)&255)
        opcode=int.from_bytes(d[:2],'little')
        if opcode==0x577:
            if len(d)>19 and d[2]==2:
                title=length_string(d,18)
                if title:
                    pending[msg['flow']]=(index,msg,d,title)
            elif len(d)<20:
                pending.pop(msg['flow'],None)
        elif opcode==0x578:
            prior=pending.pop(msg['flow'],None)
            if prior is None:
                errors.append(dict(index=index,error='No preceding decoded shop title'))
                continue
            pi,pm,pd,title=prior
            if not pd.endswith(d[6:]):
                errors.append(dict(index=index,title=title,error='List differs from preceding shop-open tail'))
                continue
            try:
                items=rows(d)
            except ValueError as error:
                errors.append(dict(index=index,title=title,error=str(error)))
                continue
            shops.append(dict(title=title,open_message=pi,list_message=index,
                time_utc=datetime.fromtimestamp(msg['time'],timezone.utc).isoformat(),
                list_seq=msg['seq'],matching_open_tail=True,row_count=len(items),items=items))
    output=dict(status='experimental_schema_requires_screen_price_validation',
        shop_visits=len(shops),rows=sum(s['row_count'] for s in shops),shops=shops,rejected=errors)
    (folder/'decoded_shops.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    with (folder/'shop_rows_candidates.csv').open('w',newline='',encoding='utf-8-sig') as file:
        writer=csv.writer(file)
        writer.writerow(['shop','time_utc','item_id','price_mesos_candidate','available_quantity_candidate','bundle_quantity_candidate','category','slot','requires_screen_validation'])
        for shop in shops:
            for item in shop['items']:
                writer.writerow([shop['title'],shop['time_utc'],item['item_id'],item['price_mesos_candidate'],item['available_quantity_candidate'],item['bundle_quantity_candidate'],item['category'],item['slot'],True])
    print(json.dumps(output,indent=2))


if __name__=='__main__':
    decode(Path(sys.argv[1]))
