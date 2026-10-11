"""Offline pcapng diagnostics. No game or network access."""
import collections
import json
from pathlib import Path
import re
import struct
import sys


def packets(path):
    raw = path.read_bytes()
    offset, endian = 0, '<'
    while offset + 12 <= len(raw):
        if raw[offset:offset+4] == b'\x0a\x0d\x0d\x0a':
            endian = '<' if raw[offset+8:offset+12] == b'\x4d\x3c\x2b\x1a' else '>'
        kind, size = struct.unpack_from(endian+'II', raw, offset)
        if size < 12 or offset+size > len(raw):
            raise ValueError('Invalid block')
        body = raw[offset+8:offset+size-4]
        offset += size
        if kind == 6:
            interface, hi, lo, caplen, original = struct.unpack_from(endian+'IIIII', body)
            frame = body[20:20+caplen]
            if len(frame) < 54 or frame[12:14] != b'\x08\x00':
                continue
            ip = frame[14:]
            if ip[9] != 6:
                continue
            ihl = (ip[0]&15)*4
            total = int.from_bytes(ip[2:4], 'big')
            if total < ihl:
                # Offload-stage captures may not yet have an IPv4 total length.
                total = len(ip)
            tcp = ip[ihl:total]
            if len(tcp) < 20:
                continue
            sport, dport, seq, ack = struct.unpack_from('!HHII', tcp)
            thl = (tcp[12]>>4)*4
            data = tcp[thl:]
            yield dict(time=(hi<<32|lo)/1e6, caplen=caplen, original=original,
                       ip_total=total, available_ip=len(ip), seq=seq, ack=ack,
                       src='.'.join(map(str,ip[12:16])), dst='.'.join(map(str,ip[16:20])),
                       sport=sport, dport=dport, flags=tcp[13], data=data,
                       declared_payload=total-ihl-thl)


def research(path):
    ps = list(packets(path))
    groups = collections.defaultdict(list)
    for p in ps:
        groups[(p['src'],p['sport'],p['dst'],p['dport'])].append(p)
    output = dict(packet_count=len(ps), capture_truncated=sum(p['caplen']<p['original'] for p in ps),
                  ipv4_truncated=sum(p['available_ip']<p['ip_total'] for p in ps), flows=[])
    origin = min(p['time'] for p in ps)
    for key, group in groups.items():
        payloads = [p for p in group if p['data']]
        if not payloads:
            continue
        # Keep contiguous runs separate: gaps are never silently concatenated.
        runs, end = [], None
        gaps = []
        for p in sorted(payloads,key=lambda p:p['seq']):
            if end is None or p['seq']>end:
                if end is not None:
                    gaps.append(p['seq']-end)
                runs.append(bytearray())
            skip = max(0,end-p['seq']) if end is not None else 0
            runs[-1].extend(p['data'][skip:])
            end = max(end or p['seq'],p['seq']+len(p['data']))
        combined = b''.join(runs)
        # Legacy Maple framing candidate: LE16(first) XOR LE16(second) gives length.
        framing = []
        messages = []
        for run in runs:
            pos, lengths = 0, []
            while pos+4<=len(run):
                a,b = struct.unpack_from('<HH',run,pos)
                length = a^b
                if length == 0 or pos+4+length>len(run):
                    break
                lengths.append(length)
                messages.append(bytes(run[pos+4:pos+4+length]))
                pos += 4+length
            framing.append(dict(run_bytes=len(run), parsed_bytes=pos, lengths=lengths))
        transform_hits = []
        words = [b'entered', b'silver', b'store', b'mesos', b'illustrated', b'hunter', b'mithril', b'leave', b'price']
        if key[1] == 8550:
            for mi, msg in enumerate(messages):
                for rotation in range(8):
                    rotated = msg.translate(bytes(((b<<rotation)|(b>>(8-rotation)))&255 for b in range(256)))
                    for mask in range(256):
                        decoded = rotated.translate(bytes(b^mask for b in range(256)))
                        hits = [w.decode() for w in words if w in decoded.lower()]
                        if hits:
                            transform_hits.append(dict(message=mi,length=len(msg),rotation=rotation,mask=mask,words=hits))
        output['flows'].append(dict(endpoints=list(key), payload_packets=len(payloads),
            captured_bytes=sum(len(p['data']) for p in payloads),
            declared_bytes=sum(p['declared_payload'] for p in payloads),
            gap_sizes=gaps, contiguous_run_sizes=[len(r) for r in runs],
            top_bytes=[(hex(b),n) for b,n in collections.Counter(combined).most_common(8)],
            ascii_strings_count=sum(len(re.findall(rb'[ -~]{6,}',r)) for r in runs),
            rotate_xor_keyword_hits=transform_hits,
            modal_xor_experiment=[dict(length=len(msg),
                dominant_byte=collections.Counter(msg).most_common(1)[0][0],
                dominant_fraction=round(collections.Counter(msg).most_common(1)[0][1]/len(msg),3),
                transformed_prefix=bytes(b^collections.Counter(msg).most_common(1)[0][0] for b in msg[:32]).hex())
                for msg in messages if len(msg)>=20],
            legacy_xor_framing=framing,
            timeline=[dict(t=round(p['time']-origin,3),seq=p['seq'],length=len(p['data']),
                declared=p['declared_payload'],head=p['data'][:16].hex()) for p in payloads]))
    dest = path.with_name('research.json')
    dest.write_text(json.dumps(output,indent=2),encoding='utf-8')
    for flow in output['flows']:
        flow['timeline'] = flow['timeline'][:8]
    print(json.dumps(output,indent=2))


if __name__ == '__main__':
    research(Path(sys.argv[1]))
