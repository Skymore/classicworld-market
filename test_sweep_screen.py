import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from sweep_purchase import PurchaseHalt, PurchaseOrder, PurchaseResult
from sweep_purchaser_windows import WindowsPurchaser
from sweep_screen import Reader, Row, money


class ScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reader = Reader()

    def test_raw_display_order_and_ambiguous_duplicate_pages(self):
        ids = [2000001, 2000003, 2000002, 4000017, 4000013, 4000019, 2010000, 2000000]
        ordered = [dict(item_id=iid, bundle=1, price=100+i) for i, iid in enumerate(ids)]
        page = [Row(self.reader.names[r['item_id']], r['bundle'], r['price'], True, False) for r in ordered[2:]]
        self.assertEqual(self.reader.offset(page, ordered), 2)
        partially_readable = [page[0], None, None, None, None, page[5]]
        self.assertEqual(self.reader.offset(partially_readable, ordered), 2)
        self.assertIsNone(self.reader.offset([page[0], None, None, None, None, None], ordered))
        self.assertIsNone(self.reader.offset(page, sorted(ordered, key=lambda r:r['item_id'])))
        row = dict(item_id=2000001, bundle=1, price=100)
        same = [Row('Orange Potion', 1, 100, True, False)]*6
        self.assertIsNone(self.reader.offset(same, [row]*9))
        self.assertFalse(self.reader.row_matches(replace(same[0], price=1000), row))
        self.assertFalse(self.reader.row_matches(replace(same[0], name='Orange...'), row, complete=True))

    def test_dialog_exact_digits_and_corruption(self):
        r = self.reader
        for amount in (22, 110, 198, 299, 14000, 27907):
            image = np.zeros((768,1366,3),dtype=np.uint8)
            for name,x,y in [('confirm-prompt',611,369),('cancel',763,414)]:
                t=r.templates[name];image[y:y+t.shape[0],x:x+t.shape[1]]=t
            x=590
            glyphs=dict(r.dialog_font.glyphs)
            for ch in f'Thetotalpriceis{amount:,}mesos.':
                glyph=glyphs[ch];mask=np.array([[p=='#' for p in row] for row in glyph])
                image[353:367,x:x+len(glyph[0])][mask]=255
                x+=len(glyph[0])+1
            self.assertEqual(r.dialog(image), ('confirm', amount))
            image[354,570]=255
            self.assertEqual(r.dialog(image), ('confirm', None))

    def test_money_never_drops_a_digit_or_malformed_separator(self):
        self.assertEqual(money('463,895'),463895)
        for text in ('463,89','463?895','46 3895','',None,'00100'):
            self.assertIsNone(money(text))

    def test_long_touching_shop_title_is_read_in_full(self):
        font = self.reader.font
        glyph = dict(font.glyphs)['y']
        rows = tuple(row*12 for row in glyph)
        self.assertEqual(font.split(rows), 'y'*12)
        self.assertIsNone(font.split(tuple(row*110 for row in glyph)))

    def test_rechargeable_ammo_anchors_use_set_price_not_charge_count(self):
        packet=dict(item_id=2070009,bundle=1,price=122222)
        visible=Row('Wooden Top',800,122222,True,False)
        self.assertTrue(self.reader.row_matches(visible,packet))
        self.assertFalse(self.reader.row_matches(visible,packet,complete=True))
        self.assertFalse(self.reader.row_matches(replace(visible,price=12222),packet))

    def test_scrolled_page_with_uncatalogued_cash_item(self):
        ids = [1082063,1302010,1402005]+[2000001]*5+[2040707,2040706,2040302,1107052]
        prices = [40000,9000,12000]+[140]*5+[20000,5000,12000,70000]
        ordered = [dict(item_id=i,bundle=1,price=p) for i,p in zip(ids,prices)]
        page = [Row(self.reader.names.get(r['item_id'],'Coffin of Gloom'),1,r['price'],True,False)
                for r in ordered[6:]]
        self.assertEqual(self.reader.offset(page,ordered),6)
        self.assertFalse(self.reader.row_matches(page[-1],ordered[-1],complete=True))
        page[-1] = replace(page[-1],price=7000)
        self.assertIsNone(self.reader.offset(page,ordered))
        unknown = [dict(item_id=1107052,bundle=1,price=70000)]*6
        self.assertIsNone(self.reader.offset([Row('Coffin of Gloom',1,70000,True,False)]*6,unknown))

    def test_quantity_readback_includes_zeroes_and_multiple_digits(self):
        r=self.reader
        for amount in (1,20,100,193,200,9999):
            image=np.full((768,1366,3),255,dtype=np.uint8)
            for name,x,y in [('quantity-prompt',566,347),('quantity-cancel',763,416)]:
                t=r.templates[name];image[y:y+t.shape[0],x:x+t.shape[1]]=t
            x=571;glyphs=dict(r.input_font.glyphs)
            for ch in str(amount):
                glyph=glyphs[ch];mask=np.array([[p=='#' for p in row] for row in glyph])
                image[373:385,x:x+len(glyph[0])][mask]=0
                x+=len(glyph[0])+1
            self.assertEqual(r.dialog(image),('quantity',amount))


