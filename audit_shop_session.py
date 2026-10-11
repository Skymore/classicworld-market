"""Audit TCP continuity and greeting framing without assuming a game cipher."""
from pathlib import Path
from collections import defaultdict
import json
from research_capture import packets

def streams(folder):
    groups=defaultdict(list)
    for path in sorted(folder.glob('*.pcapng')):
        for p in packets(path):
            if p['sport'] in range(8500,8600) or p['dport'] in range(8500,8600):
                groups[(p['src'],p['sport'],p['dst'],p['dport'])].append(p)
    result=[]
    for flow,ps in groups.items():
        syns={p['seq'] for p in ps if p['flags']&2}
        runs=[];end=None;gaps=[]
        for p in sorted((p for p in ps if p['data']),key=lambda p:(p['seq'],-len(p['data']))):
            seq=p['seq']
            if end is None or seq>end:
                if end is not None:gaps.append(seq-end)
                runs.append([seq,bytearray()])
            skip=max(0,(end or seq)-seq)
            runs[-1][1].extend(p['data'][skip:]);end=max(end or seq,seq+len(p['data']))
        out={'flow':flow,'syn_seen':bool(syns),'gap_bytes':sum(gaps),'gaps':gaps,
             'greeting_hex':None,'messages':[],'unparsed_bytes':0}
        for base,data in runs:
            pos=0
            if flow[1] in range(8500,8600) and base-1 in syns and len(data)>=2:
                length=int.from_bytes(data[:2],'little')
                if 8<=length<=128 and len(data)>=length+2:
                    out['greeting_hex']=bytes(data[:length+2]).hex();pos=length+2
            while pos+4<=len(data):
                length=int.from_bytes(data[pos:pos+2],'little')^int.from_bytes(data[pos+2:pos+4],'little')
                if not length or pos+4+length>len(data):break
                seq=base+pos
                stamps=[p['time'] for p in ps if p['seq']<=seq<p['seq']+len(p['data'])]
                out['messages'].append({'seq':seq,'time':min(stamps),'header':bytes(data[pos:pos+4]).hex(),'body':bytes(data[pos+4:pos+4+length]).hex()})
                pos+=4+length
            out['unparsed_bytes']+=len(data)-pos
        result.append(out)
    return result

if __name__=='__main__':
    import sys
    folder=Path(sys.argv[1]);result=streams(folder)
    (folder/'session_streams.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps([{**{k:v for k,v in r.items() if k!='messages'},'message_count':len(r['messages'])} for r in result],indent=2))
