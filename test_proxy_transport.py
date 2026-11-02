import socket
import struct
import unittest
from types import SimpleNamespace as NS
from unittest.mock import patch
import psutil
import game_transport as transport
import market_passive
import channel_state_collector
import position_state_collector


def wire(src, sport, dst, dport, flags=0x12):
    tcp=struct.pack('!HHIIBBHHH',sport,dport,100,0,0x50,flags,4096,0,0)
    return struct.pack('!BBHHHBBH4s4s',0x45,0,40,0,0,64,6,0,
                       socket.inet_aton(src),socket.inet_aton(dst))+tcp


def connection(port=61995, pid=42, state='ESTABLISHED'):
    return NS(pid=pid,status=state,laddr=NS(ip='127.0.0.1',port=51031),
              raddr=NS(ip='127.0.0.1',port=port))


class ProxyTransportTests(unittest.TestCase):
    def setUp(self):
        self.process=patch.object(psutil,'process_iter',return_value=[NS(info={'pid':42,'name':'MapleStory.exe'})])
        self.process.start();self.addCleanup(self.process.stop)
        self.rows=[connection()]
        self.net=patch.object(psutil,'net_connections',side_effect=lambda **kw:self.rows)
        self.net_mock=self.net.start();self.addCleanup(self.net.stop)
        transport._at=0
        transport._syn.clear()
        transport._ownership_checks.clear()

    def test_dynamic_ports_and_all_decoders(self):
        for port in (61995,58003):
            self.rows=[connection(port)]
            self.assertTrue(transport.connected())
            server=wire('127.0.0.1',port,'127.0.0.1',51031)
            client=wire('127.0.0.1',51031,'127.0.0.1',port)
            for module in (market_passive,channel_state_collector):
                self.assertEqual(module.packet(server)[0],('127.0.0.1',port,'127.0.0.1',51031))
                self.assertIsNone(module.packet(client))
            self.assertEqual(position_state_collector.packet(server)[1],'server')
            self.assertEqual(position_state_collector.packet(client)[1],'client')

    def test_other_process_and_closed_connection_rejected(self):
        packet=wire('127.0.0.1',61995,'127.0.0.1',51031)
        for rows in ([connection(pid=99)],[],[connection(state='CLOSE_WAIT')]):
            self.rows=rows
            self.assertFalse(transport.connected())
            self.assertIsNone(market_passive.packet(packet))

    def test_syn_ack_before_established(self):
        self.rows=[connection(state='SYN_SENT')]
        self.assertFalse(transport.connected())
        self.assertIsNotNone(market_passive.packet(wire('127.0.0.1',61995,'127.0.0.1',51031)))

    def test_direct_arbitrary_ports_require_game_ownership(self):
        for port in (443,8541,61995,32000):
            self.rows=[NS(pid=42,status='ESTABLISHED',raddr=NS(ip='1.2.3.4',port=port),laddr=NS(ip='192.168.1.2',port=51031))]
            transport.connections(force=True)
            for module in (market_passive,channel_state_collector,position_state_collector):
                self.assertIsNotNone(module.packet(wire('1.2.3.4',port,'192.168.1.2',51031)))
                self.assertIsNone(module.packet(wire('5.6.7.8',port,'192.168.1.2',51031)))

    def test_ipv6_tcp_and_extension_header(self):
        src,dst='2001:db8::10','2001:db8::20'
        self.rows=[NS(pid=42,status='ESTABLISHED',raddr=NS(ip=src,port=45000),laddr=NS(ip=dst,port=51031))]
        transport.connections(force=True)
        tcp=struct.pack('!HHIIBBHHH',45000,51031,100,0,0x50,0x12,4096,0,0)
        def ipv6(extension=False):
            extra=bytes([6,0])+bytes(6) if extension else b''
            return struct.pack('!IHBB16s16s',6<<28,len(tcp)+len(extra),60 if extension else 6,64,socket.inet_pton(socket.AF_INET6,src),socket.inet_pton(socket.AF_INET6,dst))+extra+tcp
        for extension in (False,True):
            for module in (market_passive,channel_state_collector,position_state_collector):
                self.assertEqual(module.packet(ipv6(extension))[0],(src,45000,dst,51031))
        fragment=bytearray(ipv6());fragment[6]=44
        self.assertIsNone(transport.tcp_packet(fragment))

    def test_new_syn_replaces_position_state_not_retransmit(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            collector=position_state_collector.Collector(Path(folder)/'position.json')
            client=wire('127.0.0.1',51031,'127.0.0.1',61995,2)
            server=wire('127.0.0.1',61995,'127.0.0.1',51031)
            collector.receive(client);collector.receive(server)
            old=next(iter(collector.flows.values()))
            self.assertEqual(set(old['streams']),{'server','client'})
            collector.receive(server)
            self.assertIs(next(iter(collector.flows.values())),old)
            new=bytearray(client);struct.pack_into('!I',new,24,300)
            collector.receive(new)
            replacement=next(iter(collector.flows.values()))
            self.assertIsNot(replacement,old)
            self.assertEqual(replacement['streams']['client'].next,301)
            self.assertNotIn('server',replacement['streams'])

    def test_syn_metadata_survives_delayed_process_table(self):
        import tempfile
        from pathlib import Path
        self.rows=[];transport.connections(force=True)
        server=wire('127.0.0.1',61995,'127.0.0.1',51031)
        self.assertIsNone(market_passive.packet(server))
        self.rows=[connection()]
        greeting=bytes.fromhex('1300010001000000010030')+b'0000'+b'1234'+b'00'
        payload=bytearray(wire('127.0.0.1',61995,'127.0.0.1',51031,0x18))
        struct.pack_into('!H',payload,2,40+len(greeting));struct.pack_into('!I',payload,24,101)
        with tempfile.TemporaryDirectory() as folder:
            collector=market_passive.Collector(folder)
            collector.receive(bytes(payload)+greeting)
            self.assertEqual(next(iter(collector.flows.values()))['decoder'].iv,b'1234')

    def test_fast_connection_does_not_wait_for_polling_cache(self):
        self.rows=[];transport.connections(force=True)
        self.rows=[connection()]
        self.assertIsNotNone(market_passive.packet(wire('127.0.0.1',61995,'127.0.0.1',51031)))

    def test_unknown_syn_lookup_is_shared_and_bounded(self):
        self.rows=[];transport.connections(force=True)
        packet=wire('127.0.0.1',61995,'127.0.0.1',51031)
        with patch.object(transport.time,'monotonic',return_value=transport._at):
            self.net_mock.reset_mock()
            for _ in range(10):
                self.assertIsNone(transport.tcp_packet(packet))
            self.assertEqual(self.net_mock.call_count,1)

    def test_old_positions_are_not_reused_after_reconnect(self):
        from full_market_scan import _wait_for_supported_map
        from free_market_route import PositionSyncError
        from unittest.mock import Mock
        feed=Mock();feed.read.return_value=dict(map_id=80002006,session='old',observed_at=100)
        with self.assertRaises(PositionSyncError):
            _wait_for_supported_map(feed,lambda _:None,lambda:None,timeout=.005,previous_session='old')
        feed.read.return_value.update(session='new',observed_at=200)
        self.assertEqual(_wait_for_supported_map(feed,lambda _:None,lambda:None,previous_session='old',started_at=150)['session'],'new')

    def test_lookup_errors_fail_closed(self):
        with patch.object(psutil,'net_connections',side_effect=psutil.AccessDenied()):
            self.assertFalse(transport.connected())

    def test_proxy_handshake_reaches_market_decoder(self):
        import tempfile
        from pathlib import Path
        from test_market_passive import raw
        def local(seq, data=b'', flags=0x18):
            packet=bytearray(raw(seq,data,flags))
            packet[12:16]=packet[16:20]=socket.inet_aton('127.0.0.1')
            struct.pack_into('!HH',packet,20,61995,51031)
            return bytes(packet)
        with tempfile.TemporaryDirectory() as directory:
            collector=market_passive.Collector(Path(directory),owner=lambda key:key in transport.connections())
            collector.receive(local(100,flags=0x12))
            greeting=bytes.fromhex('1300010001000000010030')+b'0000'+b'1234'+b'00'
            collector.receive(local(101,greeting))
            flow=next(iter(collector.flows.values()))
            self.assertEqual(flow['decoder'].iv,b'1234')
            self.assertFalse(flow['failed'])


if __name__=='__main__':unittest.main()
