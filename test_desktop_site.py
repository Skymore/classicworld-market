"""Whole-site desktop bridge: identity, scoped writes and public price reads."""
import json
import threading
import unittest
import urllib.request
import urllib.error
from tempfile import TemporaryDirectory
from unittest.mock import patch, Mock
from collector_dashboard import create_server

class DesktopSiteTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.gateway=Mock(last_error=False)
        def fetch(path,*args,**kwargs):
            if path=='/api/v1/collector/profile':return {'nickname':'Test'}
            if path=='/api/v1/collector/watch-data':return {'linked':True,'public_id':'account-a','records':[]}
            return {'path':path}
        self.gateway.fetch.side_effect=fetch
        self.gateway.update.return_value={'records':[]}
        with patch('collector_dashboard.Gateway',return_value=self.gateway):
            self.server=create_server({},self.temp.name,0)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.base=f'http://127.0.0.1:{self.server.server_port}'
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(self,path,data=None,origin=None,csrf=None):
        headers={}
        if data is not None:headers.update({'Content-Type':'application/json','Origin':origin or self.base,'X-CSRF-Token':csrf or ''})
        return self.opener.open(urllib.request.Request(self.base+path,data=None if data is None else json.dumps(data).encode(),headers=headers))
    def test_shared_account_scoped_writes_and_csrf(self):
        with self.request('/api/v1/account') as r:profile=json.load(r)
        self.assertEqual(profile['public_id'],'account-a');self.assertEqual(profile['sync_scope'],'watch')
        with self.request('/api/v1/account/data?account=account-a') as r:self.assertEqual(json.load(r)['public_id'],'account-a')
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data?account=other')
        self.assertEqual(e.exception.code,403)
        change={'account':'account-a','operations':[{'kind':'watch','key':'1002000','value':None,'version':1}]}
        with self.request('/api/v1/account/data',change,csrf=profile['csrf']) as r:self.assertEqual(r.status,200)
        self.gateway.update.assert_called_once_with('/api/v1/collector/watch-data',change)
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data',change,origin='https://evil.invalid',csrf=profile['csrf'])
        self.assertEqual(e.exception.code,403)
        with self.assertRaises(urllib.error.HTTPError) as e:self.request('/api/v1/account/data',change)
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

if __name__=='__main__':unittest.main()
