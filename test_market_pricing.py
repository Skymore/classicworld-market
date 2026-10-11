import unittest
from market_pricing import recommend


class PricingTests(unittest.TestCase):
    def product(self,values):
        return dict(category='其他',quotes=[dict(unit_price=v,shop_key=str(i),requires_validation=True) for i,v in enumerate(values)])

    def test_equipment_is_not_given_mixed_price(self):
        p=self.product([100,200]);p['category']='装备'
        self.assertIsNone(recommend(p)['price'])

    def test_outliers_removed_and_does_not_chase_minimum(self):
        r=recommend(self.product([1,100,110,120,130,140,10000]))
        self.assertEqual(r['excluded_outliers'],2)
        self.assertTrue(110<=r['price']<=130)

    def test_duplicate_shop_does_not_change_weight(self):
        p=self.product([100,200,300]);base=recommend(p)['price']
        p['quotes'] += [dict(p['quotes'][0]) for _ in range(50)]
        self.assertEqual(recommend(p)['price'],base)

    def test_no_sample_and_fractional_prices(self):
        self.assertIsNone(recommend(self.product([]))['price'])
        self.assertEqual(recommend(self.product([.4]))['price'],.4)
        self.assertEqual(recommend(self.product([100]))['confidence'],'样本少')


if __name__=='__main__':unittest.main()