class ScriptedReader:
    def __init__(self, frames):
        self.frames=frames

    def frame(self,image):return self.frames[int(image[0,0,0])]
    def dialog(self,image):
        f=self.frame(image)
        return (f['kind'],f.get('number',1)) if f['kind'] in ('quantity','confirm') else (None,None)
    def shop(self,image):return self.frame(image)['kind']=='shop'
    def title(self,image):return 'Potions'
    def page(self,image):return self.frame(image)
    def offset(self,page,ordered):return page.get('offset',2)
    def row_matches(self,*args,**kwargs):return True
    def balance(self,image):return self.frame(image).get('balance',1000)


class Page(dict):
    def __getitem__(self,key):
        if isinstance(key,int):return Row('Orange Potion',1,135,True,self.get('selected',False))
        return super().__getitem__(key)


class ScriptedInput:
    def __init__(self,frames,advance=True):
        self.frames=frames;self.index=0;self.actions=[];self.advance=advance
    def move(self):pass
    def capture(self):
        image=np.zeros((768,1366,3),dtype=np.uint8);image[0,0,0]=self.index
        if self.frames[self.index].get('stock_changed'):image[530:542,428:461]=1
        return image
    def click(self,x,y):
        self.actions.append((x,y))
        if self.advance:self.index=min(self.index+1,len(self.frames)-1)
    def quantity(self,value,allowed):
        assert allowed();self.actions.append(('quantity',value));self.index+=1


class NativeFlowTests(unittest.TestCase):
    def setUp(self):
        self.now=0
        self.order=PurchaseOrder('r1',2000001,'Orange Potion',2,19,135,1,1,None,
                                 42,'Seller',10,21,20,lambda:True)
        self.frames=[Page(kind='shop',offset=0),Page(kind='shop',offset=1),Page(kind='shop',offset=2),
                     Page(kind='shop',selected=True),Page(kind='quantity'),Page(kind='quantity'),
                     Page(kind='confirm',number=135),Page(kind='shop',selected=True,balance=865,stock_changed=True)]

    def run_buy(self,frames=None,order=None):
        frames=frames or self.frames
        self.control=ScriptedInput(frames)
        def pause(seconds):self.now+=seconds
        window=SimpleNamespace(capture_file='visit.json',pause=pause)
        buyer=WindowsPurchaser(ScriptedReader(frames),lambda window:self.control,lambda:self.now)
        with patch('sweep_purchaser_windows.ordered_snapshot',return_value=('Potions',[{'stock':200}]*8,7)):
            return buyer.buy(order or self.order,window)

    def test_scroll_twice_realign_select_and_buy_exactly_once(self):
        self.assertEqual(self.run_buy(),PurchaseResult('bought',1,135))
        self.assertEqual(self.control.actions,[(638,537),(638,537),(535,521),(604,252),
                                              ('quantity',1),(735,423),(735,421)])

    def test_other_buyers_stock_change_is_not_our_receipt(self):
        self.frames[-1]['balance']=1000
        with self.assertRaises(PurchaseHalt) as caught:self.run_buy()
        self.assertEqual(caught.exception.result.status,'unknown')
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_price_change_cancels_without_final_purchase(self):
        self.frames[-2]['number']=1350
        self.frames[-1]['balance']=1000
        self.assertEqual(self.run_buy(),PurchaseResult('not_bought',reason='price_changed'))
        self.assertNotIn((735,421),self.control.actions)
        self.assertEqual(self.control.actions[-1],(783,421))

    def test_fresh_balance_respects_reserved_mesos(self):
        self.assertEqual(self.run_buy(order=replace(self.order,reserve_mesos=900)),
                         PurchaseResult('not_bought',reason='not_enough_mesos'))
        self.assertNotIn((604,252),self.control.actions)

    def test_stop_during_scroll_sends_no_more_input(self):
        order=replace(self.order,can_buy=lambda:self.now<.1)
        self.assertEqual(self.run_buy(order=order),PurchaseResult('not_bought',reason='stopped'))
        self.assertEqual(self.control.actions,[(638,537)])

    def test_scroll_then_buy_many_bundles_with_exact_debit(self):
        for count in (20,100,193):
            with self.subTest(count=count):
                self.setUp()
                for frame in self.frames:frame['balance']=50000
                self.frames[5]['number']=count
                self.frames[-2]['number']=135*count
                self.frames[-1]['balance']=50000-135*count
                self.assertEqual(self.run_buy(order=replace(self.order,quantity=count)),
                                 PurchaseResult('bought',count,135*count))
                self.assertIn(('quantity',count),self.control.actions)
                self.assertEqual(self.control.actions.count((735,421)),1)

    def test_partial_debit_cannot_settle_full_batch(self):
        self.frames[5]['number']=3
        self.frames[-2]['number']=405
        with self.assertRaises(PurchaseHalt) as caught:self.run_buy(order=replace(self.order,quantity=3))
        self.assertEqual(caught.exception.result.status,'unknown')
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_invalid_quantity_does_not_input(self):
        for count in (0,-1,True,1.0,10000):
            self.assertEqual(self.run_buy(order=replace(self.order,quantity=count)),PurchaseResult('not_bought',reason='error'))
            self.assertEqual(self.control.actions,[])

    def test_rechargeable_ammo_is_not_a_native_beta_buy_target(self):
        self.assertEqual(self.run_buy(order=replace(self.order,item_id=2070009)),
                         PurchaseResult('not_bought',reason='error'))
        self.assertEqual(self.control.actions,[])


if __name__=='__main__':unittest.main()
