"""Loopback integration with synthetic data only; optional built EXE smoke test."""
import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from werkzeug.serving import make_server
from shared_store import SharedStore
from shared_server import create_app
from shared_client import upload_once


class UploadIntegration(unittest.TestCase):
    def test_http_and_optional_windows_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);store=SharedStore(root/'server',root/'no_catalog')
            _,token=store.invite('synthetic-test')
            server=make_server('127.0.0.1',0,create_app(store))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                cfg=dict(endpoint=f'http://127.0.0.1:{server.server_port}',token=token)
                captures=root/'captures';captures.mkdir()
                data=dict(session='synthetic',time=time.time(),shop_id=12,title='TEST ONLY',
                    host='DO_NOT_UPLOAD',raw_source='DO_NOT_UPLOAD',items=[dict(item_id=4010001,slot=1,
                    price_mesos_candidate=500,bundle_quantity_candidate=1,available_quantity_candidate=1)])
                (captures/'shop_test.json').write_text(json.dumps(data),encoding='utf-8')
                self.assertEqual(upload_once(captures,cfg,root/'queue.sqlite'),1)
                self.assertEqual(upload_once(captures,cfg,root/'queue.sqlite'),0)
                exe=Path('dist/ClassicWorldCollector/ClassicWorldCollector.exe').resolve()
                if exe.exists():
                    check=subprocess.run([str(exe),'--self-test','--home',str(root/'selftest')],capture_output=True,timeout=30)
                    self.assertIn(b'Codec self-test passed',check.stdout,check.stderr.decode(errors='replace'))
                    config=root/'member.json';config.write_text(json.dumps(cfg),encoding='utf-8')
                    result=subprocess.run([str(exe),'--once','--upload-only','--home',str(root/'client'),
                        '--config',str(config),'--folder',str(captures)],capture_output=True,timeout=30)
                    self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))
                    self.assertIn(b'Uploaded 1',result.stdout)
                self.assertEqual(store.report()['manual_visits'],1)
                with store.repo.connect() as db:payload=db.execute('SELECT payload FROM uploads').fetchone()[0]
                self.assertNotIn('DO_NOT_UPLOAD',payload)
            finally:server.shutdown();server.server_close();thread.join(timeout=5)


if __name__=='__main__':unittest.main()
