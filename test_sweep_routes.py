import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from collector_sweep import configuration
from sweep_routes import targets, run_recent


class RecentRouteTests(unittest.TestCase):
    def setUp(self):
        self.plan = configuration({'watches':[dict(item_id=2000001,limit=0,
            groups=[dict(id='g',buy=True,cap=130,reminder={'minStock':50})])]})
        self.row = dict(item_id=2000001,price=130,bundle=1,stock=40,slot=1,
            source='packet',owner_name='Seller',observed=10000,location=dict(room=1,channel=3))

    def test_time_cap_location_source_and_aggregate_stock(self):
        rows = [self.row, dict(self.row,slot=2,stock=20),
                dict(self.row,owner_name='Old',observed=6399,stock=100),
                dict(self.row,owner_name='Dear',price=131,stock=100),
                dict(self.row,owner_name='Future',observed=10001,stock=100),
                dict(self.row,owner_name='External',source='external',stock=100),
                dict(self.row,owner_name='Unknown',location={},stock=100)]
        result=targets(rows,self.plan,60,10000)
        self.assertEqual([(s['room'],s['channel'],s['owner']) for s in result],[(1,3,'Seller')])
        self.assertEqual(len(result[0]['offers']),2)
        self.assertEqual(targets([self.row],self.plan,60,10000),[])

    def test_scan_stops_at_completed_target_and_deduplicates_channel(self):
        stop=threading.Event()
        engine=Mock()
        engine.buying.return_value=True
        shops=[dict(room=1,channel=3,owner=n,observed=10000,offers=[[2000001,1,130,1,60,None]]) for n in ('A','B')]
        engine.recent_targets.side_effect=[shops,[]]
        calls=[]
        def status(event):
            if isinstance(event,tuple) and event[0]=='confirmed':stop.set()
        def scan(folder,hwnd,ready,cancel,observed,progress,**hooks):
            calls.append((progress.state['room'],progress.state['channel']))
            self.assertIs(hooks['shop_callback'],engine.on_shop_open)
            progress.begin(1,3,1)
            observed(('progress',dict(room=1,channel=3,visited=7)))
            progress.save(1,4,1,phase='pending')
            self.fail('Must stop before scanning another channel')
        with tempfile.TemporaryDirectory() as folder:
            result=run_recent(Path(folder),12,threading.Event(),stop,status,engine,scan)
        self.assertEqual(calls,[(1,3)])
        self.assertEqual(result['visited'],7)

    def test_incomplete_target_is_never_marked_done(self):
        engine=Mock()
        engine.buying.return_value=True
        engine.recent_targets.return_value=[dict(room=1,channel=3,owner='A',offers=[])]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError,'incomplete'):
                run_recent(Path(folder),12,threading.Event(),threading.Event(),Mock(),engine,
                           lambda *args,**kwargs: {'reason':'room_scan_incomplete'})


if __name__=='__main__':unittest.main()
