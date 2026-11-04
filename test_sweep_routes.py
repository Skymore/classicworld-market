import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from collector_sweep import configuration
from sweep_routes import targets, run_recent, LiveTargets, with_live_priority


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

    def test_priority_scans_each_location_once_then_returns_to_market(self):
        engine=Mock()
        engine.buying.return_value=True
        engine.recent_targets.return_value=[dict(room=1,channel=3,owner=n,offers=[]) for n in ('A','B')]
        visits=[]
        def scan(folder, hwnd, ready, stop, status, progress, **hooks):
            visits.append((progress.state['room'], progress.state['channel']))
            progress.begin(1,3,1)
            progress.save(1,4,1,phase='pending')
        with tempfile.TemporaryDirectory() as folder:
            run_recent(folder,12,threading.Event(),threading.Event(),Mock(),engine,scan,once=True)
        self.assertEqual(visits,[(1,3)])
        engine.recent_targets.assert_called_once()
        engine.recent_targets.return_value=[]
        with tempfile.TemporaryDirectory() as folder:
            result=run_recent(folder,12,threading.Event(),threading.Event(),Mock(),engine,scan,once=True)
        self.assertEqual(result['visited'],0)

    def test_incomplete_target_is_never_marked_done(self):
        engine=Mock()
        engine.buying.return_value=True
        engine.recent_targets.return_value=[dict(room=1,channel=3,owner='A',offers=[])]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError,'incomplete'):
                run_recent(Path(folder),12,threading.Event(),threading.Event(),Mock(),engine,
                           lambda *args,**kwargs: {'reason':'room_scan_incomplete'})

    def test_live_targets_merge_places_deduplicate_and_expire(self):
        queue = LiveTargets()
        a = dict(room=2, channel=40, owner='A', observed=1000, offers=[[1,1,10,1,2,None]])
        b = dict(a, owner='B')
        queue.update([a,b,dict(a,room=3)])
        self.assertEqual(queue.next(1001), [a,b])
        queue.complete([a,b],1001)
        self.assertEqual(queue.next(1002)[0]['room'],3)
        queue.update([dict(a,observed=1010),b])
        self.assertEqual(queue.next(1010), [], 'new observation alone is not a new offer')
        changed = dict(a,offers=[[1,1,9,1,2,None]])
        queue.update([changed])
        self.assertEqual(queue.next(1010), [changed])
        self.assertEqual(queue.next(1601), [])
        queue.update([])
        self.assertEqual(queue.next(1001), [])

    def test_live_hit_preempts_regular_route_then_resumes_after_one_channel(self):
        shop = dict(room=7,channel=40,owner='A',observed=1,offers=[])
        engine = Mock()
        engine.buying.return_value = True
        pending, events = [], []
        engine.next_live_target.side_effect = lambda:list(pending)
        engine.complete_live_target.side_effect = lambda shops: (events.append('completed'),pending.clear())
        def regular(checkpoint):
            events.append('regular')
            if events.count('regular') == 1:
                pending.append(shop)
                try:
                    checkpoint()
                finally:
                    events.append('lease_released')
            return {'reason':'cancelled'}
        def scan(folder,hwnd,ready,stop,status,progress,**hooks):
            events.append('target')
            self.assertEqual((progress.state['room'],progress.state['channel']),(7,40))
            self.assertNotIn('safe_checkpoint',hooks)
            progress.begin(7,40,1)
            progress.complete(7,40,1)
        with tempfile.TemporaryDirectory() as folder:
            with_live_priority(folder,12,threading.Event(),threading.Event(),Mock(),engine,scan,regular)
        self.assertEqual(events,['regular','lease_released','target','completed','regular'])

    def test_live_failed_route_does_not_consume_target(self):
        engine = Mock()
        engine.buying.return_value = True
        engine.next_live_target.return_value = [dict(room=1,channel=2,owner='A',offers=[])]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError,'incomplete'):
                with_live_priority(folder,12,threading.Event(),threading.Event(),Mock(),engine,
                                   lambda *a,**kw: {'reason':'room_scan_incomplete'},Mock())
        engine.complete_live_target.assert_not_called()


if __name__=='__main__':unittest.main()
