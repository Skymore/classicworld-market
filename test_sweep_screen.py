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

    def test_text_cache_uses_exact_pixels_and_colour_mode(self):
        reader = Reader()
        image = np.full((768,1366,3),255,dtype=np.uint8)
        def paint(value):
            image[311:324,400:460] = 255
            x = 402
            for ch in value:
                glyph = dict(reader.font.glyphs)[ch]
                mask = np.array([[p == '#' for p in row] for row in glyph])
                image[311:324,x:x+len(glyph[0])][mask] = 0
                x += len(glyph[0])+1
        paint('135')
        self.assertEqual(reader.line(image,400,460,320),'135')
        for _ in range(5):self.assertEqual(reader.line(image,400,460,320),'135')
        self.assertEqual(reader._cached_line.cache_info().misses,1)
        paint('139')
        self.assertEqual(reader.line(image,400,460,320),'139')
        self.assertEqual(reader._cached_line.cache_info().misses,2)
        reader.line(image,400,460,320,grey=True)
        self.assertEqual(reader._cached_line.cache_info().misses,3)

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

    def test_partial_last_page_including_sold_out_white_potion(self):
        ids = [1002082,1002082,1061039,1032005,1072031,2022003,2000001,2040502,2000002,4003000]
        prices = [1799,1599,1777,3799,1300,480,140,888,280,165]
        ordered = [dict(item_id=i,bundle=1,price=p) for i,p in zip(ids,prices)]
        for offset in range(5,10):
            page = [Row(self.reader.names[r['item_id']],1,r['price'],r['item_id']!=2000002,False)
                    for r in ordered[offset:]]
            page += [None]*(6-len(page))
            self.assertEqual(self.reader.offset(page,ordered),offset)
            corrupted = list(page)
            corrupted[0] = replace(corrupted[0],price=999999)
            self.assertIsNone(self.reader.offset(corrupted,ordered))
        repeated = [dict(item_id=2000001,bundle=1,price=140)]*10
        self.assertIsNone(self.reader.offset([Row('Orange Potion',1,140,True,False)]*4+[None]*2,repeated))

    def test_money_never_drops_a_digit_or_malformed_separator(self):
        self.assertEqual(money('463,895'),463895)
        for text in ('463,89','463?895','46 3895','',None,'00100'):
            self.assertIsNone(money(text))

    def test_exact_room_missing_rejection_and_changed_dialog(self):
        image = np.zeros((768,1366,3),dtype=np.uint8)
        template = self.reader.templates['room-missing']
        image[345:345+template.shape[0],557:557+template.shape[1]] = template
        self.assertEqual(self.reader.dialog(image), ('rejected', 'shop_closed'))
        image[360,620] = 0
        self.assertEqual(self.reader.dialog(image), (None, None))

    def test_long_touching_shop_title_is_read_in_full(self):
        font = self.reader.font
        glyph = dict(font.glyphs)['y']
        rows = tuple(row*12 for row in glyph)
        self.assertEqual(font.split(rows), 'y'*12)
        self.assertIsNone(font.split(tuple(row*110 for row in glyph)))

    def test_equips_shop_title_capital_q_from_live_skip(self):
        # Exact glyph observed in a skipped shop, with the title independently
        # confirmed by its fresh packet. No account/shop screenshot is stored.
        rows = ('.......', '..###..', '.#...#.', '#.....#', '#.....#',
                '#.....#', '#.....#', '#..##.#', '.#...#.', '..###.#',
                '.......', '.......', '.......')
        self.assertEqual(self.reader.font.split(rows), 'Q')
        image = np.full((768, 1366, 3), 255, dtype=np.uint8)
        x = 442
        glyphs = dict(self.reader.font.glyphs)
        title = 'CHEAP CHEAP EQUIPS N POTS'
        for ch in title:
            if ch == ' ':
                x += 4
                continue
            glyph = rows if ch == 'Q' else glyphs['l' if ch == 'I' else ch]
            mask = np.array([[p == '#' for p in row] for row in glyph])
            image[161:174, x:x+len(glyph[0])][mask] = 0
            x += len(glyph[0])+1
        self.assertEqual(self.reader.title(image).replace('l', 'I'), title)
        image[161, 441] = 0
        self.assertIsNone(self.reader.title(image))

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
        if f['kind']=='rejected':return 'rejected', f['reason']
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

    def test_expired_quantity_dialog_is_cancelled_and_shop_is_restored(self):
        frames = [Page(kind='shop'), Page(kind='shop',selected=True),
                  Page(kind='quantity'), Page(kind='quantity',number=None), Page(kind='shop')]
        class Input(ScriptedInput):
            def click(self,x,y):
                self.actions.append((x,y))
                self.index = 4 if (x,y)==(783,423) else self.index+1
        control=Input(frames)
        def pause(seconds):self.now+=.5
        window=SimpleNamespace(capture_file='visit.json',pause=pause)
        buyer=WindowsPurchaser(ScriptedReader(frames),lambda window:control,lambda:self.now)
        with patch('sweep_purchaser_windows.ordered_snapshot',return_value=('Potions',[{'stock':200}]*8,7)):
            self.assertEqual(buyer.buy(replace(self.order,deadline=2.5),window),
                             PurchaseResult('not_bought',reason='timeout'))
        self.assertEqual(control.actions,[(535,521),(604,252),('quantity',1),(783,423)])

    def test_unreadable_shop_before_buy_is_skipped_without_input(self):
        with patch.object(ScriptedReader,'offset',return_value=None):
            self.assertEqual(self.run_buy(),PurchaseResult('not_bought',reason='listing_unverified'))
        self.assertEqual(self.control.actions,[])

    def test_real_alignment_buys_many_on_four_row_last_page(self):
        reader = Reader()
        ids = [1002082,1002082,1061039,1032005,1072031,2022003,2000001,2040502,2000002,4003000]
        prices = [1799,1599,1777,3799,1300,480,140,888,280,165]
        ordered = [dict(item_id=i,bundle=1,price=p,stock=15) for i,p in zip(ids,prices)]
        frames = [Page(kind='shop',offset=0,balance=10000),Page(kind='shop',offset=6,balance=10000),
                  Page(kind='shop',offset=6,selected=True,balance=10000),Page(kind='quantity'),
                  Page(kind='quantity',number=15),Page(kind='confirm',number=4200),
                  Page(kind='shop',offset=6,selected=True,balance=5800,stock_changed=True)]
        class ActualAlignment(ScriptedReader):
            names = reader.names
            def page(self,image):
                frame=self.frame(image); offset=frame.get('offset',6)
                page=[Row(reader.names[r['item_id']],1,r['price'],True,
                          bool(frame.get('selected')) and offset+i==8)
                      for i,r in enumerate(ordered[offset:offset+6])]
                return page+[None]*(6-len(page))
            def offset(self,page,rows):return reader.offset(page,rows)
            def row_matches(self,*args,**kwargs):return reader.row_matches(*args,**kwargs)
        class Input(ScriptedInput):
            def capture(self):
                image=super().capture()
                if self.frames[self.index].get('stock_changed'):image[410:422,428:461]=1
                return image
        control=Input(frames)
        window=SimpleNamespace(capture_file='visit.json',pause=lambda seconds:None)
        order=replace(self.order,item_id=2000002,name='White Potion',price=280,quantity=15)
        buyer=WindowsPurchaser(ActualAlignment(frames),lambda window:control,lambda:0)
        with patch('sweep_purchaser_windows.ordered_snapshot',return_value=('Potions',ordered,8)):
            self.assertEqual(buyer.buy(order,window),PurchaseResult('bought',15,4200))
        self.assertEqual(control.actions,[(638,537),(535,401),(604,252),('quantity',15),(735,423),(735,421)])

    def test_transient_unreadable_scroll_frame_recovers(self):
        original = ScriptedReader.offset
        attempts = 0
        def offset(reader,page,ordered):
            nonlocal attempts
            attempts += 1
            return None if attempts <= 2 else original(reader,page,ordered)
        with patch.object(ScriptedReader,'offset',offset):
            self.assertEqual(self.run_buy(),PurchaseResult('bought',1,135))
        self.assertEqual(self.control.actions.count((735,421)),1)

    def packet_reader(self, after):
        def read():
            if self.control.index < len(self.frames)-1:
                return dict(session='stream',revision=4,mesos=1000,categories=[2],
                            items=[dict(item_id=2000001,quantity=10)])
            return after
        return read

    def test_packet_receipt_does_not_read_sold_out_glyphs_or_resubmit(self):
        after=dict(session='stream',revision=6,mesos=865,categories=[2],
                   items=[dict(item_id=2000001,quantity=11)])
        original=ScriptedReader.page
        def page(reader,image):
            if reader.frame(image).get('stock_changed'):
                raise AssertionError('Sold-out row must not need glyph matching')
            return original(reader,image)
        with patch.object(ScriptedReader,'page',page):
            self.assertEqual(self.run_buy(order=replace(self.order,inventory=self.packet_reader(after))),
                             PurchaseResult('bought',1,135))
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_packet_receipt_counts_units_in_multi_item_bundles(self):
        self.frames[5]['number']=3
        self.frames[-2]['number']=405
        after=dict(session='stream',revision=6,mesos=595,categories=[2],
                   items=[dict(item_id=2000001,quantity=25)])
        order=replace(self.order,quantity=3,bundle=5,inventory=self.packet_reader(after))
        self.assertEqual(self.run_buy(order=order),PurchaseResult('bought',3,405))
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_packet_receipt_needs_both_deltas_complete_bag_and_same_stream(self):
        cases=[dict(mesos=1000),dict(items=[dict(item_id=2000001,quantity=10)]),
               dict(items=[dict(item_id=2000001,quantity=12)]),dict(categories=[]),
               dict(session='reconnected'),dict(revision=4),dict(mesos=None)]
        for changed in cases:
            with self.subTest(changed=changed):
                self.setUp()
                after=dict(session='stream',revision=6,mesos=865,categories=[2],
                           items=[dict(item_id=2000001,quantity=11)])
                after.update(changed)
                with self.assertRaises(PurchaseHalt) as caught:
                    self.run_buy(order=replace(self.order,inventory=self.packet_reader(after)))
                self.assertEqual(caught.exception.result.status,'unknown')
                self.assertEqual(self.control.actions.count((735,421)),1)

    def test_packet_receipt_waits_for_separate_money_and_item_updates(self):
        complete=dict(session='stream',revision=6,mesos=865,categories=[2],
                      items=[dict(item_id=2000001,quantity=11)])
        reader=self.packet_reader(complete)
        calls=0
        def read():
            nonlocal calls
            value=reader()
            if value['revision']==6:
                calls+=1
                if calls==1:return dict(value,revision=5,items=[dict(item_id=2000001,quantity=10)])
            return value
        self.assertEqual(self.run_buy(order=replace(self.order,inventory=read)),PurchaseResult('bought',1,135))
        self.assertEqual(calls,2)
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_unreadable_after_confirmation_stops_without_retrying_purchase(self):
        original = ScriptedReader.offset
        def offset(reader,page,ordered):
            return None if page.get('stock_changed') else original(reader,page,ordered)
        with patch.object(ScriptedReader,'offset',offset):
            with self.assertRaises(PurchaseHalt) as caught:self.run_buy()
        self.assertEqual(caught.exception.result,PurchaseResult('unknown',reason='listing_unverified'))
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_other_buyers_stock_change_is_not_our_receipt(self):
        self.frames[-1]['balance']=1000
        with self.assertRaises(PurchaseHalt) as caught:self.run_buy()
        self.assertEqual(caught.exception.result.status,'unknown')
        self.assertEqual(self.control.actions.count((735,421)),1)

    def test_room_missing_is_dismissed_once_and_not_charged(self):
        self.frames[-1] = Page(kind='rejected', reason='shop_closed')
        self.frames.append(Page(kind='shop', selected=True, balance=1000))
        self.assertEqual(self.run_buy(), PurchaseResult('not_bought', reason='shop_closed'))
        self.assertEqual(self.control.actions.count((784,411)), 1)
        self.assertEqual(self.control.actions.count((735,421)), 1)

    def test_unknown_title_glyphs_keep_fresh_packet_and_row_checks(self):
        with patch.object(ScriptedReader, 'title', return_value=None):
            self.assertEqual(self.run_buy(), PurchaseResult('bought',1,135))

    def test_title_pixels_change_after_selection_stops_input(self):
        original = ScriptedInput.capture
        def capture(control):
            image = original(control)
            if control.index >= 3:image[161,450] = 255
            return image
        with patch.object(ScriptedInput, 'capture', capture):
            with self.assertRaises(PurchaseHalt) as caught:self.run_buy()
        self.assertEqual(caught.exception.result, PurchaseResult('not_bought',reason='shop_closed'))
        self.assertNotIn((604,252), self.control.actions)

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
