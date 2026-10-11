import json
import tempfile
import unittest
import asyncio
from unittest.mock import Mock
from pathlib import Path
from classicworld_codec import advance, aes_payload, frame_header, shop_plain
from market_proxy import ClientBridge, Proxy, Session

CAPTURE = Path(__file__).parent/'network_captures/shop_session_20261010_170336/session_streams.json'


class ProxyTests(unittest.TestCase):
    def test_continuous_trace_survives_ring_eviction_and_scopes_bodies(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            assert Path(tmp).resolve().parent == Path(__file__).resolve().parent
            app = Proxy(Path(tmp))
            s = Session(app, None, None, None, None, 'test', 0)
            packet = b'\x70\0' + bytes(46)
            s.trace('client_to_server', packet)
            s.table = [1]
            for _ in range(100):
                index = s.trace('client_to_server', packet)
                s.delivered(index, 'client_to_server')
            s.trace('client_to_server', b'\x99\0'+bytes(147))
            records = [json.loads(l) for l in (Path(tmp)/('frames_'+s.id+'.jsonl')).read_text().splitlines()]
            frames = [r for r in records if r['stage']=='observed_before_write']
            self.assertEqual(len(s.recent), 64)
            self.assertEqual(len(frames), 102)
            self.assertEqual([r['index'] for r in frames], list(range(1,103)))
            self.assertNotIn('selected_body_hex', frames[0])
            self.assertNotIn('selected_body_hex', frames[-1])
            self.assertEqual(sum('selected_body_hex' in r for r in frames),100)

    def test_trace_limit_is_visible_and_does_not_raise(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            assert Path(tmp).resolve().parent == Path(__file__).resolve().parent
            app=Proxy(Path(tmp));app.trace_limit=1;app.event=Mock()
            self.assertFalse(app.write_trace('test',dict(index=1),None))
            self.assertTrue(app.trace_failed)
            app.event.assert_called_once()

    def test_paired_bodies_are_direction_size_and_post_map_scoped(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            app = Proxy(Path(tmp))
            s = Session(app, None, None, None, None, 'test', 0)
            packet = b'\x1b\0' + bytes(46)
            s.trace('server_to_client', packet)  # Before map: metadata only.
            s.table = [1]
            s.trace('server_to_client', packet)
            s.trace('client_to_server', packet)  # Wrong direction.
            s.trace('server_to_client', packet + b'x')  # Unknown size.
            s.trace('client_to_server', b'\x9c\0' + bytes(147))
            frames = [json.loads(l) for l in (Path(tmp)/('frames_'+s.id+'.jsonl')).read_text().splitlines()]
            self.assertEqual([r['index'] for r in frames if 'selected_body_hex' in r], [2, 5])

    def setUp(self):
        self.streams = json.loads(CAPTURE.read_text())
        self.server = next(s for s in self.streams if s['greeting_hex'] and s['flow'][3] == 50965)
        self.client = next(s for s in self.streams if s['flow'][1] == 50965)
        self.initial_iv = bytes.fromhex(self.server['greeting_hex'])[11:15]

    def test_unmodified_forward_matches_every_captured_frame(self):
        bridge = ClientBridge(self.initial_iv)
        for msg in self.client['messages']:
            frame, _ = bridge.forward(bytes.fromhex(msg['header']), bytes.fromhex(msg['body']))
            self.assertEqual(frame.hex(), msg['header']+msg['body'])

    def test_insert_preserves_remaining_client_messages(self):
        bridge = ClientBridge(self.initial_iv)
        upstream = self.initial_iv
        table = [0]*875
        table[0xba] = 0xd42a
        for i, msg in enumerate(self.client['messages']):
            if i == 20:
                plain = shop_plain(table, 2, 5830)
                added = bridge.insert(plain)
                self.assertEqual(added[:4], frame_header(len(plain), upstream))
                self.assertEqual(aes_payload(added[4:], upstream), plain)
                upstream = advance(upstream)
            outgoing, plain = bridge.forward(bytes.fromhex(msg['header']), bytes.fromhex(msg['body']))
            self.assertEqual(outgoing[:4], frame_header(len(plain), upstream))
            self.assertEqual(aes_payload(outgoing[4:], upstream), plain)
            upstream = advance(upstream)
        self.assertEqual(bridge.upstream_iv, upstream)
        self.assertNotEqual(bridge.upstream_iv, bridge.downstream_iv)

    def test_real_server_stream_parses_maps_signs_and_lists(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            assert Path(tmp).resolve().parent == Path(__file__).resolve().parent
            app = Proxy(Path(tmp))
            app.event = lambda *a, **kw: None
            session = Session(app, None, None, None, None, 'test', 0)
            iv = bytes.fromhex(self.server['greeting_hex'])[15:19]
            for msg in self.server['messages']:
                plain = bytes((b-iv[0])&255 for b in bytes.fromhex(msg['body']))
                iv = advance(iv)
                session.observe(plain)
            self.assertEqual(len(session.table), 875)
            self.assertEqual(session.signs[5830]['title'], 'cheap cheap')
            outputs = [json.loads(p.read_text(encoding='utf-8')) for p in Path(tmp).glob('shop_*.json')]
            self.assertEqual(len(outputs), 3)
            self.assertTrue(all(len(r['items']) == 4 for r in outputs))
            self.assertTrue(all(not r['triggered_by_python'] for r in outputs))

    def test_mismatched_iv_rejected(self):
        bridge = ClientBridge(self.initial_iv)
        msg = self.client['messages'][1]
        with self.assertRaises(ValueError):
            bridge.forward(bytes.fromhex(msg['header']), bytes.fromhex(msg['body']))


class Writer:
    def __init__(self):
        self.data = bytearray()
        self.closed = False

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    def session(self):
        app = Mock()
        app.allow_requests = False
        reader, remote = asyncio.StreamReader(), asyncio.StreamReader()
        s = Session(app, reader, Writer(), remote, Writer(), 'test', 0)
        s.bridge = ClientBridge(bytes.fromhex('3098ff3c'))
        s.siv = bytes.fromhex('679a5bee')
        return s

    async def test_observer_failure_does_not_drop_following_frames(self):
        s = self.session()
        iv = s.siv
        expected = bytearray()
        for plain in (b'\x32\x00bad map', b'\x01\x00next'):
            wire = bytes((b+iv[0])&255 for b in plain)
            frame = frame_header(len(wire), iv, False)+wire
            expected.extend(frame)
            # Split header/body to exercise stream framing independently of TCP chunks.
            for byte in frame:
                s.remote_reader.feed_data(bytes([byte]))
            iv = advance(iv)
        s.remote_reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await s.guarded('server_to_client', s.server_loop)
        self.assertEqual(s.writer.data, expected)
        self.assertEqual(s.server_count, 2)
        self.assertTrue(s.diagnostic_fault)
        self.assertEqual(s.first_fault['phase'], 'read_server_header')
        self.assertEqual(s.first_fault['direction'], 'server_to_client')

    async def test_client_partial_frame_fault_is_identifiable(self):
        s = self.session()
        s.reader.feed_data(b'\x01\x02')
        s.reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await s.guarded('client_to_server', s.client_loop)
        self.assertEqual(s.first_fault['phase'], 'read_client_header')
        self.assertEqual(s.first_fault['partial_bytes'], 2)
        self.assertEqual(s.remote_writer.data, b'')

    async def test_diagnostic_mode_cannot_insert_requests(self):
        s = self.session()
        with self.assertRaisesRegex(ValueError, 'requests disabled'):
            await s.request(dict(action='open', shop_id=13148, request_id='test'))
        self.assertEqual(s.remote_writer.data, b'')

    async def test_client_write_fault_is_not_misreported_as_server_read(self):
        s = self.session()
        plain = b'\x01\x00'
        wire = bytes((b+s.siv[0])&255 for b in plain)
        s.remote_reader.feed_data(frame_header(len(wire), s.siv, False)+wire)
        s.writer.write = Mock(side_effect=ConnectionResetError('simulated client reset'))
        with self.assertRaises(ConnectionResetError):
            await s.guarded('server_to_client', s.server_loop)
        self.assertEqual(s.first_fault['phase'], 'write_client')
        self.assertEqual(s.first_fault['exception'], 'ConnectionResetError')

    async def test_tcp_forward_insertion_then_client_traffic(self):
        # Real loopback sockets: downstream IV must remain unchanged by insertion.
        iv = bytes.fromhex('3098ff3c')
        bridge = ClientBridge(iv)
        async def relay(reader, writer):
            from market_proxy import read_frame
            header, wire = await read_frame(reader)
            packet, _ = bridge.forward(header, wire)
            writer.write(packet)
            writer.write(bridge.insert(b'\x2a\xd4\x02\0\0\0\xc6\x16\0\0'))
            header, wire = await read_frame(reader)
            packet, _ = bridge.forward(header, wire)
            writer.write(packet)
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_server(relay, '127.0.0.1', 0)
        try:
            reader, writer = await asyncio.open_connection('127.0.0.1', server.sockets[0].getsockname()[1])
            first, second = b'\x12\x34one', b'\x56\x78two'
            writer.write(frame_header(len(first), iv)+aes_payload(first, iv))
            next_iv = advance(iv)
            writer.write(frame_header(len(second), next_iv)+aes_payload(second, next_iv))
            await writer.drain()
            from market_proxy import read_frame
            for expected in (first, b'\x2a\xd4\x02\0\0\0\xc6\x16\0\0', second):
                header, wire = await asyncio.wait_for(read_frame(reader), 3)
                self.assertEqual(header, frame_header(len(wire), iv))
                self.assertEqual(aes_payload(wire, iv), expected)
                iv = advance(iv)
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()


if __name__ == '__main__':
    unittest.main()
