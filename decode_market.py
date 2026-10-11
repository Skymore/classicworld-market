"""Offline exploratory decoder. Inferred transforms are not confirmed protocol fields."""
from collections import defaultdict, Counter
from pathlib import Path
import json
import re
import struct
import sys
import hashlib
from datetime import datetime, timezone
from research_capture import packets


def messages(folder):
    flows = defaultdict(list)
    for path in sorted(folder.glob('*.pcapng')):
        for p in packets(path):
            if (p['data'] or p['flags']&2) and (p['sport'] in range(8500,8600) or p['dport'] in range(8500,8600)):
                flows[(p['src'],p['sport'],p['dst'],p['dport'])].append(p)
    for flow, ps in flows.items():
        runs=[]
        end=None
        for p in sorted((p for p in ps if p['data']),key=lambda p:(p['seq'],-len(p['data']))):
            seq,data=p['seq'],p['data']
            if end is None or seq>end:
                runs.append([seq,p['time'],bytearray()])
            skip=max(0,end-seq) if end is not None else 0
            runs[-1][2].extend(data[skip:])
            end=max(end or seq,seq+len(data))
        for base,t,run in runs:
            pos=0
            # Observed CW greeting: length-prefixed 19-byte body, sent at SYN+1.
            if (flow[1] in range(8500,8600) and len(run)>=21
                and run[:11]==bytes.fromhex('1300010001000000010030')
                and any(p['flags']&2 and p['seq']+1==base for p in ps)):
                pos=21
            while pos+4<=len(run):
                a,b=struct.unpack_from('<HH',run,pos)
                size=a^b
                if not size or pos+size+4>len(run):
                    break
                starts = [p['time'] for p in ps if p['seq'] <= base+pos < p['seq']+len(p['data'])]
                yield dict(flow=flow,seq=base+pos,time=min(starts) if starts else t,header=bytes(run[pos:pos+4]),body=bytes(run[pos+4:pos+4+size]))
                pos+=size+4


def subtract(body, key):
    return body.translate(bytes((b-key)&255 for b in range(256)))


def length_string(data, offset):
    if offset+2 > len(data):
        return None
    size=int.from_bytes(data[offset:offset+2],'little')
    if size == 0 or offset+2+size > len(data):
        return None
    text=data[offset+2:offset+2+size]
    if any(b < 32 or b > 126 for b in text):
        return None
    return text.decode('ascii')


def decode_known(body):
    """Validate observed schemas. No key inferred merely from a word match."""
    if len(body)<5:
        return None
    key=body[1]
    decoded=subtract(body,key)
    text=length_string(decoded,3)
    if decoded[:3]==b'\xae\x00\x03' and text and ' : ' in text:
        return dict(kind='chat_text',opcode='0x00ae',key=key,text=text,decoded_hex=decoded.hex())
    key=(body[1]-2)&255
    decoded=subtract(body,key)
    name=length_string(decoded,18)
    if decoded[:2]==b'\x2a\x02' and name and len(name)<=30:
        return dict(kind='entity_record_candidate',opcode='0x022a',key=key,name=name,
                    entity_id_candidate=int.from_bytes(decoded[2:6],'little'),
                    strings=[s.decode() for s in re.findall(rb'[ -~]{5,}',decoded)],decoded_hex=decoded.hex())
    return None


def export(folder):
    records=[]
    server_count=0
    repeat=defaultdict(list)
    for i,msg in enumerate(messages(folder)):
        if msg['flow'][1] not in range(8500,8600):
            continue
        server_count+=1
        found=decode_known(msg['body'])
        if found:
            digest=hashlib.sha256(bytes.fromhex(found['decoded_hex'])).hexdigest()
            record=dict(index=i,seq=msg['seq'],time_utc=datetime.fromtimestamp(msg['time'],timezone.utc).isoformat(),
                        payload_length=len(msg['body']),**found)
            records.append(record)
            repeat[digest].append(record)
    summary=dict(server_messages=server_count,validated_chat_records=sum(r['kind']=='chat_text' for r in records),
                 entity_record_candidates=sum(r['kind']=='entity_record_candidate' for r in records),
                 repeated_identical_decoded_groups=[dict(indices=[r['index'] for r in group],
                     distinct_keys=len({r['key'] for r in group})) for group in repeat.values() if len(group)>1],
                 exact_shop_name_found=any('equips and tings' in json.dumps(r).lower() for r in records),
                 prices_decoded=False)
    (folder/'decoded_messages.json').write_text(json.dumps(dict(summary=summary,messages=records),indent=2),encoding='utf-8')
    (folder/'decoded_chat.txt').write_text('\n'.join(
        f"{r['time_utc']} [seq={r['seq']}] {r['text']}" for r in records if r['kind']=='chat_text')+'\n',encoding='utf-8')
    print(json.dumps(summary,indent=2))


def explore(folder):
    result=[]
    needles=[b'equips and tings',b'equips',b'tings',b'entered',b'silver',b'mesos',b'store',b'selling',b'buying']
    tables=[bytes((b-mask)&255 for b in range(256)) for mask in range(256)]
    for index,msg in enumerate(messages(folder)):
        if msg['flow'][1] not in range(8500,8600):
            continue
        for mask,table in enumerate(tables):
            decoded=msg['body'].translate(table)
            hits=[s.decode() for s in needles if s in decoded.lower()]
            if hits:
                result.append(dict(index=index,seq=msg['seq'],length=len(decoded),mask=mask,header=msg['header'].hex(),
                    words=hits,strings=[s.decode('ascii') for s in re.findall(rb'[ -~]{5,}',decoded)],prefix=decoded[:24].hex()))
    (folder/'decode_candidates.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    folder=Path(sys.argv[1])
    if '--export' in sys.argv:
        export(folder)
    else:
        explore(folder)
