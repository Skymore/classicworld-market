import struct
import tempfile
import unittest
from pathlib import Path
from market_passive import Stream,Decoder,Collector,packet,SNIFF_RECV_ONLY
from classicworld_codec import frame_header,advance


def raw(seq,data=b'',flags=0x18):
    ip=bytearray(20);ip[0]=0x45;ip[2:4]=struct.pack('!H',40+len(data));ip[9]=6
    ip[12:16]=bytes([44,230,128,74]);ip[16:20]=bytes([192,168,1,5])
    tcp=bytearray(20);struct.pack_into('!HHI',tcp,0,8501,51000,seq);tcp[12]=0x50;tcp[13]=flags
    return bytes(ip+tcp)+data


class PassiveTests(unittest.TestCase):
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
