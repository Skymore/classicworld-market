import json
from pathlib import Path
import sqlite3
import unittest

ROOT=Path(__file__).resolve().parent

class CatalogTests(unittest.TestCase):
    def test_full_catalog_and_chinese_coverage(self):
        data=json.loads((ROOT/'item_database/items.json').read_text(encoding='utf-8'))
        raw=json.loads((ROOT/'item_database/sources/dvg_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual({r['item_id'] for r in data['items']},{r['itemid'] for r in raw['rows']})
        self.assertEqual(len(data['items']),7608)
        self.assertTrue(all(r['name_zh'] for r in data['items']))
        self.assertEqual(sum(r['name_status']=='assistant_translation' for r in data['items']),1469)

    def test_sqlite_identity_and_version_separation(self):
        with sqlite3.connect(ROOT/'item_database/items.sqlite') as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            row=db.execute('SELECT name_zh,name_en,record_json FROM items WHERE item_id=1092002').fetchone()
            self.assertEqual(row[:2],('锅盖','Pan Lid'))
            data=json.loads(row[2])
            self.assertEqual(data['base_stats'],[{'key':'incPDD','label':'物防','value':44}])
            self.assertEqual(data['mapledex_reference']['version'],'CW GMS_COT2_2026-08-11')

    def test_market_rows_preserved(self):
        count=0
        for path in (ROOT/'network_captures').glob('*/decoded_shops.json'):
            before=json.loads(path.read_text(encoding='utf-8'))
            after=json.loads(path.with_name('decoded_shops_zh.json').read_text(encoding='utf-8'))
            self.assertEqual(len(before['shops']),len(after['shops']))
            self.assertEqual(after['translation_summary']['missing_ids'],[])
            for bs,as_ in zip(before['shops'],after['shops']):
                self.assertEqual(bs['title'],as_['title'])
                self.assertEqual(len(bs['items']),len(as_['items']))
                for bi,ai in zip(bs['items'],as_['items']):
                    self.assertEqual(bi,{k:ai[k] for k in bi})
                    self.assertTrue(ai['name_zh'])
                    count+=1
        self.assertEqual(count,271)

if __name__=='__main__':
    unittest.main()
