"""Read pcapng Ethernet/IPv4/TCP data locally; report aggregate payload traits."""
import collections
import hashlib
import json
import math
from pathlib import Path
import struct
import sys


def inspect(path):
    raw = path.read_bytes()
    offset = 0
    endian = '<'
    interfaces = []
    flows = collections.defaultdict(list)
    packets = 0
    while offset + 12 <= len(raw):
        if raw[offset:offset+4] == b'\x0a\x0d\x0d\x0a':
            endian = '<' if raw[offset+8:offset+12] == b'\x4d\x3c\x2b\x1a' else '>'
            interfaces = []
        kind, size = struct.unpack_from(endian+'II', raw, offset)
        if size < 12 or offset + size > len(raw):
            raise ValueError('Invalid pcapng block')
        body = raw[offset+8:offset+size-4]
        offset += size
        if kind == 1:
            interfaces.append(struct.unpack_from(endian+'H', body)[0])
        if kind != 6:
            continue
        interface, hi, lo, caplen, original = struct.unpack_from(endian+'IIIII', body)
        packet = body[20:20+caplen]
        packets += 1
        if interfaces[interface] != 1 or len(packet) < 34:
            continue
        start = 14
        ethertype = struct.unpack_from('!H', packet, 12)[0]
        while ethertype in (0x8100, 0x88a8):
            ethertype = struct.unpack_from('!H', packet, start+2)[0]
            start += 4
        if ethertype != 0x800:
            continue
        ip = packet[start:]
        ihl = (ip[0] & 15)*4
        if ip[9] != 6 or struct.unpack_from('!H', ip, 6)[0] & 0x3fff:
            continue
        total = struct.unpack_from('!H', ip, 2)[0]
        src = '.'.join(map(str, ip[12:16]))
        dst = '.'.join(map(str, ip[16:20]))
        tcp = ip[ihl:total]
        if len(tcp) < 20:
            continue
        sport, dport, seq = struct.unpack_from('!HHI', tcp)
        data = tcp[(tcp[12] >> 4)*4:]
        if data:
            flows[(src, sport, dst, dport)].append((seq, data))
    summary = {'packets': packets, 'flows': []}
    for key, segments in flows.items():
        ordered = sorted(set(segments))
        stream = bytearray()
        expected = None
        gaps = 0
        for seq, data in ordered:
            if expected is not None and seq > expected:
                gaps += 1
            skip = max(0, expected-seq) if expected is not None else 0
            stream.extend(data[skip:])
            expected = max(expected or seq, seq+len(data))
        counts = collections.Counter(stream)
        entropy = -sum((n/len(stream))*math.log2(n/len(stream)) for n in counts.values())
        tls_records = []
        pos = 0
        while pos + 5 <= len(stream):
            typ, major, minor = stream[pos:pos+3]
            length = int.from_bytes(stream[pos+3:pos+5], 'big')
            if typ not in (20,21,22,23) or major != 3 or minor > 4 or length > 18432 or pos+5+length > len(stream):
                break
            tls_records.append({'type': typ, 'length': length})
            pos += 5+length
        summary['flows'].append(dict(source=f'{key[0]}:{key[1]}', destination=f'{key[2]}:{key[3]}',
            payload_packets=len(segments), unique_payload_bytes=len(stream), sequence_gaps=gaps,
            first_12_bytes=stream[:12].hex(), entropy=round(entropy,3),
            printable_fraction=round(sum(32 <= b < 127 for b in stream)/len(stream),3),
            tls_records=tls_records, tls_bytes_parsed=pos,
            contains_mesos=b'mesos' in stream.lower(), contains_silver_ore=b'silver ore' in stream.lower()))
    out = path.with_name('inspection.json')
    out.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    inspect(Path(sys.argv[1]))
