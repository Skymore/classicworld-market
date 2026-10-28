"""Whole-site desktop bridge: device identity, scoped writes, login callback, account events."""
import json
import socket
import threading
import time
import unittest
import urllib.request
import urllib.error
from tempfile import TemporaryDirectory
from unittest.mock import patch, Mock
from urllib.parse import parse_qs, urlsplit
from account_device import DeviceError
from collector_dashboard import create_server

TOKEN = 'cwd_'+'A'*43
RECORD = dict(token=TOKEN, account=dict(id='account-a', nickname='Tester'), device=dict(id='dev-1', name='PC'))


class DesktopSiteTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.gateway=Mock(last_error=False)
        def fetch(path,*args,**kwargs):
            if path=='/api/v1/collector/profile':return {'nickname':'Test'}
            return {'path':path}
        self.gateway.fetch.side_effect=fetch
        with patch('collector_dashboard.Gateway',return_value=self.gateway):
            self.server=create_server({'endpoint':'https://mxd.ruit.me','token':'collector-secret'},self.temp.name,0)
        self.device=self.server.device
        self.sent=[]
        self.answers={}
        def send(method,path,body=None,bearer=None,timeout=10):
            self.sent.append((method,path,body,bearer))
            answer=self.answers.get(path,{'account':{'id':'account-a'},'records':[]})
            if isinstance(answer,Exception):raise answer
            return answer
        self.device.send=send
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown);self.addCleanup(self.server.stop_device)
        self.base=f'http://127.0.0.1:{self.server.server_port}'
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(self,path,data=None,origin=None,csrf=None):
        headers={}
        if data is not None:headers.update({'Content-Type':'application/json','Origin':origin or self.base,'X-CSRF-Token':csrf or ''})
        return self.opener.open(urllib.request.Request(self.base+path,data=None if data is None else json.dumps(data).encode(),headers=headers))
    def profile(self):
        with self.request('/api/v1/account') as r:return json.load(r)

    def test_profile_reflects_the_device_login_without_old_watch_data(self):
        self.assertEqual(self.profile()['linked'],False)
        self.device.store.save(RECORD)
        profile=self.profile()
        self.assertEqual((profile['linked'],profile['public_id'],profile['sync_scope'],profile['mode']),(True,'account-a','watch','collector'))
        self.assertNotIn(TOKEN,json.dumps(profile))
        self.assertNotIn('/api/v1/collector/watch-data',[c.args[0] for c in self.gateway.fetch.call_args_list])

    def test_account_data_maps_to_device_data_for_the_same_account_only(self):
        self.device.store.save(RECORD)
        csrf=self.profile()['csrf']
        with self.request('/api/v1/account/data?account=account-a') as r:self.assertEqual(json.load(r)['records'],[])
        self.assertEqual(self.sent[-1],('GET','/api/v1/device/data',None,TOKEN))
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data?account=other')
        self.assertEqual(e.exception.code,403)
        change={'account':'account-a','operations':[{'kind':'watch','key':'1002000','value':None,'version':1}]}
        with self.request('/api/v1/account/data',change,csrf=csrf) as r:self.assertEqual(r.status,200)
        self.assertEqual(self.sent[-1],('POST','/api/v1/device/data',{'operations':change['operations']},TOKEN))
        count=len(self.sent)
        for bad in [dict(change,account='other'),dict(change,operations='x')]:
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data',bad,csrf=csrf)
            self.assertIn(e.exception.code,(400,403))
        for origin,token in [('https://evil.invalid',csrf),('https://mxd.ruit.me',csrf),(None,'wrong')]:
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data',change,origin=origin,csrf=token)
            self.assertEqual(e.exception.code,403)
        self.assertEqual(len(self.sent),count,'rejected writes never reach the cloud')

    def test_conflicts_pass_through_and_revoked_token_signs_out(self):
        self.device.store.save(RECORD)
        csrf=self.profile()['csrf']
        self.answers['/api/v1/device/data']=DeviceError(409,{'error':'sync_conflict'})
        change={'account':'account-a','operations':[{'kind':'watch','key':'1002000','value':None,'version':1}]}
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data',change,csrf=csrf)
        self.assertEqual((e.exception.code,json.load(e.exception)),(409,{'error':'sync_conflict'}))
        self.answers['/api/v1/device/data']=DeviceError(401,{'error':'login_required'})
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data?account=account-a')
        self.assertEqual(e.exception.code,401)
        self.assertFalse(self.profile()['linked'])

    def test_login_requires_local_nonce_and_callback_only_while_pending(self):
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/callback?code=x&state=y')
        self.assertEqual(e.exception.code,404)
        with self.request('/api/v1/device/login') as r:state=json.load(r)
        self.assertFalse(state['pending'])
        for origin,token in [('https://mxd.ruit.me',state['csrf']),(None,'wrong')]:
            with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/device/login',{},origin=origin,csrf=token)
            self.assertEqual(e.exception.code,403)
        with self.request('/api/v1/device/login',{},csrf=state['csrf']) as r:url=json.load(r)['url']
        query={k:v[0] for k,v in parse_qs(urlsplit(url).query).items()}
        self.assertTrue(url.startswith('https://mxd.ruit.me/device?'))
        self.assertEqual(query['redirect_uri'],self.base+'/callback')
        self.assertEqual(set(query),{'redirect_uri','state','challenge','name'})
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/callback?code='+'C'*43+'&state=forged')
        self.assertEqual(e.exception.code,400)
        self.answers['/api/v1/device/token']=RECORD
        with self.request('/callback?code='+'C'*43+'&state='+query['state']) as r:
            page=r.read().decode()
            self.assertIn('已登录，可以关闭此页',page);self.assertNotIn(query['state'],page)
            self.assertEqual(r.headers['Referrer-Policy'],'no-referrer')
        method,path,body,bearer=self.sent[-1]
        self.assertEqual((path,bearer,body['redirect_uri']),('/api/v1/device/token','collector-secret',self.base+'/callback'))
        self.assertEqual(self.device.token(),TOKEN)
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/callback?code='+'C'*43+'&state='+query['state'])
        self.assertEqual(e.exception.code,404)

    def test_account_events_relay_fans_out_locally(self):
        def subscribe():
            connection=socket.create_connection(('127.0.0.1',self.server.server_port),timeout=5)
            connection.sendall(f'GET /api/v1/account/events HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n\r\n'.encode())
            reader=connection.makefile('rb')
            while reader.readline() not in (b'\r\n',b'\n'):pass
            self.assertEqual(reader.readline(),b'event: hello\n')
            reader.readline();reader.readline()
            return connection,reader
        first,second=subscribe(),subscribe()
        deadline=time.monotonic()+3
        while len(self.server.relay.queues)<2 and time.monotonic()<deadline:time.sleep(.02)
        self.server.relay.broadcast('sweep');self.server.relay.broadcast('not-a-topic')
        for connection,reader in (first,second):
            self.assertEqual(reader.readline(),b'event: sweep\n')
            connection.close()
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.opener.open(urllib.request.Request(self.base+'/api/v1/account/events',headers={'Origin':'https://evil.invalid'}))
        self.assertEqual(e.exception.code,403)

    def test_whole_pages_can_be_framed_only_locally(self):
        for path in ('/watch','/prices'):
            with self.request(path) as r:
                self.assertIn('frame-ancestors http://127.0.0.1:*',r.headers['Content-Security-Policy'])
                self.assertIn(b'/web/react/app.js',r.read())

    def test_price_records_and_crafting_forward(self):
        for path in ('/api/v1/market/records?kind=sales&hours=24','/api/v1/crafting/prices'):
            with self.request(path) as r:self.assertEqual(json.load(r)['path'],path)
        with self.assertRaises(urllib.error.HTTPError):self.request('/api/v1/market/records?kind=invalid')
        with self.request('/api/v1/catalog/page?url=%2Fitem%2F1002000&preview=true') as r:self.assertIn('/api/v1/catalog/page?',json.load(r)['path'])
        with self.assertRaises(urllib.error.HTTPError):self.request('/api/v1/catalog/page?url=https%3A%2F%2Fevil.invalid')

    def test_local_simulator_bridge_is_gone(self):
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/collector/sweep')
        self.assertEqual(e.exception.code,404)

if __name__=='__main__':unittest.main()
