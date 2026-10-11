"""Offline structural inspection, without assigning unverified protocol names."""
import hashlib
import json
import struct
import zlib
from pathlib import Path


def inspect(body):
    if len(body) != 48 or body[:2] != b'\x70\x00':
        raise ValueError('Expected opcode 0x0070 and 48 bytes')
    a, b = struct.unpack_from('<II', body, 7)
    # These are candidate boundaries, not a recovered schema.
    return {
        'opcode': '0x0070', 'length': len(body),
        'byte_2': body[2], 'u32le_at_3': struct.unpack_from('<I', body, 3)[0],
        'four_byte_blocks_at_7_and_11_equal': a == b,
        'u32le_at_15': struct.unpack_from('<I', body, 15)[0],
        'byte_19': body[19], 'bytes_40_to_47_all_zero': not any(body[40:]),
        'crc32_of_bytes_20_to_39_matches_block_at_7': zlib.crc32(body[20:40]) == a,
        'bytes_20_to_39_equal_sha1_of_prefix': body[20:40] == hashlib.sha1(body[:20]).digest(),
        'bytes_20_to_39_equal_sha1_of_block_at_7': body[20:40] == hashlib.sha1(body[7:11]).digest(),
    }


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace', type=Path)
    args = parser.parse_args()
    results = []
    for line in args.trace.read_text(encoding='utf-8').splitlines():
        record = json.loads(line)
        if ('selected_body_hex' in record and record['direction']=='client_to_server'
                and record['opcode']==0x70 and record['length']==48):
            results.append(dict(index=record['index'], **inspect(bytes.fromhex(record['selected_body_hex']))))
    output = args.trace.with_suffix('.structure70.json')
    output.write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results, indent=2))
