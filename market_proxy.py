"""Loopback SOCKS5 channel proxy with explicit one-shot shop requests.

No credential logging. Server frames are forwarded unchanged. Client frames
are re-encoded with a separate upstream IV after an inserted request.
"""
import asyncio
import ipaddress
import json
import struct
import time
import uuid
from collections import deque
from pathlib import Path
from classicworld_codec import advance, aes_payload, frame_header, opcode_table, shop_plain
from decode_market import length_string
from decode_shops import rows
from market_location import MAP_ENTRY, inspect_map

ROOT = Path(__file__).resolve().parent
ALLOWED = [ipaddress.ip_network(n) for n in ('44.234.166.0/24', '44.234.79.0/24', '44.230.128.0/24', '44.234.161.0/24', '44.234.175.85/32')]


def allowed_destination(host, port, market_only=False):
    address = ipaddress.ip_address(host)
    return (8500 <= port <= 8599 and address.version == 4 and
            (address.is_global if market_only else any(address in n for n in ALLOWED)))


class ClientBridge:
    def __init__(self, iv):
        self.downstream_iv = self.upstream_iv = iv

    def forward(self, header, wire):
        if header != frame_header(len(wire), self.downstream_iv):
            raise ValueError('Client header/IV mismatch')
        synchronized = self.downstream_iv == self.upstream_iv
        plain = aes_payload(wire, self.downstream_iv)
        self.downstream_iv = advance(self.downstream_iv)
        if synchronized:
            self.upstream_iv = advance(self.upstream_iv)
            return header + wire, plain
        return self.insert(plain), plain

    def insert(self, plain):
        frame = frame_header(len(plain), self.upstream_iv) + aes_payload(plain, self.upstream_iv)
        self.upstream_iv = advance(self.upstream_iv)
        return frame


async def read_frame(reader):
    header = await reader.readexactly(4)
    length = int.from_bytes(header[:2], 'little') ^ int.from_bytes(header[2:], 'little')
    if length < 2:
        raise ValueError('Invalid frame size')
    return header, await reader.readexactly(length)


