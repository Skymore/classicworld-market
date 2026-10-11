"""Compare selected diagnostic bodies offline; output structure, not raw bodies."""
import collections
import json
from pathlib import Path


def analyze(path):
    records = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
    frames = [r for r in records if r['stage'] == 'observed_before_write']
    completed = {r['index'] for r in records if r['stage'] == 'write_drain_completed'}
    inserted = [r for r in frames if r['source'] == 'python']
    split = inserted[0]['index'] if inserted else float('inf')
    groups = collections.defaultdict(list)
    for r in frames:
        if 'selected_body_hex' in r:
            groups[(r['direction'], r['opcode'], r['length'])].append(r)
    summary = []
    for (direction, opcode, length), rows in groups.items():
        before = [bytes.fromhex(r['selected_body_hex']) for r in rows if r['index'] < split]
        after = [bytes.fromhex(r['selected_body_hex']) for r in rows if r['index'] > split]
        varying = [i for i in range(length) if len({b[i] for b in before}) > 1]
        new_changes = [i for i in range(length) if before and i not in varying
                       and any(b[i] != before[0][i] for b in after)]
        summary.append(dict(direction=direction, opcode=hex(opcode), length=length,
            before_count=len(before), after_count=len(after), baseline_variable_offsets=varying,
            after_changes_to_baseline_constant_offsets=new_changes))
    pairs = []
    for r in frames:
        if r['direction'] != 'client_to_server' or r['opcode'] != 0x9c or 'selected_body_hex' not in r:
            continue
        prev = next((s for s in reversed(frames[:r['index']-1])
                     if s['direction']=='server_to_client' and s['opcode']==0x1b and 'selected_body_hex' in s), None)
        if prev is None:
            continue
        a, b = bytes.fromhex(prev['selected_body_hex']), bytes.fromhex(r['selected_body_hex'])
        matches = [(i,j) for i in (32,40) for j in range(2,len(b)-3)
                   if any(a[i:i+4]) and a[i:i+4]==b[j:j+4]]
        pairs.append(dict(server_index=prev['index'],client_index=r['index'],
                          delay_ms=round((r['time']-prev['time'])*1000,3),
                          matching_four_byte_offsets=matches))
    return dict(total_frames=len(frames), contiguous_indexes=[r['index'] for r in frames]==list(range(1,len(frames)+1)),
        writes_without_completion=[r['index'] for r in frames if r['index'] not in completed],
        inserted_requests=len(inserted), groups=summary, candidate_pairs=pairs,
        caveat='Temporal pairs and matching bytes do not establish message semantics or causation.')


if __name__ == '__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace',type=Path)
    args=parser.parse_args()
    result=analyze(args.trace)
    args.trace.with_suffix('.paired.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
