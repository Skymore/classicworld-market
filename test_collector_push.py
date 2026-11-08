import io,json,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from collector_dashboard import Gateway
from unittest.mock import patch

class PersonalEventGateway(unittest.TestCase):
 def test_auto_bridge_allows_only_official_origins_read_only_routes_and_exact_host(self):
  from collector_dashboard import create_server
  import threading,urllib.request,urllib.error
  with tempfile.TemporaryDirectory() as folder:
   server=create_server({'endpoint':'http://127.0.0.1:1234','token':'synthetic-secret-'+'z'*32},Path(folder),port=0)
   thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   base=f'http://127.0.0.1:{server.server_port}'
   try:
    request=urllib.request.Request(base+'/api/v1/collector/status',headers={'Origin':'https://mxd.ruit.me'})
    with urllib.request.urlopen(request) as response:
     self.assertEqual(response.headers['Access-Control-Allow-Origin'],'https://mxd.ruit.me')
     self.assertNotIn(b'synthetic-secret',response.read())
    request=urllib.request.Request(base+'/api/v1/collector/status',method='OPTIONS',headers={'Origin':'https://mxd.ruit.me','Access-Control-Request-Method':'GET','Access-Control-Request-Private-Network':'true'})
    with urllib.request.urlopen(request) as response:
     self.assertEqual(response.status,204);self.assertEqual(response.headers['Access-Control-Allow-Private-Network'],'true')
    for path,headers in [('/api/v1/collector/status',{'Origin':'https://evil.example'}),('/healthz',{'Origin':'https://mxd.ruit.me'}),('/api/v1/collector/status',{'Origin':'https://mxd.ruit.me','Host':'evil.example'})]:
     with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(base+path,headers=headers))
     self.assertEqual(error.exception.code,403);self.assertIsNone(error.exception.headers.get('Access-Control-Allow-Origin'))
   finally:server.shutdown();server.server_close();thread.join(3)
 def test_personal_watch_route_is_uncached_validated_and_contains_no_token(self):
  from collector_dashboard import create_server
  import threading,urllib.request,urllib.error
  token='synthetic-secret-'+'z'*32
  with tempfile.TemporaryDirectory() as folder:
   with patch.object(Gateway,'fetch',return_value={'personal':True,'collector_id':'test','listings':[]}) as fetch:
    server=create_server({'endpoint':'http://127.0.0.1:1234','token':token},Path(folder),port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
     base=f'http://127.0.0.1:{server.server_port}'
     with urllib.request.urlopen(base+'/api/v1/collector/watch-listings?ids=1072128') as response:
      self.assertEqual(response.status,200);self.assertNotIn(token.encode(),response.read())
     fetch.assert_called_once_with('/api/v1/collector/watch-listings?ids=1072128',0)
     with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(base+'/api/v1/collector/watch-listings?ids=bad')
     self.assertEqual(error.exception.code,400)
    finally:server.shutdown();server.server_close();thread.join(3)
 def test_selling_page_reads_local_bag_and_proxies_validated_prices(self):
  from collector_dashboard import create_server
  import threading,urllib.request,urllib.error
  with tempfile.TemporaryDirectory() as folder:
   holdings={'observed_at':int(time.time()),'mesos':5,'categories':[2,3,4],'items':[{'item_id':2000002,'quantity':600}]}
   (Path(folder)/'inventory_state.json').write_text(json.dumps({'alive_at':int(time.time()),'holdings':holdings}),encoding='utf-8')
   with patch.object(Gateway,'fetch',return_value={'products':[]}) as fetch:
    server=create_server({'endpoint':'http://127.0.0.1:1234','token':'synthetic-secret-'+'z'*32},Path(folder),port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
     base=f'http://127.0.0.1:{server.server_port}'
     with urllib.request.urlopen(base+'/selling') as response:self.assertEqual(response.status,200)
     with urllib.request.urlopen(base+'/api/v1/collector/inventory') as response:
      self.assertEqual(json.loads(response.read())['holdings'],holdings)
     urllib.request.urlopen(base+'/api/v1/market/selected?hours=72&ids=2000002').read()
     fetch.assert_called_with('/api/v1/market/selected?hours=72&ids=2000002',30)
     urllib.request.urlopen(base+'/api/v1/npc-sell?ids=2000002').read()
     fetch.assert_called_with('/api/v1/npc-sell?ids=2000002',3600)
     for bad in ('/api/v1/npc-sell?ids=x','/api/v1/market/selected?hours=5&ids=2000002'):
      with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(base+bad)
      self.assertEqual(error.exception.code,400)
    finally:server.shutdown();server.server_close();thread.join(3)
 def test_relay_preserves_events_invalidates_cache_and_keeps_token_out_of_body(self):
  with tempfile.TemporaryDirectory() as folder:
   token='synthetic-private-'+'x'*32
   gateway=Gateway({'endpoint':'http://127.0.0.1:1234','token':token},Path(folder))
   gateway.cache['old']=(time.monotonic(),{'stale':True})
   response=io.BytesIO(b'event: market\ndata: {}\n\n: heartbeat\n\n')
   response.headers={'Content-Type':'text/event-stream'}
   requests=[]
   def open_request(request,timeout):requests.append(request);return response
   gateway.opener=SimpleNamespace(open=open_request)
   output=io.BytesIO();headers={}
   handler=SimpleNamespace(wfile=output,send_response=lambda status:self.assertEqual(status,200),send_header=lambda key,value:headers.update({key:value}),end_headers=lambda:None)
   gateway.stream_events(handler)
   self.assertEqual(gateway.cache,{})
   self.assertIn(b'event: market',output.getvalue())
   self.assertNotIn(token.encode(),output.getvalue())
   self.assertEqual(requests[0].get_header('Authorization'),'Bearer '+token)
   self.assertEqual(headers['Content-Type'],'text/event-stream')
 def test_live_market_and_personal_alerts_do_not_reuse_time_based_cache(self):
  with tempfile.TemporaryDirectory() as folder:
   gateway=Gateway({'endpoint':'http://127.0.0.1:1234','token':'x'*32},Path(folder))
   calls=[]
   def fetch(path,ttl):
    calls.append((path,ttl));return {'opportunities':[]} if 'collector/alerts' in path else {'products':[]}
   gateway.fetch=fetch
   result=gateway.market({'summary':['1']})
   self.assertTrue(result['realtime'])
   self.assertTrue(all(ttl==0 for path,ttl in calls))

 def test_capture_status_distinguishes_connection_from_product_parsing_and_stale_heartbeat(self):
  with tempfile.TemporaryDirectory() as folder:
   gateway=Gateway({'endpoint':'http://127.0.0.1:1234','token':'x'*32,'member_id':'synthetic-owner'},Path(folder))
   file=Path(folder)/'passive_status.json'
   self.assertEqual(gateway.status(now=100)['connection_health']['state'],'offline')
   def status(**values):
    file.write_text(json.dumps(dict(time=100,connections=1,decoding=1,failed=0,**values)))
    return gateway.status(now=101)
   self.assertEqual(status()['connection_health']['state'],'connected')
   current=status(last_shop_at=100,location={'channel':4,'room':1},body_hex='DO_NOT_LEAK')
   self.assertEqual(current['connection_health']['state'],'capturing')
   self.assertEqual(current['location'],{'channel':4,'room':1})
   self.assertNotIn('DO_NOT_LEAK',json.dumps(current))
   self.assertEqual(gateway.status(now=111)['connection_health']['state'],'offline')
   file.write_text(json.dumps(dict(time=100,connections=1,decoding=0,failed=1)))
   self.assertEqual(gateway.status(now=101)['connection_health']['state'],'parse_error')

 def test_old_running_collector_location_uses_only_latest_bounded_map_metadata(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);gateway=Gateway({'endpoint':'http://127.0.0.1:1234','token':'x'*32},root)
   (root/'passive_status.json').write_text(json.dumps(dict(time=100,connections=1,decoding=1)))
   maps=root/'map_observations.jsonl';maps.write_text(json.dumps({'location':{'channel':4,'room':1},'evidence':{'prefix_hex':'DO_NOT_LEAK'}})+'\n')
   result=gateway.status(now=101);self.assertEqual(result['location'],{'channel':4,'room':1});self.assertNotIn('DO_NOT_LEAK',json.dumps(result))
   with maps.open('a') as out:out.write(json.dumps({'location':None})+'\n')
   self.assertIsNone(gateway.status(now=101)['location'])
   (root/'passive_status.json').write_text('[]')
   self.assertEqual(gateway.status(now=101)['connection_health']['state'],'offline')
