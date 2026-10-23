import json,struct,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from market_proxy import Session
from decode_shops import rows
from market_location import inspect_map

class ProtocolCompatibility(unittest.TestCase):
    def messages(self,op):
        record=struct.pack('<HHIIQBBI',4,1,12,1,500,1,2,4010001)
        body=struct.pack('<H',1)+record
        listed=struct.pack('<H',op+1)+bytes(4)+body
        title=b'Compatibility shop'
        opened=struct.pack('<H',op)+b'\x02'+bytes(11)+struct.pack('<I',123)+struct.pack('<H',len(title))+title+body
        return opened,listed

    def test_old_and_new_shop_pairs_keep_original_evidence(self):
        for opcode in (0x577,0x57a):
            with self.subTest(opcode=opcode),tempfile.TemporaryDirectory() as temp:
                app=SimpleNamespace(folder=Path(temp),market_only=True,event=lambda *a,**kw:None)
                session=Session(app,None,None,None,None,'test',8913)
                opened,listed=self.messages(opcode)
                session.observe(opened);session.observe(listed)
                files=list(Path(temp).glob('shop_*.json'));self.assertEqual(len(files),1)
                data=json.loads(files[0].read_text())
                self.assertEqual(data['items'][0]['price_mesos_candidate'],500)
                raw=Path(temp)/data['raw_source']
                self.assertEqual(json.loads(raw.read_text().splitlines()[0])['body_hex'],opened.hex())

    def test_mixed_pairs_and_malformed_lists_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            app=SimpleNamespace(folder=Path(temp),market_only=True,event=lambda *a,**kw:None)
            session=Session(app,None,None,None,None,'test',8913)
            opened,_=self.messages(0x577);_,listed=self.messages(0x57a)
            session.observe(opened);session.observe(listed)
            self.assertFalse(list(Path(temp).glob('shop_*.json')))
        _,listed=self.messages(0x57a)
        for bad in (b'\x7b\x05',listed[:7],listed[:2]+b'bad!'+listed[6:]):
            with self.assertRaises(ValueError):rows(bad)

    def test_new_map_opcode_uses_same_structural_validation(self):
        data=bytearray(7600);struct.pack_into('<H',data,0,0x1a9)
        struct.pack_into('<I',data,10,8);data[19]=1;struct.pack_into('<I',data,247,80002008)
        self.assertEqual(inspect_map(data)[0]['room'],8)
        data[19]=0;self.assertIsNone(inspect_map(data)[0])
