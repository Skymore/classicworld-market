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
        self.net.start();self.addCleanup(self.net.stop)
        transport._at=0

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

    def test_direct_and_unrelated_ports(self):
        for module in (market_passive,channel_state_collector,position_state_collector):
            self.assertIsNotNone(module.packet(wire('1.2.3.4',8541,'192.168.1.2',51031)))
            self.assertIsNone(module.packet(wire('1.2.3.4',61995,'192.168.1.2',51031)))

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
