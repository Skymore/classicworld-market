"""Bounded, local-only, receive-only movement protocol research.

Stores small game messages only after a recognized free-market map entry.
No packet injection, forwarding, or process memory access.
"""
import json
import queue
import struct
import threading
import time
from pathlib import Path
from classicworld_codec import advance, aes_payload, frame_header, opcode_table
from market_location import inspect_map
from market_passive import Stream, Sniffer, game_owner, LIMIT

FILTER = ('ip and tcp and !loopback and ((inbound and tcp.SrcPort >= 8500 and '
          'tcp.SrcPort <= 8599) or (outbound and tcp.DstPort >= 8500 and tcp.DstPort <= 8599))')


def packet(raw):
    if len(raw) < 40 or raw[0] >> 4 != 4 or raw[9] != 6:
        return None
    ihl = (raw[0] & 15) * 4
    total = int.from_bytes(raw[2:4], 'big')
    if ihl < 20 or total > len(raw) or total < ihl + 20 or int.from_bytes(raw[6:8], 'big') & 0x3fff:
        return None
    tcp = raw[ihl:total]
    offset = (tcp[12] >> 4) * 4
    if offset < 20 or offset > len(tcp):
        return None
    sport, dport, seq = struct.unpack_from('!HHI', tcp)
    src = '.'.join(map(str, raw[12:16])); dst = '.'.join(map(str, raw[16:20]))
    if 8500 <= sport <= 8599:
        return (src, sport, dst, dport), 'server', seq, tcp[13], tcp[offset:]
    if 8500 <= dport <= 8599:
        return (dst, dport, src, sport), 'client', seq, tcp[13], tcp[offset:]
    return None


class Session:
    def __init__(self, emit):
        self.emit = emit
        self.buffers = {'client': bytearray(), 'server': bytearray()}
        self.ivs = None
        self.table = []
        self.location = None
        self.counts = {'client': 0, 'server': 0}

    def feed(self, direction, data):
        self.buffers[direction].extend(data)
        if any(len(b) > LIMIT for b in self.buffers.values()):
            raise ValueError('Frame buffer limit')
        if self.ivs is None:
            greeting = self.buffers['server']
            if len(greeting) < 21:
                return
            if greeting[:11].hex() != '1300010001000000010030':
                raise ValueError('Unsupported greeting')
            self.ivs = {'client': bytes(greeting[11:15]), 'server': bytes(greeting[15:19])}
            del greeting[:21]
            self.emit('handshake')
        # Decode server first so map/opcode metadata is available to the client.
        for side in ('server', 'client'):
            buf = self.buffers[side]
            while len(buf) >= 4:
                header = bytes(buf[:4]); a, b = struct.unpack('<HH', header); size = a ^ b
                iv = self.ivs[side]
                if size < 2 or header != frame_header(size, iv, side == 'client'):
                    raise ValueError('Frame/IV mismatch')
                if len(buf) < size + 4:
                    break
                wire = bytes(buf[4:4+size]); del buf[:4+size]
                plain = aes_payload(wire, iv) if side == 'client' else bytes((v-iv[0]) & 255 for v in wire)
                self.ivs[side] = advance(iv); self.counts[side] += 1
                op = int.from_bytes(plain[:2], 'little')
                if side == 'server' and op == 0x32:
                    try:
                        self.table = opcode_table(plain)
                        self.emit('opcode_map', entries=len(self.table))
                    except ValueError as error:
                        # Mapping semantics do not affect frame boundaries or IV
                        # advancement. Preserve this protocol-only evidence and
                        # continue decoding with the raw client opcode.
                        self.table = []
                        self.emit('opcode_map_unparsed', reason=str(error), body=plain.hex())
                if side == 'server' and op == 0x1a6:
                    self.location, _ = inspect_map(plain)
                    self.emit('location', location=self.location)
                if self.location:
                    index = self.table.index(op) if side == 'client' and op in self.table else None
                    self.emit('message', direction=side, number=self.counts[side], opcode=op,
                              map_index=index, length=len(plain), location=self.location,
                              body=plain.hex() if len(plain) <= 512 and op != 0x32 else None)


