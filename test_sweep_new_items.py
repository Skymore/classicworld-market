"""New client cosmetics must not hide verified consumables later in a shop."""
from dataclasses import replace
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sweep_purchase import PurchaseOrder, PurchaseResult
from sweep_purchaser_windows import WindowsPurchaser
from sweep_screen import Reader, Row
from test_sweep_screen import Page, ScriptedInput, ScriptedReader


class NewItemTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader()
        self.ids = [1017088,1107063,1107063,1112227,1077125,1077139]
        prices = [200000,65000,65000,1666666,65000,50000]
        self.ordered = [dict(item_id=i,bundle=1,price=p,stock=1) for i,p in zip(self.ids,prices)]
        self.ordered += [dict(item_id=2000001,bundle=1,price=135,stock=6)]*6
        self.page = [Row(self.reader.names[r['item_id']],1,r['price'],True,False) for r in self.ordered[:6]]

    def forget_new_items(self):
        for item in self.ids:
            if item != 1112227:
                self.reader.names.pop(item, None)

    def test_current_client_names_restore_the_reported_shop_alignment(self):
        self.assertEqual(self.reader.names[1017088], 'Ice Cold Red')
        self.assertEqual(self.reader.names[1107063], 'Tania Cloak')
        self.assertEqual(self.reader.offset(self.page,self.ordered),0)

    def test_future_items_allow_navigation_but_never_unknown_target_identity(self):
        self.forget_new_items()
        self.assertIsNone(self.reader.offset(self.page,self.ordered))
        self.assertEqual(self.reader.navigation_offsets(self.page,self.ordered),[0])
        self.assertIsNone(self.reader.equivalent_row(self.page,self.ordered,0,1))
        self.assertFalse(self.reader.row_matches(self.page[0],self.ordered[0],complete=True))
        for field, value in [('price',200001),('bundle',2)]:
            corrupted = [replace(self.page[0],**{field:value})]+self.page[1:]
            self.assertEqual(self.reader.navigation_offsets(corrupted,self.ordered),[])
        self.assertEqual(self.reader.navigation_offsets([None]+self.page[1:],self.ordered),[])

    def test_known_consumable_is_verifiable_among_unknown_cosmetics(self):
        self.forget_new_items()
        self.ordered[3]=self.ordered[-1]
        self.page[3]=Row('Orange Potion',1,135,True,False)
        self.assertIsNone(self.reader.offset(self.page,self.ordered))
        self.assertEqual(self.reader.equivalent_row(self.page,self.ordered,3,6),(3,6))
        self.assertIsNone(self.reader.equivalent_row(self.page,self.ordered,3,7))
        self.page[3]=replace(self.page[3],name='Unknown Potion')
        self.assertIsNone(self.reader.equivalent_row(self.page,self.ordered,3,6))

    def run_buy(self, stuck=False, ambiguous=False, target=6):
        self.forget_new_items()
        reader, ordered, first = self.reader, self.ordered, self.page
        if ambiguous:
            ordered = ordered+ordered
        frames=[Page(kind='shop',offset=0),Page(kind='shop',offset=6),
                Page(kind='shop',offset=6,selected=True),Page(kind='quantity'),
                Page(kind='quantity'),Page(kind='confirm',number=135),
                Page(kind='shop',offset=6,selected=True,balance=865)]
        class ActualReader(ScriptedReader):
            names=reader.names
            def page(self,image):
                frame=self.frame(image)
                if frame.get('offset')==0:return first
                return [Row('Orange Potion',1,135,True,bool(frame.get('selected')) and i==0) for i in range(6)]
            def offset(self,page,rows):return reader.offset(page,rows)
            def equivalent_row(self,*args):return reader.equivalent_row(*args)
            def navigation_offsets(self,*args):return reader.navigation_offsets(*args)
            def row_matches(self,*args,**kwargs):return reader.row_matches(*args,**kwargs)
        control=ScriptedInput(frames,advance=not stuck)
        now=0
        def pause(seconds):
            nonlocal now
            now+=seconds
        def inventory():
            done=control.index==len(frames)-1
            return dict(session='s',revision=2 if done else 1,mesos=865 if done else 1000,
                        categories=[2],items=[dict(item_id=2000001,quantity=11 if done else 10)])
        order=PurchaseOrder('r',2000001,'Orange Potion',2,19,135,1,1,None,
                            42,'Seller',10,21,20,lambda:True,inventory=inventory)
        buyer=WindowsPurchaser(ActualReader(frames),lambda window:control,lambda:now)
        with patch('sweep_purchaser_windows.ordered_snapshot',return_value=('Potions',ordered,target)):
            result=buyer.buy(order,SimpleNamespace(capture_file='visit.json',pause=pause))
        return result,control.actions

    def test_future_cosmetics_scroll_then_verify_and_pay_once(self):
        result,actions=self.run_buy()
        self.assertEqual(result,PurchaseResult('bought',1,135))
        self.assertEqual(actions,[(638,537),(535,321),(604,252),('quantity',1),(735,423),(735,421)])

    def test_unchanged_page_is_bounded_and_never_buys(self):
        result,actions=self.run_buy(stuck=True)
        self.assertEqual(result.status,'not_bought')
        self.assertEqual(actions,[(638,537),(638,537)])

    def test_conflicting_navigation_offsets_do_not_guess_direction(self):
        result,actions=self.run_buy(ambiguous=True)
        self.assertEqual(result,PurchaseResult('not_bought',reason='listing_unverified'))
        self.assertEqual(actions,[])

    def test_unknown_target_on_current_page_is_skipped_without_input(self):
        result,actions=self.run_buy(target=0)
        self.assertEqual(result,PurchaseResult('not_bought',reason='listing_unverified'))
        self.assertEqual(actions,[])


if __name__=='__main__':
    unittest.main()
