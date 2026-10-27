import copy
import json
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import patch
from collector_sweep import SweepSimulator, configuration

def config(item=1002000):
    return dict(action='start',mode='simulate',source_key='a'*64,
        limits=dict(budget=1000,maxOrder=500,wallet=1300,reserve=300,slots=10,reserveSlots=2),
        watches=[dict(item_id=item,name='Test item',limit=10,groups=[dict(id='rule',name='Rule',buy=True,cap=100,reminder={})])])

def packet(item=1002000, **row):
    return dict(observation_id='new',observed_at=time.time(),location=dict(room=3,channel=8),owner=dict(character_id=123,name='Tester'),shop_id=5,
        items=[dict(item_id=item,category=item//1000000,slot=1,price=100,bundle=1,stock=3,**row)])

class SweepTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.engine=SweepSimulator(self.temp.name)
    def process(self,p):
        with patch('collector_sweep.from_snapshot',return_value=p):self.engine.process({})
    def test_union_deduplicates_groups_captures_and_changed_stock(self):
        c=config();c['watches'][0]['groups'].append(dict(id='two',name='Rule 2',buy=True,cap=200,reminder={}))
        self.engine.command(c);p=packet();self.process(p)
        self.assertEqual(self.engine.units,3);self.assertEqual(self.engine.spent,300)
        self.assertEqual(len(self.engine.recent[0]['groups']),2)
        self.process(p);p['observation_id']='again';p['items'][0]['stock']=2;self.process(p)
        self.assertEqual(self.engine.units,3)
        p['observation_id']='other-shop';p['owner']['character_id']=456;self.process(p)
        self.assertEqual(self.engine.units,5)
    def test_zero_slots_is_not_unknown_and_stats_use_and(self):
        c=config();c['watches'][0]['groups'][0]['reminder']={'minUpgrades':0,'maxUpgrades':0,'stats':[{'stat':'weapon_attack','min':6}]}
        self.engine.command(c)
        for i,eq in enumerate([None,{'status':'unsupported','remaining_upgrades':0}, {'status':'candidate','stats':[{'key':'weapon_attack','value':5}],'remaining_upgrades':0}, {'status':'candidate','stats':[{'key':'weapon_attack','value':6}],'remaining_upgrades':0}]):
            p=packet(equipment=eq);p['observation_id']=str(i);self.process(p)
        self.assertEqual(self.engine.units,3)
    def test_bundle_quantity_budget_and_transaction_cap(self):
        c=config(4000000);c['watches'][0]['limit']=5
        self.engine.command(c);p=packet(4000000);p['items'][0].update(bundle=2,price=180,stock=10);self.process(p)
        self.assertEqual(self.engine.units,4);self.assertEqual(self.engine.spent,360)
        self.assertEqual(self.engine.recent[0]['purchases'],2)
    def test_wallet_reserve_and_inventory_reserve_bound_purchases(self):
        c=config();c['limits'].update(wallet=450,reserve=300,slots=3,reserveSlots=2)
        self.engine.command(c);self.process(packet());self.assertEqual(self.engine.units,1)
        p=packet();p['observation_id']='second';p['items'][0]['slot']=2;self.process(p)
        self.assertEqual(self.engine.units,1);self.assertEqual(self.engine.recent[0]['reason'],'模拟空格不足')
    def test_stop_restart_and_old_capture_never_autostart(self):
        self.engine.command(config());p=packet();p['observed_at']=self.engine.started-1;self.process(p)
        self.assertEqual(self.engine.units,0)
        self.process(packet());self.engine.command({'action':'stop'});self.process(packet())
        other=SweepSimulator(self.temp.name);self.assertFalse(other.enabled);self.assertEqual(other.units,3)
        self.engine.command(config());self.assertEqual(self.engine.units,0)
    def test_reject_real_mode_bad_limits_and_empty_groups(self):
        for change in [dict(mode='real'),dict(watches=[]),dict(limits={'budget':-1})]:
            with self.assertRaises(ValueError):self.engine.command({**config(),**change})
        c=config();c['watches'][0]['groups'][0]['cap']=None
        with self.assertRaises(ValueError):configuration(c)
    def test_real_snapshot_observer_reaches_simulator(self):
        self.engine.start_observer();self.addCleanup(self.engine.close);self.engine.command(config(4000000))
        raw=dict(session='synthetic',time=time.time(),shop_id=1,title='Test',market_location={'room':1,'channel':2},items=[dict(item_id=4000000,slot=1,price_mesos_candidate=50,bundle_quantity_candidate=1,available_quantity_candidate=2)])
        (Path(self.temp.name)/'shop_test.json').write_text(json.dumps(raw))
        end=time.monotonic()+3
        while self.engine.units!=2 and time.monotonic()<end:time.sleep(.05)
        self.assertEqual(self.engine.units,2)
        self.assertTrue((self.engine.home/'simulations.jsonl').is_file())
    def test_bridge_requires_official_origin_and_nonce_and_cannot_purchase(self):
        from collector_dashboard import create_server
        server=create_server({'endpoint':'http://127.0.0.1:1234','token':'synthetic'},Path(self.temp.name),0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            url=f'http://127.0.0.1:{server.server_port}/api/v1/collector/sweep'
            headers={'Origin':'https://mxd.ruit.me','Content-Type':'application/json'}
            with urllib.request.urlopen(urllib.request.Request(url,headers={'Origin':headers['Origin']})) as response:
                state=json.load(response)
            for bad in [{}, {'X-CSRF-Token':state['csrf'],'Origin':'https://evil.example'}]:
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(config()).encode(),headers={**headers,**bad}))
                self.assertEqual(error.exception.code,403)
            headers['X-CSRF-Token']=state['csrf']
            with patch('collector_dashboard.Gateway.fetch',return_value={'revision':'test'}):
                with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(config()).encode(),headers=headers)) as response:self.assertTrue(json.load(response)['enabled'])
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(url,data=json.dumps({**config(),'mode':'real'}).encode(),headers=headers))
            self.assertEqual(error.exception.code,400)
        finally:server.shutdown();server.server_close();thread.join(2)

if __name__=='__main__':unittest.main()