class Session:
    def __init__(self, app, reader, writer, remote_reader, remote_writer, host, port):
        self.app, self.reader, self.writer = app, reader, writer
        self.remote_reader, self.remote_writer = remote_reader, remote_writer
        self.host, self.port = host, port
        self.id = uuid.uuid4().hex[:12]
        self.lock = asyncio.Lock()
        self.table = self.bridge = None
        self.signs = {}
        self.pending_open = None
        self.pending_test = None
        self.shop_open = False
        self.last_test = 0
        self.client_count = self.server_count = 0
        self.closed = False
        self.phases = {'client_to_server': 'not_started', 'server_to_client': 'not_started'}
        self.recent = deque(maxlen=64)
        self.diagnostic_fault = False
        self.first_fault = None
        self.created_monotonic = time.monotonic()
        self.trace_index = 0
        self.pending_raw_path = None
        self.market_location = None

    def trace(self, direction, plain, source='forwarded'):
        if getattr(self.app, 'market_only', False) is True:
            return 0
        op = int.from_bytes(plain[:2], 'little')
        entry = dict(elapsed_ms=round((time.monotonic()-self.created_monotonic)*1000, 3),
                     direction=direction, length=len(plain), opcode=op, source=source,
                     client_frames=self.client_count, server_frames=self.server_count)
        self.trace_index += 1
        entry.update(index=self.trace_index, time=time.time(), stage='observed_before_write')
        if direction == 'client_to_server' and self.table and op in self.table:
            entry['map_index'] = self.table.index(op)
        self.recent.append(entry)
        # Post-map, bounded diagnostic messages only; no login or general traffic bodies.
        sizes = ({0x70: {48}, 0x9C: {149}, 0xC3: {4}}
                 if direction == 'client_to_server' else
                 {0x1B: {48}, 0x72: {9, 66}, 0xCA: {23}, 0x4F: {3}, 0x62B: {2}})
        selected = self.table is not None and len(plain) in sizes.get(op, set())
        if selected:
            entry['body_capture_scope'] = 'paired_diagnostics_v2'
        if self.app.write_trace(self.id, entry, plain if selected else None) is False:
            self.diagnostic_fault = True
        return self.trace_index

    def delivered(self, index, direction):
        if getattr(self.app, 'market_only', False) is True:
            return
        if self.app.write_trace(self.id, dict(index=index, direction=direction,
                stage='write_drain_completed', time=time.time()), None) is False:
            self.diagnostic_fault = True

    async def guarded(self, direction, operation):
        try:
            await operation()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            fault = dict(direction=direction, phase=self.phases[direction],
                         exception=type(error).__name__, errno=getattr(error, 'errno', None),
                         winerror=getattr(error, 'winerror', None),
                         partial_bytes=len(error.partial) if isinstance(error, asyncio.IncompleteReadError) else None,
                         client_frames=self.client_count, server_frames=self.server_count,
                         recent=list(self.recent))
            if self.first_fault is None:
                self.first_fault = fault
            self.event('stream_fault', **fault)
            raise

    async def read_direction(self, reader, direction):
        peer = 'client' if direction == 'client_to_server' else 'server'
        self.phases[direction] = 'read_' + peer + '_header'
        header = await reader.readexactly(4)
        length = int.from_bytes(header[:2], 'little') ^ int.from_bytes(header[2:], 'little')
        if length < 2:
            raise ValueError('Invalid frame size')
        self.phases[direction] = 'read_' + peer + '_body'
        return header, await reader.readexactly(length)

    def summary(self):
        return dict(id=self.id, host=self.host, port=self.port, closed=self.closed,
                    market_location=self.market_location, map_ready=self.table is not None, client_frames=self.client_count,
                    server_frames=self.server_count, shops=list(self.signs.values()),
                    shop_open=self.shop_open, pending_test=self.pending_test,
                    diagnostic_fault=self.diagnostic_fault, phases=self.phases,
                    first_fault=self.first_fault)

    def event(self, kind, **data):
        self.app.event(kind, session=self.id, **data)

    async def run(self):
        size_bytes = await asyncio.wait_for(self.remote_reader.readexactly(2), 10)
        size = int.from_bytes(size_bytes, 'little')
        if size != 19:
            raise ValueError('Unsupported channel greeting length')
        greeting = size_bytes + await self.remote_reader.readexactly(size)
        if greeting[:11].hex() != '1300010001000000010030':
            raise ValueError('Unsupported channel version')
        self.bridge = ClientBridge(greeting[11:15])
        self.siv = greeting[15:19]
        self.writer.write(greeting)
        await self.writer.drain()
        self.event('greeting_validated')
        tasks = [asyncio.create_task(self.guarded('client_to_server', self.client_loop)),
                 asyncio.create_task(self.guarded('server_to_client', self.server_loop))]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def client_loop(self):
        while True:
            header, body = await self.read_direction(self.reader, 'client_to_server')
            async with self.lock:
                self.phases['client_to_server'] = 'validate_and_encode'
                frame, plain = self.bridge.forward(header, body)
                trace_index = self.trace('client_to_server', plain)
                self.phases['client_to_server'] = 'write_server'
                self.remote_writer.write(frame)
                await self.remote_writer.drain()
                self.delivered(trace_index, 'client_to_server')
                self.client_count += 1
                if self.table and int.from_bytes(plain[:2], 'little') == self.table[0xBA]:
                    action = int.from_bytes(plain[2:6], 'little')
                    self.event('client_shop_action', action=action, recent=list(self.recent))
                    # A manual action prevents attributing a subsequent list to Python.
                    if self.pending_test:
                        self.event('test_interrupted_by_client_action')
                        self.pending_test = None
                    if action == 3:
                        self.shop_open = False

    async def server_loop(self):
        while True:
            header, body = await self.read_direction(self.remote_reader, 'server_to_client')
            self.phases['server_to_client'] = 'validate_header'
            if header != frame_header(len(body), self.siv, False):
                raise ValueError('Server header/IV mismatch')
            plain = bytes((b-self.siv[0]) & 255 for b in body)
            self.siv = advance(self.siv)
            trace_index = self.trace('server_to_client', plain)
            # Preserve every server frame and its ordering for the real client.
            self.phases['server_to_client'] = 'write_client'
            self.writer.write(header + body)
            await self.writer.drain()
            self.delivered(trace_index, 'server_to_client')
            self.server_count += 1
            self.phases['server_to_client'] = 'observe'
            try:
                self.observe(plain)
            except Exception as error:
                # Analysis/export failure must not disconnect the player's socket.
                self.diagnostic_fault = True
                self.pending_test = None
                self.event('observer_error', exception=type(error).__name__,
                           error=str(error), opcode=int.from_bytes(plain[:2], 'little'))

    def observe(self, plain):
        op = int.from_bytes(plain[:2], 'little')
        if op == MAP_ENTRY:
            self.market_location = None
            self.signs.clear()
            self.pending_open = None
            self.pending_raw_path = None
            location, evidence = inspect_map(plain)
            observed = time.time()
            if location:
                location.update(time=observed, session=self.id)
                self.market_location = location
            with (self.app.folder / 'map_observations.jsonl').open('a', encoding='utf-8') as out:
                out.write(json.dumps(dict(time=observed, session=self.id, host=self.host,
                    port=self.port, location=location, evidence=evidence))+'\n')
            self.event('map_location', location=location, length=len(plain))
        elif op == 0x32:
            self.table = opcode_table(plain)
            self.event('opcode_map_ready', entries=len(self.table))
        elif op == 0x23A:
            title = length_string(plain, 18)
            if title and len(plain) >= 20:
                shop_id = int.from_bytes(plain[10:14], 'little')
                self.signs[shop_id] = dict(shop_id=shop_id, title=title, observed_at=time.time())
        elif op == 0x577:
            if getattr(self.app, 'market_only', False) is True:
                self.pending_raw_path = self.app.folder / ('raw_shop_' + uuid.uuid4().hex + '.jsonl')
                self.pending_raw_path.write_text(json.dumps(dict(time=time.time(), session=self.id,
                    host=self.host, port=self.port, opcode=op, body_hex=plain.hex()))+'\n', encoding='utf-8')
            title = length_string(plain, 18) if len(plain) > 19 and plain[2] == 2 else None
            if title:
                self.pending_open = (plain, title, int.from_bytes(plain[14:18], 'little'))
                self.shop_open = True
            else:
                self.pending_open = None
        elif op == 0x578 and self.pending_open:
            if self.pending_raw_path:
                with self.pending_raw_path.open('a', encoding='utf-8') as raw:
                    raw.write(json.dumps(dict(time=time.time(), session=self.id, host=self.host,
                        port=self.port, opcode=op, body_hex=plain.hex()))+'\n')
            opened, title, shop_id = self.pending_open
            self.pending_open = None
            if not opened.endswith(plain[6:]):
                self.event('list_rejected', reason='open_tail_mismatch')
                return
            try:
                items = rows(plain)
                for item in items:
                    start = item['offset']
                    item['raw_record_hex'] = plain[start:start+item['record_bytes']].hex()
            except ValueError as error:
                self.event('list_rejected', reason=str(error))
                return
            test = self.pending_test
            from_python = bool(test and test['shop_id'] == shop_id and time.time()-test['sent_at'] < 10)
            result = dict(session=self.id, time=time.time(), title=title, shop_id=shop_id,
                          host=self.host, port=self.port, market_location=self.market_location,
                          raw_source=self.pending_raw_path.name if self.pending_raw_path else None,
                          triggered_by_python=from_python, items=items,
                          prices_require_screen_validation=True)
            if from_python:
                result['request_id'] = test['request_id']
                self.pending_test = None
            path = self.app.folder / f'shop_{uuid.uuid4().hex}.json'
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            self.event('shop_list', title=title, shop_id=shop_id, item_count=len(items),
                       triggered_by_python=from_python, file=path.name, recent=list(self.recent))

    async def request(self, command):
        async with self.lock:
            if not self.app.allow_requests:
                raise ValueError('Diagnostic relay mode: Python requests disabled')
            if self.diagnostic_fault:
                raise ValueError('Observer fault: requests disabled for this session')
            if self.closed or self.table is None or self.bridge is None:
                raise ValueError('Session not ready')
            action = command['action']
            if action == 'open':
                shop_id = int(command['shop_id'])
                if shop_id not in self.signs or time.time()-self.signs[shop_id]['observed_at'] > 180:
                    raise ValueError('Shop must have a recently observed sign in this session')
                if self.shop_open or self.pending_test or time.time()-self.last_test < 10:
                    raise ValueError('Already in a shop, awaiting reply, or request rate limit')
                plain = shop_plain(self.table, 2, shop_id)
                self.pending_test = dict(shop_id=shop_id, sent_at=time.time(), request_id=command['request_id'])
            elif action == 'close':
                if not self.shop_open:
                    raise ValueError('No known open shop')
                plain = shop_plain(self.table, 3)
                self.shop_open = False
                self.pending_test = None
            else:
                raise ValueError('Only open and close are supported')
            self.last_test = time.time()
            trace_index = self.trace('client_to_server', plain, source='python')
            try:
                self.remote_writer.write(self.bridge.insert(plain))
                await self.remote_writer.drain()
                self.delivered(trace_index, 'client_to_server')
            except Exception as error:
                self.closed = True
                self.pending_test = None
                self.event('request_write_fault', exception=type(error).__name__,
                           winerror=getattr(error, 'winerror', None), recent=list(self.recent))
                self.remote_writer.close()
                self.writer.close()
                raise
            self.event('python_request_sent', action=action, request_id=command['request_id'],
                       shop_id=command.get('shop_id'), recent=list(self.recent))


