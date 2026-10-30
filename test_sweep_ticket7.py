"""Sanitized row observations from ticket 7; no account captures are bundled."""
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from sweep_screen import Reader, Row
from sweep_purchaser_windows import WindowsPurchaser
from sweep_purchase import PurchaseResult
from test_sweep_screen import ScriptedReader, ScriptedInput, Page
import test_sweep_screen as fixtures

IDS = [1472010,1442004,1092003,1082002,1002117,1040021,2040518,2040706,2044202,2000002,1061066,1041040]
PRICES = [58999,10000,3200,1999,1900,2700,14999,4500,3000,280,7000,2999]
ORDERED = [dict(item_id=i,price=p,bundle=1,stock=75 if i==2000002 else 1) for i,p in zip(IDS,PRICES)]
NAMES = ['', 'Shoes Speed Scroll: Gre...', 'Two-handed Blunt Weap...', 'White Potion', 'Red Shadow Pants', 'Green Bennis Chainmail']

def page(selected=False):
    return [Row(n,1,p,i!=1,selected and i==3) for i,(n,p) in enumerate(zip(NAMES,PRICES[6:]))]

class Ticket7Tests(unittest.TestCase):
    def test_real_row_observations_align_after_scroll(self):
        r=Reader()
        self.assertEqual(r.offset(page(),ORDERED),6)
        self.assertTrue(r.row_matches(page()[3],ORDERED[9],complete=True))
        self.assertFalse(r.row_matches(page()[5],ORDERED[11],complete=True))
        for changed in (replace(page()[3],name='Orange Potion'),replace(page()[3],price=281),replace(page()[3],bundle=2)):
            rows=page();rows[3]=changed
            self.assertIsNone(r.offset(rows,ORDERED))
            self.assertFalse(r.row_matches(changed,ORDERED[9],complete=True))
        rows=page();rows[5]=replace(rows[5],name='Blue Bennis Chainmail')
        self.assertIsNone(r.offset(rows,ORDERED))
        details=r.alignment_details(rows,ORDERED)
        self.assertEqual(details['closest'][0]['offset'],6)
        self.assertEqual(details['closest'][0]['checks'][5]['failed'],['name'])

    def test_scroll_then_purchase_and_insufficient_stock(self):
        r=Reader()
        class ReplayReader(ScriptedReader):
            names=r.names
            def page(self,image):
                if self.frame(image).get('first'):
                    return [Row(r.names[v['item_id']],1,v['price'],True,False) for v in ORDERED[:6]]
                return page(self.frame(image).get('selected',False))
            offset=staticmethod(r.offset)
            row_matches=staticmethod(r.row_matches)
        for stock in (75,0):
            frames=[Page(kind='shop',first=True),Page(kind='shop'),Page(kind='shop',selected=True),
                    Page(kind='quantity',number=None),Page(kind='quantity',number=1),
                    Page(kind='confirm',number=280),Page(kind='shop',selected=True)]
            control=ScriptedInput(frames);now=[0.0]
            def pause(seconds):now[0]+=seconds
            fixture=fixtures.NativeFlowTests();fixture.setUp()
            order=replace(fixture.order,item_id=2000002,price=280,visit_current=lambda:True)
            ordered=[dict(v) for v in ORDERED];ordered[9]['stock']=stock
            buyer=WindowsPurchaser(ReplayReader(frames),lambda _:control,lambda:now[0])
            def inventory(_):return ('stream',2,720,1) if control.index>=6 else ('stream',1,1000,0)
            with patch('sweep_purchaser_windows.ordered_snapshot',return_value=('fixture',ordered,9)), patch('sweep_purchaser_windows.inventory_position',side_effect=inventory):
                result=buyer.buy(order,SimpleNamespace(capture_file='fixture.json',pause=pause))
            self.assertIn((638,537),control.actions)
            if stock:
                self.assertEqual(result,PurchaseResult('bought',1,280))
                self.assertEqual(control.actions.count((735,421)),1)
            else:
                self.assertEqual(result.status,'not_bought')
                self.assertNotIn((604,252),control.actions)

if __name__=='__main__':unittest.main()