def run(folder, seconds, position_output=None):
    from market_position_feed import PositionTracker, publish_position
    tracker = PositionTracker() if position_output else None
    if position_output:
        position_output.parent.mkdir(parents=True, exist_ok=True)
    def publish():
        if tracker:
            publish_position(position_output,dict(tracker.state, feed_time=time.time()))
    folder.mkdir(parents=True, exist_ok=True)
    output = (folder/'movement.jsonl').open('a', encoding='utf-8')
    def emit(event, **fields):
        row = dict(time=time.time(), event=event, **fields)
        if tracker:
            try:tracker.consume(row)
            except (ValueError, KeyError, TypeError) as error:tracker.invalidate(str(error))
            # Continuous navigation mode retains derived position only.
            # Short packet bodies are recorded only in bounded diagnostic mode.
            if event == 'message':return
            row.pop('body', None)
        if output.tell() > 64*LIMIT:
            raise RuntimeError('Diagnostic size limit')
        output.write(json.dumps(row)+'\n'); output.flush()
    flows = {}; packets = queue.Queue(8192); overflow = threading.Event()
    sniffer = Sniffer(FILTER)
    def receive():
        while sniffer.handle is not None:
            try:
                raw = sniffer.recv()
                packets.put_nowait(raw)
            except queue.Full:
                overflow.set()
            except OSError:
                overflow.set(); return
    thread = threading.Thread(target=receive, daemon=True); thread.start()
    started = time.monotonic()
    emit('capture_started', seconds=seconds, mode='SNIFF|RECV_ONLY')
    try:
        while not seconds or time.monotonic()-started < seconds:
            if (folder/'stop.request').exists():
                break
            if overflow.is_set():
                raise RuntimeError('Capture overflow or receive failure; reconnect required')
            try:
                raw = packets.get(timeout=.1)
            except queue.Empty:
                raw = b''
            now = time.monotonic()
            item = packet(raw)
            if item:
                key, side, seq, flags, data = item
                if flags & 2:
                    flow = flows.setdefault(key, dict(streams={}, buffers={'client':bytearray(), 'server':bytearray()},
                                                     session=None, started=now, check=0, dead=False))
                    flow['streams'].setdefault(side, Stream(seq+1))
                flow = flows.get(key)
                if flow and not flow['dead']:
                    try:
                        if data:
                            if side not in flow['streams']:
                                raise ValueError('Missing directional SYN')
                            chunk = flow['streams'][side].feed(seq + bool(flags & 2), data, now)
                            if flow['session']:
                                flow['session'].feed(side, chunk)
                            else:
                                flow['buffers'][side].extend(chunk)
                                if sum(map(len, flow['buffers'].values())) > LIMIT:
                                    raise ValueError('Ownership buffer limit')
                        if flags & 5:
                            flow['dead'] = True; emit('disconnected', session=key[3])
                    except ValueError as error:
                        flow['dead'] = True; emit('invalidated', session=key[3], reason=str(error))
            for key, flow in list(flows.items()):
                if flow['dead']:
                    del flows[key]; continue
                try:
                    if flow['session'] is None and now >= flow['check']:
                        flow['check'] = now + .25
                        if game_owner(key):
                            flow['session'] = Session(lambda event, k=key, **fields: emit(event, session=k[3], **fields))
                            for side in ('server', 'client'):
                                flow['session'].feed(side, flow['buffers'][side]); flow['buffers'][side].clear()
                        elif now-flow['started'] > 5:
                            flow['dead'] = True
                    if any(s.gap_since is not None and now-s.gap_since > 5 for s in flow['streams'].values()):
                        raise ValueError('TCP gap timeout')
                except ValueError as error:
                    flow['dead'] = True; emit('invalidated', session=key[3], reason=str(error))
            publish()
    finally:
        sniffer.close(); thread.join(timeout=2)
        emit('capture_stopped'); publish(); output.close()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=600)
    parser.add_argument('--position-output', type=Path)
    args = parser.parse_args()
    if not (1 <= args.seconds <= 900 or args.seconds == 0 and args.position_output):
        parser.error('seconds must be 1..900; 0 requires --position-output (derived coordinates only)')
    run(args.folder, args.seconds, args.position_output)
