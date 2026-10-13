import json,unittest,tempfile,time
from pathlib import Path
from market_position_feed import PositionTracker,read_position,publish_position
from market_movement import parse_movement
from classicworld_codec import opcode_table
from unittest.mock import patch

class MovementPositionTests(unittest.TestCase):
 def test_windows_position_read_retries(self):
  s=dict(valid=True,feed_time=100,traffic_time=100,map_id=80002007)
  with patch.object(Path,'read_text',side_effect=[PermissionError(),json.dumps(s)]),patch('market_position_feed.time.sleep'):
   self.assertEqual(read_position('unused',80002007,now=101),s)
 def test_windows_atomic_replace_retries(self):
  with patch.object(Path,'write_text'),patch('market_position_feed.time.sleep'),patch('market_position_feed.os.replace',side_effect=[PermissionError(),None]) as replace:
   publish_position(Path('unused-position.json'),dict(valid=False))
   self.assertEqual(replace.call_count,2)
 def rows(self):
  p=Path('network_captures/movement_20261011_114748/movement.jsonl')
  if not p.exists():self.skipTest('Private live capture unavailable')
  return [json.loads(s) for s in p.read_text().splitlines()]
 def test_live_trace_coordinates_and_continuity(self):
  tracker=PositionTracker();last=None;count=0;points=[]
  for row in self.rows():
   tracker.consume(row)
   if row.get('direction')=='client' and row.get('opcode')==58889:
    parsed=parse_movement(bytes.fromhex(row['body']))
    if last:self.assertEqual((parsed['start']['x'],parsed['start']['y']),last)
    last=(parsed['end']['x'],parsed['end']['y']);points.append(last);count+=1
    self.assertTrue(tracker.state['valid'],tracker.state)
  self.assertGreaterEqual(count,20)
  self.assertIn((259,1185),points)
  self.assertIn((259,1261),points)
 def test_mapping_terminator(self):
  row=next(r for r in self.rows() if r['event']=='opcode_map_unparsed')
  table=opcode_table(bytes.fromhex(row['body']))
  self.assertEqual(len(table),875);self.assertEqual(table[20],58889)
 def test_unknown_and_truncated_fragments_rejected(self):
  row=next(r for r in self.rows() if r.get('opcode')==58889 and r['length']==57)
  body=bytearray.fromhex(row['body']);body[26]=255
  with self.assertRaises(ValueError):parse_movement(body)
  with self.assertRaises(ValueError):parse_movement(bytes.fromhex(row['body'])[:-1])
 def test_wrong_map_and_expired_feed_rejected(self):
  s=dict(valid=True,feed_time=100,traffic_time=100,map_id=80002007);p=Path('unused-position.json')
  with patch.object(Path,'read_text',return_value=json.dumps(s)):
   self.assertEqual(read_position(p,80002007,now=101),s)
   with self.assertRaises(ValueError):read_position(p,80002008,now=101)
   with self.assertRaises(ValueError):read_position(p,80002007,now=104)
 def test_new_connection_map_and_disconnect_invalidate(self):
  tracker=PositionTracker()
  for row in self.rows():
   tracker.consume(row)
   if tracker.state['valid']:break
  self.assertTrue(tracker.state['valid']);sid=tracker.active
  tracker.consume(dict(event='location',session=sid,location=None));self.assertFalse(tracker.state['valid'])
  tracker.state['valid']=True
  tracker.consume(dict(event='disconnected',session=sid));self.assertFalse(tracker.state['valid'])
  tracker.state['valid']=True
  tracker.consume(dict(event='handshake',session=999));self.assertFalse(tracker.state['valid'])

if __name__=='__main__':unittest.main()
