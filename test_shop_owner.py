import io,json,sqlite3,struct,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import closing
from market_shop_owner import decode_owner,owner_from_snapshot
from market_proxy import Session
from shared_protocol import from_snapshot,validate
from collector_owner_migration import migrate_owners

class ShopOwners(unittest.TestCase):
    def packets(self):
        title=b'Example shop';identity=struct.pack('<IIH',84954,123456,6)+b'Host01'
        record=struct.pack('<HHIIQBBI',4,1,12,1,500,1,2,4010001)
        items=struct.pack('<H',1)+record
        opened=struct.pack('<H',0x57a)+b'\x02'+bytes(11)+struct.pack('<IH',123,len(title))+title
        opened+=struct.pack('<I',2)+identity+b'\0'*10+identity+items
        listed=struct.pack('<H',0x57b)+bytes(4)+items
        return opened,listed
    def snapshot(self,folder):
        app=SimpleNamespace(folder=folder,market_only=True,event=lambda *a,**kw:None)
        session=Session(app,None,None,None,None,'test',8913)
        for packet in self.packets():session.observe(packet)
        path=next(folder.glob('shop_*.json'))
        return path,json.loads(path.read_text())
    def test_host_and_repeat_validation(self):
        opened,_=self.packets()
        self.assertEqual(decode_owner(opened)['character_id'],84954)
        self.assertIsNone(decode_owner(opened,title='different'))
        self.assertIsNone(decode_owner(opened,shop_id=321))
        self.assertIsNone(decode_owner(opened.replace(b'Host01',b'Guest1',1)))
        for size in range(20):self.assertIsNone(decode_owner(opened[:size]))
    def test_local_pair_validation_and_optional_protocol(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);_,data=self.snapshot(folder)
            self.assertEqual(data['owner']['name'],'Host01')
            self.assertEqual(owner_from_snapshot(data,folder),data['owner'])
            self.assertEqual(from_snapshot(data)['owner'],data['owner'])
            data.pop('owner');self.assertNotIn('owner',from_snapshot(data))
            data['items'][0]['price_mesos_candidate']=700
            self.assertIsNone(owner_from_snapshot(data,folder))
            data['raw_source']='../raw_shop_'+'a'*32+'.jsonl'
            self.assertIsNone(owner_from_snapshot(data,folder))
    def test_migration_only_sends_structured_evidence_once_without_sqlite_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);path,data=self.snapshot(folder);ledger=folder/'upload.sqlite'
            with closing(sqlite3.connect(ledger)) as db, db:
                db.execute('CREATE TABLE sent(path TEXT PRIMARY KEY,status TEXT,updated REAL)')
                db.execute('INSERT INTO sent VALUES (?,?,?)',(path.name,'sent',time.time()))
            requests=[]
            def post(request,timeout):
                payload=json.loads(request.data);requests.append(payload)
                self.assertEqual(payload['owner']['name'],'Host01')
                self.assertNotIn('body_hex',request.data.decode());self.assertNotIn('raw_source',payload)
                # Live uploader must be able to write while HTTP repair is in flight.
                with closing(sqlite3.connect(ledger,timeout=.1)) as db, db:db.execute('UPDATE sent SET updated=updated+1')
                return io.BytesIO(b'{"ok":true,"repaired":true}')
            opener=SimpleNamespace(open=post);config={'endpoint':'http://127.0.0.1:8766','token':'private-test'}
            self.assertEqual(migrate_owners(folder,config,ledger,opener),1)
            with closing(sqlite3.connect(ledger)) as db, db:db.execute('DELETE FROM owner_repair_state')
            self.assertEqual(migrate_owners(folder,config,ledger,opener),0)
            self.assertEqual(len(requests),1)

if __name__=='__main__':unittest.main()
