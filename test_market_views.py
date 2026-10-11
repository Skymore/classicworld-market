import unittest
from market_views import opportunities, view

class OpportunityTests(unittest.TestCase):
    def fixture(self):
        quotes=[dict(shop_key=str(i),unit_price=100,time=900,collector='other',stock=10,bundle=1) for i in range(8)]
        quotes.append(dict(shop_key='current',unit_price=50,time=999,collector='local',slot=1,item_id=4000000,
                           shop='test',location={'channel':1,'room':1},bundle=10,price=500,stock=2))
        sales=[dict(shop_key=str(i),previous_time=800,time=950) for i in range(5)]
        return dict(products=[dict(category='其他',item_id=4000000,name_zh='测试',quotes=quotes,sales=sales,variants=['standard'])],history=[])

    def test_low_price_requires_supply_and_fee_margin(self):
        data=self.fixture();a=opportunities(data,1000)
        self.assertEqual(len(a),1);self.assertEqual(a[0]['q1'],100)
        self.assertEqual(a[0]['sell'],99);self.assertEqual(a[0]['profit'],46.03)
        data['products'][0]['quotes'][-1]['unit_price']=90
        self.assertEqual(opportunities(data,1000),[])

    def test_no_sales_required_and_current_shop_excluded_from_supply(self):
        data=self.fixture();data['products'][0]['sales']=[]
        result=opportunities(data,1000)[0]
        self.assertEqual(result['shops'],8)
        self.assertEqual(result['listing_count'],8)
        self.assertEqual(result['listed_quantity'],80)
        del data['products'][0]['sales']
        self.assertEqual(opportunities(data,1000)[0],result)

    def test_stale_shared_equipment_and_few_shops_do_not_alert(self):
        for key,value in [('collector','other'),('time',700)]:
            data=self.fixture();data['products'][0]['quotes'][-1][key]=value
            self.assertEqual(opportunities(data,1000),[])
        data=self.fixture();data['products'][0]['category']='装备'
        self.assertEqual(opportunities(data,1000),[])
        data=self.fixture();data['products'][0]['quotes'].pop(0)
        self.assertEqual(opportunities(data,1000),[])

    def test_normal_profit_alone_does_not_trigger(self):
        data=self.fixture()
        for sale in data['products'][0]['sales']:sale['sale_unit_price']=60
        self.assertEqual(opportunities(data,1000),[])

    def test_summary_drops_bulk_and_detail_is_scoped(self):
        data=self.fixture();data['history']=[dict(item_id=4000000),dict(item_id=1)]
        result=view(data,summary=True)
        self.assertNotIn('history',result);self.assertNotIn('quotes',result['products'][0])
        self.assertEqual(result['products'][0]['variant_count'],1)
        self.assertEqual(len(view(data,item_id=4000000)['history']),1)

if __name__=='__main__':unittest.main()
