"""Offline summary of proxy frame metadata and selected 48-byte messages.
Outputs offsets/timings/hashes; never prints captured message bodies.
"""
import argparse
import hashlib
import json
from pathlib import Path


def analyze(path):
    records=[]
    incomplete=False
    lines=path.read_text(encoding='utf-8').splitlines()
    for i,line in enumerate(lines):
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            if i!=len(lines)-1:
                raise
            incomplete=True
    frames=[r for r in records if r['stage']=='observed_before_write']
    completed={r['index'] for r in records if r['stage']=='write_drain_completed'}
    injections=[r for r in frames if r['source']=='python']
    split=injections[0]['index'] if injections else None
    samples=[r for r in frames if 'selected_body_hex' in r
             and r['direction']=='client_to_server' and r['opcode']==0x70 and r['length']==48]
    bodies=[bytes.fromhex(r['selected_body_hex']) for r in samples]
    all_samples=[]
    for r,b in zip(samples,bodies):
        predecessors=[x for x in frames if 0<=r['time']-x['time']<=1 and x['index']<r['index']]
        all_samples.append(dict(index=r['index'],elapsed_ms=r['elapsed_ms'],
            phase='after_insertion' if split and r['index']>split else 'before_insertion',
            sha256=hashlib.sha256(b).hexdigest(),
            drain_completed=r['index'] in completed,
            preceding_second=[{k:x.get(k) for k in ('index','direction','opcode','map_index','length')} for x in predecessors]))
    return dict(file=str(path),partial_last_record=incomplete,total_frames=len(frames),
        contiguous_indexes=[r['index'] for r in frames]==list(range(1,len(frames)+1)),
        writes_without_completion=[r['index'] for r in frames if r['index'] not in completed],
        inserted_requests=len(injections),selected_48_samples=all_samples,
        variable_byte_offsets=[i for i in range(48) if len({b[i] for b in bodies})>1] if bodies else [],
        interpretation='Drain completion is a local write result, not proof of server acceptance; opcode meaning unconfirmed.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace',type=Path)
    args=parser.parse_args()
    result=analyze(args.trace)
    output=args.trace.with_suffix('.analysis.json')
    output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
