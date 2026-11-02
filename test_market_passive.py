import struct
import tempfile
import unittest
import json
from unittest.mock import patch
from pathlib import Path
from market_passive import Stream,Decoder,Collector,packet,SNIFF_RECV_ONLY
from classicworld_codec import frame_header,advance


def raw(seq,data=b'',flags=0x18):
    ip=bytearray(20);ip[0]=0x45;ip[2:4]=struct.pack('!H',40+len(data));ip[9]=6
    ip[12:16]=bytes([44,230,128,74]);ip[16:20]=bytes([192,168,1,5])
    tcp=bytearray(20);struct.pack_into('!HHI',tcp,0,8501,51000,seq);tcp[12]=0x50;tcp[13]=flags
    return bytes(ip+tcp)+data


class PassiveTests(unittest.TestCase):
    def test_inventory_delta_publishes_without_waiting_for_status_tick(self):
        from test_market_inventory import character, update
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            collector=Collector(folder)
            session=SimpleNamespace(id='stream',observe=lambda plain:None)
            observe=collector.observer(session)
            observe(character())
            path=Path(folder)/'inventory_state.json'
            initial=json.loads(path.read_text())['holdings']
            observe(update(struct.pack('<BBhH',1,2,2,101)))
            current=json.loads(path.read_text())['holdings']
            self.assertEqual(current['session'],'stream')
            self.assertGreater(current['revision'],initial['revision'])
            self.assertEqual(next(i['quantity'] for i in current['items'] if i['item_id']==2000001),190)
            with patch.object(collector,'publish_inventory') as publish:
                observe(bytes.fromhex('7e00000001010000000000'))  # Non-money stat update.
                publish.assert_not_called()
            collector.invalidate_inventory('stream')
            self.assertIsNone(json.loads(path.read_text())['holdings'])

    def test_busy_status_file_does_not_stop_capture_or_retry_every_packet(self):
        with tempfile.TemporaryDirectory() as folder:
            collector=Collector(folder)
            collector.tick(now=10)
            path=Path(folder)/'passive_status.json'
            previous=path.read_bytes()
            with patch.object(Path,'replace',side_effect=PermissionError('reader holds file')) as replace:
                collector.tick(now=13)
                collector.tick(now=13.1)
                collector.tick(now=13.2)
                self.assertEqual(replace.call_count,2)  # Inventory and capture status, one retry each.
                self.assertEqual(collector.last_status,10)
                self.assertEqual(path.read_bytes(),previous)
            collector.captured=42
            collector.tick(now=16)
            self.assertEqual(json.loads(path.read_text())['packets'],42)
            self.assertEqual(collector.last_status,16)

    def test_native_diagnostics_write_failure_is_nonfatal(self):
        with tempfile.TemporaryDirectory() as folder:
            collector=Collector(folder)
            with patch.object(Path,'open',side_effect=PermissionError('busy')):
                self.assertFalse(collector.write_status(Path(folder)/'native_health.json',{}))

    def test_reordered_duplicate_and_wrap(self):
        stream=Stream(0xfffffffe)
        self.assertEqual(stream.feed(1,b'def',0),b'')
        self.assertEqual(stream.feed(0xfffffffe,b'abc',1),b'abcdef')
        self.assertEqual(stream.feed(0xfffffffe,b'abcdef',2),b'')
        self.assertEqual(stream.next,4)

    def test_overlap_and_bounds(self):
        stream=Stream(10);stream.feed(12,b'cd',0)
        with self.assertRaises(ValueError):stream.feed(13,b'X',1)
        with self.assertRaises(ValueError):stream.feed(2000000,b'X',1)

    def test_fragmented_greeting_and_frames(self):
        output=[];decoder=Decoder(output.append);iv=bytes([1,2,3,4])
        greeting=bytes.fromhex('1300010001000000010030')+b'abcd'+iv+b'zz'
        plains=[b'\x32\x00hello',b'\x01\x00world']
        wire=greeting
        for plain in plains:
            wire+=frame_header(len(plain),iv,False)+bytes((b+iv[0])&255 for b in plain);iv=advance(iv)
        for byte in wire:decoder.feed(bytes([byte]))
        self.assertEqual(output,plains)
        with self.assertRaises(ValueError):decoder.feed(b'\0\0\0\0')

    def test_owner_gate_gap_timeout_and_midstream(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector=Collector(Path(tmp),owner=lambda _:False)
            collector.receive(raw(200,b'private'),0);self.assertFalse(collector.flows)
            collector.receive(raw(100,flags=0x12),1)
            collector.receive(raw(101,b'not game'),2)
            collector.tick(5);self.assertFalse(collector.flows)
            self.assertFalse(list(Path(tmp).glob('raw_shop*')))
            collector=Collector(Path(tmp),owner=lambda _:True)
            collector.receive(raw(100,flags=0x12),1)
            collector.receive(raw(110,b'gap'),2);collector.tick(13)
            self.assertTrue(next(iter(collector.flows.values()))['failed'])

    def test_syn_retransmission_does_not_reset_and_new_syn_does(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector=Collector(Path(tmp),owner=lambda _:True)
            collector.receive(raw(100,flags=0x12),1);flow=next(iter(collector.flows.values()))
            collector.receive(raw(100,flags=0x12),2)
            self.assertIs(flow,next(iter(collector.flows.values())))
            collector.receive(raw(300,flags=0x12),3)
            self.assertIsNot(flow,next(iter(collector.flows.values())))

    def test_packet_validation_and_read_only_flags(self):
        self.assertEqual(SNIFF_RECV_ONLY,5)
        self.assertEqual(packet(raw(10,b'hi'))[3],b'hi')
        self.assertIsNone(packet(raw(10)[:25]))

    def test_expanded_game_ports_and_non_game_exclusion(self):
        for port in (8500,8599,8600,8913,8999):
            data=bytearray(raw(10,b'hi'));struct.pack_into('!H',data,20,port)
            self.assertEqual(packet(data)[0][1],port)
        for port in (443,8499,9000,58880):
            data=bytearray(raw(10,b'hi'));struct.pack_into('!H',data,20,port)
            self.assertIsNone(packet(data))

    def test_status_reports_protocol_activity_and_shop_freshness(self):
        import json
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            collector=Collector(Path(tmp));session=Mock()
            collector.observer(session)(b'\x77\x05payload')
            collector.event('shop_list',item_count=1)
            collector.tick(10)
            status=json.loads((Path(tmp)/'passive_status.json').read_text())
            self.assertEqual(status['capture_ports'],'8500-8999')
            self.assertEqual(status['message_counts']['0x577'],1)
            self.assertIsNotNone(status['last_shop_at'])

    def test_delayed_owner_lookup_decodes_buffer_without_more_packets(self):
        with tempfile.TemporaryDirectory() as tmp:
            ready=[False];collector=Collector(Path(tmp),owner=lambda _:ready[0])
            greeting=bytes.fromhex('1300010001000000010030')+b'abcd'+b'1234'+b'zz'
            collector.receive(raw(100,flags=0x12),1)
            collector.receive(raw(101,greeting),1.1)
            ready[0]=True;collector.tick(1.5)
            self.assertEqual(next(iter(collector.flows.values()))['decoder'].iv,b'1234')

    def test_unused_opcode_map_and_observer_error_do_not_break_transport(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            collector=Collector(Path(tmp));session=Mock()
            observe=collector.observer(session)
            observe(b'\x32\0invalid encrypted mapping')
            session.observe.assert_not_called()
            session.observe.side_effect=ValueError('Malformed single observation')
            observe(b'\x77\x05bad shop')
            self.assertIsNone(session.pending_open)
            session.observe.side_effect=None
            observe(b'\x3a\x02next sign')
            self.assertEqual(session.observe.call_count,2)


if __name__=='__main__':unittest.main()


class WindowsNativeTests(unittest.TestCase):
    def test_native_backend_can_receive_position_packets_without_broadening_default_capture(self):
        import market_passive
        from unittest.mock import Mock
        outgoing = bytearray(raw(1))
        struct.pack_into('!HH', outgoing, 20, 51000, 8501)
        outgoing = bytes(outgoing)
        self.assertIsNone(packet(outgoing), 'ordinary market capture remains inbound only')
        sniffer = object.__new__(market_passive.WindowsSniffer)
        stream = Mock()
        stream.recv.side_effect = [b'not an IP packet', outgoing]
        sniffer.sockets, sniffer.handle = [stream], True
        import queue
        sniffer.local_error, sniffer.local_packets = None, queue.Queue()
        sniffer.accept = lambda value: value == outgoing
        for key in ('received_datagrams', 'matched_datagrams', 'tcp_datagrams', 'game_outbound_datagrams'):
            setattr(sniffer, key, 0)
        with patch('select.select', return_value=([stream], [], [])):
            self.assertEqual(sniffer.recv(), outgoing)
        self.assertEqual(sniffer.matched_datagrams, 1)
        stream.send.assert_not_called()
        stream.sendto.assert_not_called()

    def test_native_backend_uses_only_receive_operations_and_closes_interfaces(self):
        import socket
        from types import SimpleNamespace
        from unittest.mock import Mock,patch
        import market_passive
        stream=Mock()
        addresses={'test':[SimpleNamespace(family=socket.AF_INET,address='192.0.2.10')]}
        with patch('native_firewall.ensure_capture_firewall',return_value={'state':'existing'}),patch('psutil.net_if_addrs',return_value=addresses),patch('psutil.net_if_stats',return_value={'test':SimpleNamespace(isup=True)}),patch('socket.socket',return_value=stream),patch.object(market_passive.ctypes.windll.shell32,'IsUserAnAdmin',return_value=True):
            with patch.object(market_passive, 'Sniffer') as local:
                local.return_value.recv.side_effect=OSError('test receiver closed')
                sniffer=market_passive.WindowsSniffer()
            stream.bind.assert_called_once_with(('192.0.2.10',0))
            stream.ioctl.assert_called_with(socket.SIO_RCVALL,getattr(socket,'RCVALL_IPLEVEL',3))
            stream.send.assert_not_called();stream.sendto.assert_not_called();stream.connect.assert_not_called()
            sniffer.close();stream.close.assert_called_once();self.assertIsNone(sniffer.handle)
