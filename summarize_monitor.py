"""Summarize saved monitor segments without touching live capture."""
from collections import Counter, defaultdict
import json
from pathlib import Path
import struct
import sys
from research_capture import packets


def summarize(folder):
    flows = defaultdict(list)
    files = []
    for path in sorted(folder.glob('*.pcapng')):
        captured = list(packets(path))
        files.append({'file': path.name, 'packets': len(captured)})
        for p in captured:
            flows[(p['src'], p['sport'], p['dst'], p['dport'])].append(p)
    report = {'files': files, 'flows': []}
    for key, ps in flows.items():
        runs = []
        end = None
        gaps = []
        duplicates = len(ps) - len({(p['seq'],p['ack'],p['flags'],p['data']) for p in ps})
        overlap_conflicts = 0
        for p in sorted((p for p in ps if p['data']), key=lambda p:(p['seq'], -len(p['data']))):
            seq, data = p['seq'], p['data']
            if end is None or seq > end:
                if end is not None:
                    gaps.append(seq-end)
                runs.append((seq,bytearray()))
            skip = max(0,end-seq) if end is not None else 0
            base, run = runs[-1]
            if seq>=base and skip:
                overlap = min(skip,len(data))
                if bytes(run[seq-base:seq-base+overlap])!=data[:overlap]:
                    overlap_conflicts += 1
            run.extend(data[skip:])
            end = max(end or seq,seq+len(data))
        messages=[]
        framed_bytes=0
        for seq,run in runs:
            pos=0
            while pos+4<=len(run):
                a,b=struct.unpack_from('<HH',run,pos)
                size=a^b
                if not size or pos+4+size>len(run):
                    break
                messages.append(bytes(run[pos+4:pos+4+size]))
                pos+=4+size
            framed_bytes+=pos
        needles=['Equips and Tings','Equips','Tings','mesos','Silver Ore']
        hits=[]
        for name in needles:
            for encoding in ('utf-8','utf-16-le'):
                if any(name.encode(encoding).lower() in bytes(r).lower() for _,r in runs):
                    hits.append({'text':name,'encoding':encoding})
        report['flows'].append(dict(endpoints=key,packets=len(ps),duplicates=duplicates,
            syn=sum(bool(p['flags']&2) for p in ps),fin=sum(bool(p['flags']&1) for p in ps),
            unique_payload_bytes=sum(len(r) for _,r in runs),gaps=len(gaps),missing_bytes=sum(gaps),
            overlap_conflicts=overlap_conflicts,framed_messages=len(messages),framed_bytes=framed_bytes,
            top_message_lengths=Counter(map(len,messages)).most_common(12),plaintext_hits=hits,
            first_payload_hex=next((p['data'][:12].hex() for p in ps if p['data']),None)))
    events=[json.loads(line) for line in (folder/'events.jsonl').read_text().splitlines()]
    report['started']=events[0]['time']
    report['last_event']=events[-1]
    report['markers']=[e for e in events if e['event']=='user_marker']
    report['disk_bytes']=sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
    (folder/'summary.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    summarize(Path(sys.argv[1]))