class Proxy:
    def __init__(self, folder, allow_requests=False, market_only=False):
        if market_only and allow_requests:
            raise ValueError('Market collection cannot enable active requests')
        self.market_only = market_only
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.sessions = {}
        self.seen_requests = set()
        self.allow_requests = allow_requests
        self.trace_bytes = 0
        self.trace_limit = 32 * 1024 * 1024
        self.trace_failed = False

    def write_trace(self, session_id, entry, selected_body=None):
        """Continuous, bounded local diagnostics. Never print message bodies."""
        if self.trace_failed:
            return False
        record = dict(session=session_id, **entry)
        if selected_body is not None:
            record['selected_body_hex'] = selected_body.hex()
            record['body_scope'] = 'post_map_client_0x70_length48_only'
        encoded = (json.dumps(record, ensure_ascii=True)+'\n').encode('utf-8')
        try:
            if self.trace_bytes + len(encoded) > self.trace_limit:
                raise OSError('Continuous trace size limit reached')
            with (self.folder / ('frames_' + session_id + '.jsonl')).open('ab') as out:
                out.write(encoded)
            self.trace_bytes += len(encoded)
            return True
        except OSError as error:
            self.trace_failed = True
            self.event('continuous_trace_failed', error=str(error))
            return False

    def event(self, kind, **fields):
        data = dict(time=time.time(), event=kind, **fields)
        try:
            with (self.folder/'events.jsonl').open('a', encoding='utf-8') as out:
                out.write(json.dumps(data, ensure_ascii=False)+'\n')
        except OSError:
            # Logging is observational; an unavailable disk must not kill relay.
            pass
        try:
            print(json.dumps(data, ensure_ascii=True), flush=True)
        except OSError:
            pass

    async def accept(self, reader, writer):
        remote_writer = None
        session = None
        try:
            head = await asyncio.wait_for(reader.readexactly(2), 5)
            if head[0] != 5 or head[1] == 0:
                raise ValueError('SOCKS5 required')
            methods = await asyncio.wait_for(reader.readexactly(head[1]), 5)
            if 0 not in methods:
                writer.write(b'\x05\xff')
                await writer.drain()
                return
            writer.write(b'\x05\x00')
            await writer.drain()
            request = await asyncio.wait_for(reader.readexactly(4), 5)
            if request != b'\x05\x01\x00\x01':
                raise ValueError('Only IPv4 TCP CONNECT supported')
            address = await asyncio.wait_for(reader.readexactly(6), 5)
            host = str(ipaddress.ip_address(address[:4]))
            port = struct.unpack('!H', address[4:])[0]
            if not allowed_destination(host, port, self.market_only):
                raise ValueError('Destination outside configured game-channel scope')
            rr, remote_writer = await asyncio.wait_for(asyncio.open_connection(host, port), 8)
            writer.write(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00')
            await writer.drain()
            session = Session(self, reader, writer, rr, remote_writer, host, port)
            self.sessions[session.id] = session
            session.event('connected', host=host, port=port)
            await session.run()
        except asyncio.IncompleteReadError:
            self.event('connection_closed', session=session.id if session else None)
        except Exception as error:
            self.event('connection_error', session=session.id if session else None, error=str(error))
        finally:
            if session:
                session.closed = True
            for stream in (writer, remote_writer):
                if stream:
                    stream.close()
                    try:
                        await stream.wait_closed()
                    except OSError:
                        pass

    async def controls(self):
        while True:
            for session in list(self.sessions.values()):
                if session.pending_test and time.time()-session.pending_test['sent_at'] > 10:
                    session.event('test_timeout', **session.pending_test)
                    session.pending_test = None
            status = dict(listening='127.0.0.1:1088', allow_requests=self.allow_requests,
                          updated_at=time.time(), sessions=[s.summary() for s in self.sessions.values()])
            temporary = self.folder/'status.tmp'
            try:
                temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
                temporary.replace(self.folder/'status.json')
            except OSError as error:
                self.event('status_write_error', error=str(error))
            command_path = self.folder/'command.json'
            if command_path.exists():
                try:
                    cmd = json.loads(command_path.read_text(encoding='utf-8-sig'))
                    command_path.unlink()
                    request_id = cmd['request_id']
                    if request_id in self.seen_requests:
                        raise ValueError('Duplicate command')
                    self.seen_requests.add(request_id)
                    await self.sessions[cmd['session']].request(cmd)
                except Exception as error:
                    self.event('command_rejected', error=str(error))
            await asyncio.sleep(0.25)

    async def run(self):
        server = await asyncio.start_server(self.accept, '127.0.0.1', 1088)
        self.event('listening', address='127.0.0.1:1088')
        async with server:
            await asyncio.gather(server.serve_forever(), self.controls())


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, default=ROOT/'network_captures'/'proxy_live')
    parser.add_argument('--allow-requests', action='store_true', help='Explicitly enable experimental Python shop requests')
    parser.add_argument('--market-only', action='store_true', help='Passive market snapshots; no protocol diagnostic bodies')
    args = parser.parse_args()
    asyncio.run(Proxy(args.folder, allow_requests=args.allow_requests, market_only=args.market_only).run())
