import io,json,tempfile,threading,time,unittest,subprocess
from pathlib import Path
from unittest.mock import patch
from collector_history import repair_history
from shared_protocol import digest


class Response(io.BytesIO):
    def __init__(self, data):super().__init__(json.dumps(data).encode())


class HistoryRecoveryTests(unittest.TestCase):
    def test_actual_bundle_repairs_saved_quote_without_game(self):
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        marker=Path('dist/bundle-path.txt')
        if not marker.exists():self.skipTest('bundle not built')
        exe=Path(marker.read_text(encoding='utf-8-sig').strip())/'ClassicWorldCollector.exe'
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);stamp=time.time()-3600
            snap=dict(session='bundle-test',time=stamp,shop_id=99,title='SYNTHETIC',items=[dict(item_id=4010001,slot=1,
                price_mesos_candidate=100,bundle_quantity_candidate=1,available_quantity_candidate=7)])
            captures=root/'captures';captures.mkdir();(captures/'shop_test.json').write_text(json.dumps(snap))
            packet=bytearray(103);packet[:2]=(0x1a9).to_bytes(2,'little');packet[10:14]=(32).to_bytes(4,'little');packet[36:40]=(80002007).to_bytes(4,'little')
            (captures/'map_observations.jsonl').write_text(json.dumps(dict(session='bundle-test',time=stamp-1,evidence=dict(length=103,prefix_hex=packet.hex())))+'\n')
            sent=[]
            class Handler(BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def reply(self,data):
                    data=json.dumps(data).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
                def do_GET(self):self.reply(dict(observations=[digest(['bundle-test',stamp,99])],next=None))
                def do_POST(self):
                    sent.append((self.path,json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                    self.reply(dict(ok=True,repaired=True))
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                config=root/'member.json';config.write_text(json.dumps(dict(endpoint=f'http://127.0.0.1:{server.server_port}',token='synthetic-only')))
                result=subprocess.run([str(exe),'--repair-history','--home',str(root),'--config',str(config),'--folder',str(captures)],capture_output=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn(b'Restored locations for 1',result.stdout)
                self.assertEqual(sent[0][0],'/api/v1/collector/repair-location')
                self.assertEqual(sent[0][1]['location']['channel'],33)
                self.assertEqual(sent[0][1]['items'][0]['stock'],7)
                self.assertEqual(sent[0][1]['observed_at'],stamp)
            finally:server.shutdown();server.server_close();thread.join()

    def run_history(self,context=True,active=False,after_map=False):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);stamp=time.time()-3600
            data=dict(session='same-connection',time=stamp,shop_id=123,title='Test',triggered_by_python=active,
                items=[dict(item_id=4010001,slot=1,category=4,price_mesos_candidate=100,
                    bundle_quantity_candidate=1,available_quantity_candidate=10)])
            (root/'shop_1.json').write_text(json.dumps(data))
            # Portal format accepted by the real parser, including CH33.
            packet=bytearray(103);packet[:2]=(0x1A9).to_bytes(2,'little');packet[10:14]=(32).to_bytes(4,'little')
            packet[36:40]=(80002007).to_bytes(4,'little')
            if context:(root/'map_observations.jsonl').write_text(json.dumps(dict(session='same-connection',
                time=stamp+(1 if after_map else -1),evidence=dict(length=103,prefix_hex=packet.hex())))+'\n')
            requests=[]
            class Opener:
                def open(self,request,timeout):
                    requests.append(request)
                    if request.get_method()=='GET':return Response(dict(observations=[digest([data['session'],stamp,123])],next=None))
                    return Response(dict(ok=True,repaired=True))
            n=repair_history([root],dict(endpoint='https://mxd.ruit.me',token='test-token'),Opener,threading.Event(),pace=0)
            return n,requests,data

    def test_recovers_only_location_using_same_session_evidence(self):
        n,requests,data=self.run_history();self.assertEqual(n,1)
        body=json.loads(requests[-1].data)
        self.assertEqual(body['location'],dict(channel=33,room=7,map_id=80002007))
        self.assertEqual(body['map_context'],dict(channel=33,map_id=80002007))
        self.assertEqual(body['observed_at'],data['time']);self.assertEqual(body['items'][0]['stock'],10)
        self.assertNotIn('prefix_hex',requests[-1].data.decode())

    def test_missing_evidence_does_not_guess(self):self.assertEqual(self.run_history(context=False)[0],0)
    def test_future_map_does_not_repair_earlier_quote(self):self.assertEqual(self.run_history(after_map=True)[0],0)
    def test_active_experiments_are_not_shared(self):self.assertEqual(self.run_history(active=True)[0],0)
    def test_rejects_other_upload_destinations(self):
        for endpoint in ['https://example.com','http://127.0.0.1:80@example.com','http://127.0.0.1:80/path']:
            with self.assertRaises(ValueError):repair_history([],dict(endpoint=endpoint,token='secret'),None,threading.Event())

if __name__=='__main__':unittest.main()
