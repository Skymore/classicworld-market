import unittest
from market_pricing import recommend


class PricingTests(unittest.TestCase):
    def product(self,values):
        return dict(category='其他',quotes=[dict(unit_price=v,shop_key=str(i),requires_validation=True) for i,v in enumerate(values)])

    def test_equipment_is_not_given_mixed_price(self):
        p=self.product([100,200]);p['category']='装备'
        self.assertIsNone(recommend(p)['price'])

    def test_normal_equipment_excludes_scrolled_and_unknown(self):
        p=self.product([20000,21000,450000,1]);p['category']='装备'
        for r in p['quotes'][:2]:r['equipment']=dict(enhancements=0,remaining_upgrades=7)
        p['quotes'][2]['equipment']=dict(enhancements=4,remaining_upgrades=0)
        result=recommend(p)
        self.assertEqual(result['shop_count'],2)
        self.assertEqual(result['price'],19999)
        self.assertEqual(result['label'],'普通属性建议价')

    def test_recommended_integer_prices_end_in_nine(self):
        for value in (9,10,99,100,499,1000,450000):
            self.assertEqual(recommend(self.product([value]))['price']%10,9)

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
        self.assertEqual(recommend(self.product([.4]))['price'],.39)
        self.assertEqual(recommend(self.product([100]))['confidence'],'样本少')


if __name__=='__main__':unittest.main()
