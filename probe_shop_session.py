"""One bounded live connection: check prerequisites without replaying credentials."""
import json
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from classicworld_codec import advance, frame_header, opcode_table


def probe(host, port):
    report = dict(host=host, port=port, application_bytes_sent=0,
                  opcode_map_received=False, shop_request_sent=False,
                  time_utc=datetime.now(timezone.utc).isoformat())
    buffer = bytearray()
    greeting = None
    iv = None
    frames = 0
    received = 0
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=5) as connection:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                connection.settimeout(max(0.01, deadline-time.monotonic()))
                try:
                    chunk = connection.recv(65536)
                except socket.timeout:
                    report['end_reason'] = 'observation_timeout'
                    break
                if not chunk:
                    report['end_reason'] = 'server_closed_connection'
                    break
                received += len(chunk)
                buffer.extend(chunk)
                if received > 1048576:
                    raise ValueError('Observation size limit exceeded')
                if greeting is None:
                    if len(buffer) < 2:
                        continue
                    size = int.from_bytes(buffer[:2], 'little') + 2
                    if not 10 <= size <= 128:
                        raise ValueError('Unexpected greeting length')
                    if len(buffer) < size:
                        continue
                    greeting = bytes(buffer[:size])
                    del buffer[:size]
                    if len(greeting) != 21 or greeting[:11].hex() != '1300010001000000010030':
                        raise ValueError('Unrecognized greeting format')
                    report['greeting_bytes'] = len(greeting)
                    report['greeting_hex'] = greeting.hex()
                    iv = greeting[15:19]
                while len(buffer) >= 4:
                    size = int.from_bytes(buffer[:2], 'little') ^ int.from_bytes(buffer[2:4], 'little')
                    if bytes(buffer[:4]) != frame_header(size, iv, False):
                        raise ValueError('Unexpected frame header')
                    if len(buffer) < 4+size:
                        break
                    plain = bytes((b-iv[0])&255 for b in buffer[4:4+size])
                    del buffer[:4+size]
                    iv = advance(iv)
                    frames += 1
                    if plain[:2] == b'\x32\0':
                        table = opcode_table(plain)
                        report.update(opcode_map_received=True, opcode_map_entries=len(table))
    except (OSError, ValueError) as error:
        report['error'] = str(error)
    report.update(received_bytes=received, post_greeting_frames=frames,
                  remaining_bytes=len(buffer), elapsed_seconds=round(time.monotonic()-started, 3))
    report['result'] = ('map_observed_but_authenticated_session_not_established' if report['opcode_map_received']
                        else 'cannot_construct_current_session_shop_request_without_map')
    folder = Path(__file__).parent / 'network_captures' / 'live_shop_probe'
    folder.mkdir(exist_ok=True)
    target = folder / (datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')+'.json')
    target.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host')
    parser.add_argument('port', type=int)
    args = parser.parse_args()
    probe(args.host, args.port)
