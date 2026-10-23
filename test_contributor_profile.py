"""Account changes require the local UI nonce; collector credentials stay server-side."""
import json,tempfile,threading,unittest,urllib.request,urllib.error
import os,subprocess,sys,time
from pathlib import Path
from unittest.mock import patch
from collector_dashboard import Gateway,create_server

class ContributorGateway(unittest.TestCase):
 def test_dashboard_exits_when_its_own_parent_exits(self):
  import psutil
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);config=root/'member.json';config.write_text(json.dumps({'endpoint':'http://127.0.0.1:1234','token':'test-only-private-collector-token'}))
   parent=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
   process=None
   try:
    process=subprocess.Popen([sys.executable,str(Path(__file__).parent/'shared_client.py'),'--dashboard-only','--dashboard-port','0','--home',str(root),'--config',str(config),'--dashboard-parent-pid',str(parent.pid),'--dashboard-parent-created',str(psutil.Process(parent.pid).create_time())],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    ready=root/'dashboard.json';deadline=time.monotonic()+10
    while not ready.exists() and time.monotonic()<deadline:time.sleep(.05)
    self.assertTrue(ready.exists());parent.terminate();parent.wait(5)
    self.assertEqual(process.wait(5),0)
   finally:
    for p in (process,parent):
     if p and p.poll() is None:p.kill();p.wait(5)
 def test_second_dashboard_cannot_reuse_first_dashboard_port(self):
  with tempfile.TemporaryDirectory() as folder:
   config={'endpoint':'http://127.0.0.1:1234','token':'test-only-private-collector-token'}
   first=create_server(config,Path(folder),port=0)
   try:
    second=create_server(config,Path(folder),port=first.server_port)
    try:self.assertNotEqual(first.server_port,second.server_port)
    finally:second.server_close()
   finally:first.server_close()
 def test_profile_writes_require_same_origin_nonce_and_never_expose_collector_token(self):
  token='test-only-private-collector-token'
  with tempfile.TemporaryDirectory() as folder, patch.object(Gateway,'fetch',return_value={'nickname':'Old','listed':False}) as fetch, patch.object(Gateway,'update',return_value={'ok':True}) as update:
   server=create_server({'endpoint':'http://127.0.0.1:1234','token':token},Path(folder),port=0)
   thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   base=f'http://127.0.0.1:{server.server_port}'
   try:
    with urllib.request.urlopen(base+'/api/v1/account') as response:
     raw=response.read();profile=json.loads(raw);self.assertNotIn(token.encode(),raw)
     self.assertEqual(response.headers['Cache-Control'],'no-store')
    self.assertEqual(profile['mode'],'collector');self.assertTrue(profile['signed_in'])
    fetch.assert_called_once_with('/api/v1/collector/profile',0)
    body=json.dumps({'nickname':'New','listed':True}).encode()
    valid={'Origin':base,'X-CSRF-Token':profile['csrf'],'Content-Type':'application/json'}
    for headers in [{},{**valid,'Origin':'https://evil.example'},{**valid,'Origin':'https://mxd.ruit.me'},{**valid,'X-CSRF-Token':'wrong'},{**valid,'Host':'evil.example'}]:
     with self.assertRaises(urllib.error.HTTPError) as error:
      urllib.request.urlopen(urllib.request.Request(base+'/api/v1/account',data=body,headers=headers))
     self.assertEqual(error.exception.code,403)
    update.assert_not_called()
    with urllib.request.urlopen(urllib.request.Request(base+'/api/v1/account',data=body,headers=valid)) as response:self.assertEqual(response.status,200)
    update.assert_called_once_with('/api/v1/collector/profile',{'nickname':'New','listed':True})
    with self.assertRaises(urllib.error.HTTPError) as error:
     urllib.request.urlopen(urllib.request.Request(base+'/api/v1/account',data=b'x'*2049,headers=valid))
    self.assertEqual(error.exception.code,400)
   finally:server.shutdown();server.server_close();thread.join(3)

if __name__=='__main__':unittest.main()
