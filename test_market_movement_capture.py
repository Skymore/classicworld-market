import json
import unittest
from pathlib import Path
from market_movement_capture import Session
from classicworld_codec import frame_header, advance

class MovementDecoderTest(unittest.TestCase):
 def test_bad_mapping_does_not_discard_following_frames(self):
  events=[]; session=Session(lambda event,**fields:events.append(dict(event=event,**fields)))
  iv=b'1234'
  session.feed('server',bytes.fromhex('1300010001000000010030')+b'abcd'+iv+b'\0\0')
  bad=b'\x32\0'+(8).to_bytes(4,'little')+bytes(8)
  later=b'\x99\0hello'
  for plain in (bad,later):
   session.feed('server',frame_header(len(plain),iv,False)+bytes((v+iv[0])&255 for v in plain))
   iv=advance(iv)
  self.assertEqual(session.counts['server'],2)
  self.assertEqual(events[-1]['event'],'opcode_map_unparsed')
 def test_recorded_bidirectional_session(self):
  path=Path('network_captures/shop_session_20261010_170336/session_streams.json')
  if not path.exists(): self.skipTest('Private local capture unavailable')
  streams=json.loads(path.read_text()); checked=0
  for server in streams:
   if not server['greeting_hex']: continue
   flow=server['flow']; client=next(s for s in streams if s['flow']==[flow[2],flow[3],flow[0],flow[1]])
   events=[]; session=Session(lambda event,**fields:events.append(dict(event=event,**fields)))
   for b in bytes.fromhex(server['greeting_hex']): session.feed('server',bytes([b]))
   ordered=sorted([(m['time'],'server',m) for m in server['messages']]+[(m['time'],'client',m) for m in client['messages']],key=lambda row:row[0])
   for _,side,m in ordered:
    wire=bytes.fromhex(m['header']+m['body'])
    session.feed(side,wire[:3]);session.feed(side,wire[3:])
   self.assertEqual(session.counts,{'client':len(client['messages']),'server':len(server['messages'])})
   self.assertTrue(session.table)
   self.assertTrue(any(e['event']=='location' and e['location'] for e in events))
   checked+=1
   print('Verified frame counts:',session.counts)
  self.assertGreater(checked,0)
 def test_reject_invalid_greeting(self):
  with self.assertRaises(ValueError): Session(lambda *a,**k:None).feed('server',bytes(21))
 def test_client_waits_for_greeting(self):
  session=Session(lambda *a,**k:None)
  session.feed('client',b'abc')
  self.assertIsNone(session.ivs)
  self.assertEqual(session.buffers['client'],b'abc')

if __name__=='__main__': unittest.main()
