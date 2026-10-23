import unittest
import json
import sqlite3
import tempfile
from pathlib import Path
from mesowatch_points import sale_point,location,build


class RawPointsTests(unittest.TestCase):
    def test_only_actual_price_and_evidence_are_converted(self):
        raw=dict(id='sale-1',price=399,qty=500,time='2026-10-22T12:00:00Z',how='went grey on screen',
                 seller='Seller',location='Free Market <8>')
        point=sale_point('basil:04010001',raw)
        self.assertEqual(point['unit_price'],399)
        self.assertEqual(point['kind'],'sold_out')
        self.assertNotIn('quantity',point)
        self.assertEqual(point['raw']['qty'],500)
        self.assertEqual(point['location']['room'],8)
        self.assertIsNone(point['location']['channel'])

    def test_unrecognized_evidence_is_not_silently_labeled_a_sale(self):
        with self.assertRaises(ValueError):
            sale_point('basil:04010001',dict(how='asking price'))

    def test_non_market_location_is_preserved_without_inventing_room(self):
        value=location(dict(location='Henesys'))
        self.assertEqual(value['text'],'Henesys')
        self.assertIsNone(value['room'])

    def test_same_seller_can_have_two_raw_quotes_and_summary_is_not_a_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'items').mkdir()
            catalog=root/'catalog.sqlite'
            with sqlite3.connect(catalog) as db:
                db.execute('CREATE TABLE items(item_id INTEGER,name_en TEXT,name_zh TEXT)')
                db.execute("INSERT INTO items VALUES(4010001,'Iron Ore','Iron Ore')")
            db.close()
            (root/'list.json').write_text(json.dumps(dict(market='Classic World',preview=False,
                items=[dict(id='basil:04010001',name='Iron Ore',unitBasis='item',price=9999)])))
            row=dict(seller='Same seller',location='Free Market <1>',price=500,qty=1,up=True,lastSeen='2026-10-22T12:00:00Z')
            (root/'items/basil_04010001.json').write_text(json.dumps(dict(id='basil:04010001',market='Classic World',
                generated_at='2026-10-22T12:01:00Z',sales=[],listings=[row,dict(row,price=600)])))
            result=build(root,catalog)
            self.assertEqual(result['sales'],[])
            self.assertEqual(len(result['listings']),2)
            self.assertNotEqual(result['listings'][0]['source_key'],result['listings'][1]['source_key'])
            self.assertEqual([q['unit_price'] for q in result['listings']],[500,600])


if __name__=='__main__':
    unittest.main()
