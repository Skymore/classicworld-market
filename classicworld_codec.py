"""Offline Classic World capture codec; no sockets or live traffic.

Algorithm references: zhyonc/msnet v1.2.0 (MIT; msnet_reference/LICENSE).
IV update imported from probe_session_crypto (MapleLib GPL attribution there).
Validated only against the 2026-10-10 capture, not other game versions.
"""
import json
import struct
from pathlib import Path
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
try:
    from cryptography.hazmat.decrepit.ciphers.modes import OFB
except ImportError:
    from cryptography.hazmat.primitives.ciphers.modes import OFB
from probe_session_crypto import advance

AES_KEY = bytes.fromhex('0f0000001b000000c500000046000000f3000000be000000ff00000075000000')
DES_KEY = b'G0dD@mnN#H@ckEr!'
SHOP_MAP_INDEX = 0xBA  # Empirical mapping-table index, not an imported opcode name.


def aes_payload(data, iv):
    if len(iv) != 4:
        raise ValueError('IV must be four bytes')
    output = bytearray()
    offset, chunk_size = 0, 1456
    while offset < len(data):
        chunk = data[offset:offset + chunk_size]
        cipher = Cipher(algorithms.AES(AES_KEY), OFB(iv * 4)).encryptor()
        output.extend(cipher.update(chunk) + cipher.finalize())
        offset += len(chunk)
        chunk_size = 1460
    return bytes(output)


def frame_header(length, iv, client=True):
    if len(iv) != 4 or not 0 <= length <= 65535:
        raise ValueError('Invalid IV or frame length')
    first = int.from_bytes(iv[2:4], 'little') ^ (223 if client else 65534)
    return struct.pack('<HH', first, first ^ length)


def opcode_table(plain):
    if len(plain) < 6 or plain[:2] != b'\x32\0':
        raise ValueError('Not an opcode-map message')
    size = struct.unpack_from('<I', plain, 2)[0]
    if size != len(plain) - 6 or size % 8:
        raise ValueError('Invalid encrypted map size')
    cipher = Cipher(TripleDES(DES_KEY + DES_KEY[:8]), modes.ECB()).decryptor()
    raw = (cipher.update(plain[6:]) + cipher.finalize()).rstrip(b'\0 ')
    fields = raw.split(b'|')
    if not all(v.isdigit() for v in fields):
        raise ValueError('Invalid map text')
    count, *values = map(int, fields)
    if count != len(values) or any(v > 65535 for v in values) or len(set(values)) != count:
        raise ValueError('Invalid map entries')
    return values


def shop_plain(table, action, shop_id=None):
    """Construct only observed enter (2) and leave (3) message shapes."""
    if action not in (2, 3):
        raise ValueError('Only observed enter/leave actions supported')
    if action == 2 and (shop_id is None or not 0 <= shop_id <= 0xffffffff):
        raise ValueError('Enter requires uint32 shop ID')
    if action == 3 and shop_id is not None:
        raise ValueError('Leave has no shop ID field')
    body = struct.pack('<HI', table[SHOP_MAP_INDEX], action)
    return body + (struct.pack('<I', shop_id) if action == 2 else b'')


def encode_shop_request(table, iv, action, shop_id=None):
    plain = shop_plain(table, action, shop_id)
    return frame_header(len(plain), iv) + aes_payload(plain, iv), advance(iv)


def audit(folder):
    streams = json.loads((folder / 'session_streams.json').read_text())
    result = {'offline_only': True, 'connections': [], 'shop_actions': []}
    for server in streams:
        if not server['greeting_hex']:
            continue
        flow = server['flow']
        client = next(s for s in streams if s['flow'] == [flow[2], flow[3], flow[0], flow[1]])
        if any(s['gap_bytes'] or s['unparsed_bytes'] for s in (server, client)):
            raise ValueError('Incomplete TCP stream')
        greeting = bytes.fromhex(server['greeting_hex'])
        siv, civ = greeting[15:19], greeting[11:15]
        table = None
        map_time = None
        response_times = []
        for message in server['messages']:
            wire = bytes.fromhex(message['body'])
            assert frame_header(len(wire), siv, False).hex() == message['header']
            plain = bytes((b - siv[0]) & 255 for b in wire)
            assert bytes((b + siv[0]) & 255 for b in plain) == wire
            if plain[:2] == b'\x32\0':
                table = opcode_table(plain)
                map_time = message['time']
            if plain[:3] == b'\x77\x05\x02' and b'cheap cheap' in plain:
                response_times.append(message['time'])
            siv = advance(siv)
        if table is None:
            raise ValueError('No opcode map')
        mapped_count = 0
        for message in client['messages']:
            wire = bytes.fromhex(message['body'])
            assert frame_header(len(wire), civ).hex() == message['header']
            plain = aes_payload(wire, civ)
            assert aes_payload(plain, civ) == wire
            mapped_count += int(int.from_bytes(plain[:2], 'little') in table)
            if len(plain) in (6, 10) and int.from_bytes(plain[:2], 'little') == table[SHOP_MAP_INDEX]:
                assert message['time'] >= map_time
                action = int.from_bytes(plain[2:6], 'little')
                shop_id = int.from_bytes(plain[6:10], 'little') if action == 2 else None
                rebuilt, next_iv = encode_shop_request(table, civ, action, shop_id)
                assert rebuilt.hex() == message['header'] + message['body']
                assert next_iv == advance(civ)
                row = dict(local_port=flow[3], time=message['time'], action=action,
                           shop_id=shop_id, map_index=SHOP_MAP_INDEX, mapped_opcode=table[SHOP_MAP_INDEX],
                           plain=plain.hex(), iv=civ.hex(), frame=rebuilt.hex(), exact_roundtrip=True)
                if action == 2:
                    matches = [t for t in response_times if 0 <= t-message['time'] < 0.1]
                    assert len(matches) == 1
                    row['response_delay_ms'] = round((matches[0]-message['time'])*1000, 3)
                result['shop_actions'].append(row)
            civ = advance(civ)
        result['connections'].append(dict(local_port=flow[3], opcode_map_entries=len(table),
            shop_mapped_opcode=table[SHOP_MAP_INDEX], client_frames=len(client['messages']),
            server_frames=len(server['messages']), client_mapped_frames=mapped_count,
            all_headers_match=True, all_client_crypto_roundtrips=True))
    (folder / 'verified_shop_protocol.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    print(json.dumps(audit(parser.parse_args().folder), indent=2))
