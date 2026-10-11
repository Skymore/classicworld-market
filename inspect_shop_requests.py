"""Offline correlation only. Does not open sockets or send game traffic."""
from pathlib import Path
import json
from collections import Counter
from decode_market import messages, subtract, length_string

def inspect(folder):
    all_messages=sorted(messages(folder),key=lambda m:m['time'])
    clients=[m for m in all_messages if m['flow'][3] in range(8500,8600)]
    signs=[]
    for m in all_messages:
        if m['flow'][1] not in range(8500,8600) or len(m['body'])<20:continue
        d=subtract(m['body'],(m['body'][1]-2)&255)
        title=length_string(d,18)
        if d[:2]==b'\x3a\x02' and title:
            signs.append(dict(title=title,flow=m['flow'],time=m['time'],
                map_entity_id_candidate=int.from_bytes(d[2:6],'little'),
                shop_id_candidate=int.from_bytes(d[10:14],'little')))
    result=[]
    for m in all_messages:
        if m['flow'][1] not in range(8500,8600) or len(m['body'])<20:continue
        d=subtract(m['body'],(m['body'][1]-5)&255)
        if d[:3]!=b'\x77\x05\x02':continue
        title=length_string(d,18)
        if not title:continue
        reverse=(m['flow'][2],m['flow'][3],m['flow'][0],m['flow'][1])
        prior=[c for c in clients if c['flow']==reverse and 0<=m['time']-c['time']<=1]
        result.append(dict(title=title,server_seq=m['seq'],server_prefix=d[:20].hex(),
            shop_id_candidate=int.from_bytes(d[14:18],'little'),
            matching_signs_any_time=[s for s in signs if s['title']==title and s['flow']==m['flow']
                and s['shop_id_candidate']==int.from_bytes(d[14:18],'little')],
            matching_prior_signs=[s for s in signs if s['title']==title and s['flow']==m['flow']
                and s['time']<=m['time'] and s['shop_id_candidate']==int.from_bytes(d[14:18],'little')],
            preceding=[dict(delta_ms=round((m['time']-c['time'])*1000,2),seq=c['seq'],
                length=len(c['body']),header=c['header'].hex(),wire=c['body'].hex(),
                relative_to_second_byte=subtract(c['body'],c['body'][1]).hex() if len(c['body'])>=2 else '') for c in prior[-8:]]))
    output=dict(client_messages=len(clients),client_lengths=dict(Counter(len(c['body']) for c in clients)),shops=result)
    (folder/'shop_request_candidates.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    print(json.dumps(dict(client_messages=len(clients),shop_responses=len(result),
        shops_with_matching_prior_sign_id=sum(bool(s['matching_prior_signs']) for s in result),
        shops_with_matching_sign_id_any_time=sum(bool(s['matching_signs_any_time']) for s in result),
        output=str(folder/'shop_request_candidates.json')),indent=2))

if __name__=='__main__':
    import sys
    inspect(Path(sys.argv[1]))
