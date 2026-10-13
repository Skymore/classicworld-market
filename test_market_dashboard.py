import json
import tempfile
import time
import unittest
from pathlib import Path
from market_dashboard import Repository


class RepositoryTests(unittest.TestCase):
    def test_default_72_hours_and_all_preserve_latest_shop_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);repo=Repository(root,root/'absent');now=time.time()
            for i,(shop,hours,price) in enumerate(((1,48,100),(2,100,200),(2,90,250))):
                path=root/f'{i}.json'
                path.write_text(json.dumps(dict(session='s',time=now-hours*3600,title=str(shop),shop_id=shop,
                    items=[dict(item_id=4000008,slot=1,available_quantity_candidate=5,
                                bundle_quantity_candidate=1,price_mesos_candidate=price)])))
                repo.ingest(path)
            recent=repo.report();all_data=repo.report(None)
            self.assertEqual(recent['hours'],72)
            self.assertEqual(recent['active_shops'],1)
            self.assertEqual(all_data['active_shops'],2)
            self.assertEqual(sorted(r['unit_price'] for r in all_data['products'][0]['quotes']),[100,250])
    def test_history_dedup_latest_and_sold_out_inference(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); repo=Repository(root,root/'absent.sqlite'); now=time.time()
            def add(n,stock,items=True,experimental=False,price=100):
                d=dict(session='s',time=now+n,title='pig',shop_id=1,host='h',port=8501,
                       triggered_by_python=experimental,prices_require_screen_validation=True,
                       items=[dict(item_id=4000008,slot=1,available_quantity_candidate=stock,
                       bundle_quantity_candidate=2,price_mesos_candidate=price)] if items else [])
                p=root/f'shop{n}.json';p.write_text(json.dumps(d));repo.ingest(p);repo.ingest(p)
            add(-50,10);add(-40,10)
            report=repo.report();self.assertEqual(report['visits'],2)
            self.assertEqual(report['items'][0]['listings'],1)
            self.assertEqual(report['items'][0]['low'],50)
            self.assertEqual(len(report['products']),1)
            self.assertEqual(report['products'][0]['listings'],1)
            add(-30,0,price=999)
            report=repo.report();self.assertEqual(len(report['sales']),1)
            self.assertEqual(report['sales'][0]['sale_price'],100)
            self.assertEqual(report['items'],[])
            self.assertEqual(report['products'][0]['low'],None)
            self.assertEqual(report['products'][0]['sold_out_median'],50)
            add(-20,0);self.assertEqual(len(repo.report()['sales']),1)
            add(-10,8,experimental=True);self.assertEqual(repo.report()['items'],[])
            add(-5,0,items=False);self.assertEqual(len(repo.report()['sales']),1)
            self.assertEqual(repo.report()['observations'],5)

    def test_missing_listing_does_not_infer_sale(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo=Repository(Path(tmp),Path(tmp)/'absent');now=time.time()
            for n,items in enumerate(([dict(item_id=4000008,slot=1,available_quantity_candidate=5,
                bundle_quantity_candidate=1,price_mesos_candidate=10)],[])):
                p=Path(tmp)/f'{n}.json';p.write_text(json.dumps(dict(session='s',time=now-10+n,title='s',shop_id=1,items=items)))
                repo.ingest(p)
            self.assertEqual(repo.report()['sales'],[])
            self.assertEqual(repo.report()['items'],[])

    def test_equipment_variants_share_one_product(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo=Repository(Path(tmp),Path(tmp)/'absent')
            items=[dict(item_id=1002011,slot=i,available_quantity_candidate=1,
                        bundle_quantity_candidate=1,price_mesos_candidate=100*i,
                        raw_record_hex=('00'*20+f'{i:02x}')) for i in (1,2)]
            path=Path(tmp)/'visit.json'
            path.write_text(json.dumps(dict(session='s',time=time.time(),title='hats',shop_id=1,items=items)))
            repo.ingest(path);report=repo.report()
            self.assertEqual(len(report['items']),2)
            self.assertEqual(len(report['products']),1)
            self.assertEqual(report['products'][0]['median'],150)
            self.assertEqual(len(report['products'][0]['variants']),2)


if __name__=='__main__': unittest.main()
