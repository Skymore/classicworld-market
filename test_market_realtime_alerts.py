import json,os,tempfile,threading,time,unittest
from pathlib import Path
from market_dashboard import Repository
from market_views import opportunities
from market_realtime_alerts import visit_opportunities,start_alert_watcher

class FastAlertTests(unittest.TestCase):
 def fixture(self,root):
  repo=Repository(root/'db',root/'missing');now=time.time()
  for i in range(8):
   v=self.visit(now-20,i,100);p=root/f'base{i}.json';p.write_text(json.dumps(v));repo.ingest(p)
  return repo,repo.report(),self.visit(now,99,50)
 def visit(self,t,shop,price):
  return dict(session='test',time=t,title=str(shop),shop_id=shop,market_location=dict(channel=7,room=7),
   items=[dict(item_id=4000000,slot=1,price_mesos_candidate=price,bundle_quantity_candidate=1,available_quantity_candidate=10)])
 def test_fast_result_matches_full_report_without_mutating_reference(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);repo,base,visit=self.fixture(root);before=json.dumps(base)
   fast=visit_opportunities(base,visit);p=root/'visit.json';p.write_text(json.dumps(visit));repo.ingest(p)
   full=opportunities(repo.report())
   self.assertEqual(len(fast),1)
   self.assertEqual({k:v for k,v in fast[0].items() if k!='reference_generated_at'},full[0])
   self.assertEqual(before,json.dumps(base))
   visit['triggered_by_python']=True;self.assertEqual(visit_opportunities(base,visit),[])
 def test_file_write_triggers_push_without_waiting_for_report(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);_,base,visit=self.fixture(root);ready=threading.Event();received=[];health={}
   observer=start_alert_watcher([root],lambda:{72:base,None:dict(base,hours=None)},lambda d:(received.append(d),ready.set()),health)
   try:
    start=time.perf_counter();(root/'shop_live.json').write_text(json.dumps(visit))
    self.assertTrue(ready.wait(3));self.assertEqual(len(received[0]['windows']['72']),1)
    print('File event -> alert callback: %.1f ms'%((time.perf_counter()-start)*1000))
   finally:observer.stop();observer.join(2)
 def test_timestamp_only_change_does_not_repeat_but_new_quote_does(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);_,base,visit=self.fixture(root);ready=threading.Event();received=[]
   observer=start_alert_watcher([root],lambda:{72:base},lambda d:(received.append(d),ready.set()),{})
   try:
    path=root/'shop_live.json';path.write_text(json.dumps(visit))
    self.assertTrue(ready.wait(3));ready.clear()
    stat=path.stat();os.utime(path,ns=(stat.st_atime_ns,stat.st_mtime_ns+1000000000))
    self.assertFalse(ready.wait(.2));self.assertEqual(len(received),1)
    visit['items'][0]['price_mesos_candidate']=40
    path.write_text(json.dumps(visit))
    self.assertTrue(ready.wait(3));self.assertEqual(received[-1]['windows']['72'][0]['buy'],40)
   finally:observer.stop();observer.join(2)
 def test_watch_alerts_work_with_selling_metadata_and_during_warmup(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);_,base,visit=self.fixture(root);ready=threading.Event();received=[]
   references={72:base,'selling':{'items':[]}}
   observer=start_alert_watcher([root],lambda:references,lambda d:(received.append(d),ready.set()),{})
   try:
    visit['items'][0]['item_id']=1452003
    (root/'shop_equipment.json').write_text(json.dumps(visit))
    self.assertTrue(ready.wait(3));self.assertEqual(received[-1]['watch_listings'][0]['item_id'],1452003)
    self.assertEqual(received[-1]['windows']['72'],[])
    references.clear();ready.clear();visit['shop_id']=101
    (root/'shop_warmup.json').write_text(json.dumps(visit))
    self.assertTrue(ready.wait(3));self.assertEqual(received[-1]['windows'],{})
    self.assertEqual(len(received[-1]['watch_listings']),1)
   finally:observer.stop();observer.join(2)

if __name__=='__main__':unittest.main()
