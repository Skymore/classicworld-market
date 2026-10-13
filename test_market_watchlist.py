import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from market_watchlist import ARCHER_PRESET,listing,parse_item_ids,report_listings,search_catalog,visit_listings


class WatchlistTests(unittest.TestCase):
    def row(self,**changes):
        row=dict(world='ClassicWorld',shop_key='shop',shop='Test Shop',item_id=1452003,slot=1,
                 variant='equipment-a',time=1000,price=10000,bundle=1,stock=1,
                 equipment=dict(stats=[dict(label='物理攻击',value=40)],enhancements=0,remaining_upgrades=7),
                 source='private-source',raw_source='private-packets')
        row.update(changes);return row

    def test_equipment_included_without_bargain_or_sample_requirements(self):
        result=report_listings(dict(products=[dict(item_id=1452003,quotes=[self.row()])]),[1452003])
        self.assertEqual(result['total'],1)
        self.assertEqual(result['listings'][0]['equipment']['stats'][0]['value'],40)
        self.assertNotIn('private-',json.dumps(result))

    def test_dedup_preserves_variant_and_price_changes_not_stock_changes(self):
        original=listing(self.row())
        self.assertEqual(original['id'],listing(self.row(stock=5,time=1001))['id'])
        self.assertNotEqual(original['id'],listing(self.row(price=9000))['id'])
        self.assertNotEqual(original['id'],listing(self.row(variant='equipment-b'))['id'])
        self.assertNotEqual(original['id'],listing(self.row(time=1000+86400))['id'])

    def test_rejects_sold_out_experiments_and_invalid_price(self):
        for changes in (dict(stock=0),dict(experimental=True),dict(price=-1),dict(bundle=0),
                        dict(price=float('inf')),dict(stock=True),dict(item_id=True)):
            self.assertIsNone(listing(self.row(**changes)))

    def test_fresh_passive_visit_and_stale_exclusion(self):
        visit=dict(time=1000,shop_id=1,title='shop',items=[dict(item_id=1462004,slot=2,
                   price_mesos_candidate=5000,bundle_quantity_candidate=1,available_quantity_candidate=1)])
        self.assertEqual(visit_listings(visit,now=1001)[0]['item_id'],1462004)
        self.assertEqual(visit_listings(visit,now=1201),[])
        self.assertEqual(visit_listings(dict(visit,triggered_by_python=True),now=1001),[])

    def test_catalogue_preset_and_unobserved_item_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'items.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE items(item_id INTEGER,name_zh TEXT,name_en TEXT,icon_url TEXT,record_json TEXT)')
                for iid in ARCHER_PRESET:
                    db.execute('INSERT INTO items VALUES(?,?,?,?,?)',(iid,'弓弩',f'Weapon {iid}',None,json.dumps(dict(level=25 if iid in (1452003,1462003) else 30))))
            db.close()
            self.assertEqual(len(search_catalog(path)['presets'][0]['items']),4)
            self.assertEqual(search_catalog(path,'1452003')['items'][0]['item_id'],1452003)
            self.assertEqual(len(search_catalog(path,'Weapon')['items']),4)
            self.assertEqual(search_catalog(path,'9'*100)['items'],[])
            self.assertEqual(search_catalog(path,'%')['items'],[])

    def test_item_id_boundaries_and_empty_watch_list(self):
        self.assertEqual(parse_item_ids('1452003,1462004'),{1452003,1462004})
        self.assertEqual(parse_item_ids(''),set())
        for value in ('evil','1452003,','1',','.join(['1452003']*101)):
            with self.assertRaises(ValueError):parse_item_ids(value)


if __name__=='__main__':unittest.main()
