import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from shared_store import SharedStore, Conflict
from shared_server import create_app
from shared_protocol import validate


class SharedTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=SharedStore(Path(self.tmp.name),Path(self.tmp.name)/'absent')
        self.a,self.token=self.store.invite('a');self.b,self.other=self.store.invite('b')
        self.data=dict(version=1,world='ClassicWorld',observation_id='first',complete=True,
            observed_at=time.time()-60,title='Shop',shop_id=77,location=dict(channel=9,room=8),
            items=[dict(item_id=4010001,slot=1,price=500,bundle=1,stock=8)])
        self.client=create_app(self.store).test_client()

    def tearDown(self):self.tmp.cleanup()

    def test_public_read_and_automatic_identity(self):
        public=create_app(self.store,public_read=True).test_client()
        response=public.get('/');self.assertEqual(response.status_code,200);response.close()
        self.assertTrue(public.get('/api/v1/market').get_json()['public_read'])
        self.assertEqual(self.client.post('/api/v1/register').status_code,403)
        first=public.post('/api/v1/register').get_json()
        second=public.post('/api/v1/register').get_json()
        self.assertNotEqual(first['member_id'],second['member_id'])
        self.assertEqual(self.store.authenticate(first['token']),first['member_id'])
        self.assertEqual(public.post('/api/v1/observations',json=self.data).status_code,401)
        headers={'Authorization':'Bearer '+first['token']}
        self.assertEqual(public.post('/api/v1/observations',json=self.data,headers=headers).status_code,201)
        self.assertEqual(public.post('/api/v1/observations',json=self.data,headers=headers).status_code,200)
        self.store.revoke(first['member_id'])
        self.assertEqual(public.post('/api/v1/observations',json=self.data,headers=headers).status_code,401)

    def test_public_limits_are_per_client_address(self):
        public=create_app(self.store,public_read=True).test_client()
        for _ in range(5):self.assertEqual(public.post('/api/v1/register').status_code,201)
        self.assertEqual(public.post('/api/v1/register').status_code,429)
        self.assertEqual(public.post('/api/v1/register',headers={'CF-Connecting-IP':'192.0.2.10'}).status_code,201)

    def test_retry_and_conflict(self):
        self.assertTrue(self.store.upload(self.a,self.data));self.assertFalse(self.store.upload(self.a,self.data))
        changed=copy.deepcopy(self.data);changed['items'][0]['price']=700
        with self.assertRaises(Conflict):self.store.upload(self.a,changed)

    def test_two_collectors_one_quote_not_double_stock(self):
        self.store.upload(self.a,self.data);self.store.upload(self.b,self.data)
        report=self.store.report()
        self.assertEqual(report['manual_visits'],2)
        self.assertEqual(report['products'][0]['listings'],1)
        self.assertEqual(report['products'][0]['quotes'][0]['stock'],8)

    def test_location_is_part_of_identity(self):
        self.store.upload(self.a,self.data)
        changed=copy.deepcopy(self.data);changed['location']['channel']=10
        self.store.upload(self.b,changed)
        self.assertEqual(self.store.report()['products'][0]['shops'],2)

    def test_unknown_position_not_merged_across_collectors(self):
        self.data['location']=None
        self.store.upload(self.a,self.data);self.store.upload(self.b,self.data)
        self.assertEqual(self.store.report()['products'][0]['shops'],2)

    def test_older_upload_cannot_replace_new_price(self):
        self.store.upload(self.a,self.data)
        old=copy.deepcopy(self.data);old['observed_at']-=30;old['items'][0]['price']=1
        self.store.upload(self.b,old)
        self.assertEqual(self.store.report()['products'][0]['low'],500)

    def test_sold_out_not_counted_twice(self):
        self.store.upload(self.a,self.data)
        sold=copy.deepcopy(self.data);sold['observation_id']='sold';sold['observed_at']+=10;sold['items'][0]['stock']=0
        self.store.upload(self.a,sold);self.store.upload(self.b,sold)
        self.assertEqual(len(self.store.report()['sales']),1)

    def test_slot_multiplicity_preserved(self):
        self.data['items'].append(dict(self.data['items'][0],slot=2))
        self.store.upload(self.a,self.data)
        self.assertEqual(self.store.report()['products'][0]['listings'],2)

    def test_same_slot_in_different_inventory_categories(self):
        self.data['items'].append(dict(item_id=2040000,slot=1,price=100,bundle=1,stock=1))
        self.assertTrue(self.store.upload(self.a,self.data))
        self.assertEqual(len(self.store.report()['products']),2)

    def test_repeated_source_slots_preserve_two_real_rows(self):
        self.data['items'].append(dict(self.data['items'][0]))
        self.store.upload(self.a,self.data);self.store.upload(self.b,self.data)
        report=self.store.report()
        self.assertEqual(report['products'][0]['listings'],2)

    def test_empty_snapshot_removes_quotes_not_sale(self):
        self.store.upload(self.a,self.data)
        empty=dict(self.data,observation_id='empty',observed_at=self.data['observed_at']+1,items=[])
        self.store.upload(self.b,empty)
        self.assertEqual(self.store.report()['products'][0]['listings'],0)
        self.assertEqual(self.store.report()['sales'],[])

    def test_privacy_and_input_limits(self):
        self.data.update(raw_source='secret',host='private',body_hex='deadbeef')
        self.store.upload(self.a,self.data)
        report=json.dumps(self.store.report())
        self.assertNotIn('raw_source',report);self.assertNotIn('server_endpoint',report)
        self.assertNotIn('body_hex',json.dumps(validate(self.data)))
        self.data['items'][0]['price']=-1
        with self.assertRaises(ValueError):validate(self.data)

    def test_auth_upload_and_revoke(self):
        self.assertEqual(self.client.get('/api/v1/market').status_code,401)
        headers={'Authorization':'Bearer '+self.token}
        self.assertEqual(self.client.post('/api/v1/observations',json=self.data).status_code,401)
        self.assertEqual(self.client.post('/api/v1/observations',json=self.data,headers=headers).status_code,201)
        self.assertEqual(self.client.post('/api/v1/observations',json=self.data,headers=headers).status_code,200)
        self.assertEqual(self.client.get('/api/v1/market',headers=headers).status_code,200)
        self.store.revoke(self.a)
        self.assertEqual(self.client.get('/api/v1/market',headers=headers).status_code,401)

    def test_cookie_flags_and_origin(self):
        response=self.client.post('/api/v1/login',json={'token':self.token})
        cookie=response.headers['Set-Cookie']
        for flag in ['Secure','HttpOnly','SameSite=Strict']:self.assertIn(flag,cookie)
        self.assertEqual(self.client.post('/api/v1/login',json={'token':self.token},headers={'Origin':'https://evil.invalid'}).status_code,403)

    def test_clock_window_and_bad_shape(self):
        self.data['observed_at']=time.time()+600
        with self.assertRaises(ValueError):validate(self.data)
        self.assertEqual(self.client.post('/api/v1/observations',json=[],headers={'Authorization':'Bearer '+self.token}).status_code,400)


if __name__=='__main__':unittest.main()
