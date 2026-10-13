import unittest
from market_selling import catalog, listing_proposal


class SellingTests(unittest.TestCase):
    def product(self):
        return dict(item_id=4000000, world='CW', name_zh='材料', category='其他', quotes=[
            dict(shop_key=f's{i}', time=990, unit_price=p, requires_validation=False,
                 location=dict(channel=1,room=7)) for i,p in enumerate((100,200,300))])

    def test_presets_use_distinct_shops_and_exclude_stale_quotes(self):
        product=self.product()
        product['quotes'] += [dict(product['quotes'][0])]*50
        product['quotes'].append(dict(shop_key='old', time=1, unit_price=1))
        result=catalog(dict(products=[product]),now=1000,max_age=100)
        self.assertEqual(result['items'][0]['median'],200)
        self.assertEqual(result['items'][0]['shops'],3)
        self.assertEqual(result['venues'][0]['shops'],3)
        self.assertEqual(len(result['presets'][0]['items']),1)
        self.assertEqual(result['venues'][0]['vacancy'],'unknown')

    def test_recent_supply_ranks_above_old_supply(self):
        product=self.product()
        product['quotes'].append(dict(shop_key='old',time=100,unit_price=100,
                                     location=dict(channel=2,room=1)))
        result=catalog(dict(products=[product]),now=1000)
        self.assertEqual(result['venues'][0]['channel'],1)

    def test_price_floor_bundle_rounding_reserve_and_world(self):
        item=catalog(dict(products=[self.product()]),now=1000)['items'][0]
        bag=dict(world='CW',item_id=4000000,quantity=100,reserve=10,bundle=3,groups=30,
                 minimum_unit_price=200.5)
        proposal=listing_proposal(item,bag,'median')
        self.assertEqual(proposal['bundle_price'],602)
        self.assertFalse(proposal['execution_ready'])
        with self.assertRaises(ValueError):listing_proposal(item,dict(bag,groups=31))
        with self.assertRaises(ValueError):listing_proposal(item,dict(bag,world='other'))
        with self.assertRaises(ValueError):listing_proposal(item,dict(bag,minimum_unit_price=None))

    def test_no_sample_and_equipment_do_not_auto_price(self):
        product=self.product()
        product['quotes']=[]
        self.assertEqual(catalog(dict(products=[product]),now=1000)['presets'][0]['items'],[])
        item=catalog(dict(products=[self.product()]),now=1000)['items'][0]
        bag=dict(world='CW',item_id=4000000,quantity=1,reserve=0,bundle=1,groups=1,minimum_unit_price=1)
        with self.assertRaises(ValueError):listing_proposal(dict(item,automatic_pricing_supported=False),bag)
        with self.assertRaises(ValueError):listing_proposal(dict(item,shops=2),bag)


if __name__=='__main__':unittest.main()
