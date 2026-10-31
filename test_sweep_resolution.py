import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

from sweep_screen import Canvas, Reader
from sweep_purchaser_windows import WindowsInput, WindowsPurchaser
from inventory_check import InventoryCheckError
from sweep_purchase import PurchasePreparationSkipped, PurchaseHalt, PurchaseResult, purchase_halt_message


class ResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reader = Reader()

    def render(self, kind, amount, caret=False):
        r = self.reader
        quantity = kind == 'quantity'
        image = np.full((768, 1366, 3), 255 if quantity else 0, dtype=np.uint8)
        controls = ([('quantity-prompt', 566, 347), ('quantity-cancel', 763, 416)] if quantity
                    else [('confirm-prompt', 611, 369), ('cancel', 763, 414)])
        for name, x, y in controls:
            t = r.templates[name]
            image[y:y+t.shape[0], x:x+t.shape[1]] = t
        font = r.input_font if quantity else r.dialog_font
        x, top, bottom = (571, 373, 385) if quantity else (590, 353, 367)
        text = str(amount) if quantity else f'Thetotalpriceis{amount:,}mesos.'
        for ch in text:
            glyph = dict(font.glyphs)[ch]
            mask = np.array([[p == '#' for p in row] for row in glyph])
            image[top:bottom, x:x+len(glyph[0])][mask] = 0 if quantity else 255
            x += len(glyph[0])+1
        if caret:
            image[top:bottom-1, x:x+1] = 0
        return Image.fromarray(image)

    def test_quantity_with_blinking_caret_does_not_wait_forever(self):
        for size in ((1366,768), (1600,900), (1920,1080), (2560,1440)):
            for amount in (54, 100, 193, 200):
                for caret in (False, True):
                    with self.subTest(size=size, amount=amount, caret=caret):
                        frame = Canvas(*size).frame(self.render('quantity', amount, caret).resize(size, Image.Resampling.BILINEAR))
                        self.assertEqual(self.reader.dialog(frame), ('quantity', amount))

    def test_scaled_quantity_and_total_readback(self):
        for size in ((1366,768), (1600,900), (1920,1080), (2560,1440)):
            for kind, amount in (('quantity', 200), ('quantity', 193), ('confirm', 26000), ('confirm', 27907)):
                with self.subTest(size=size, kind=kind, amount=amount):
                    frame = Canvas(*size).frame(self.render(kind, amount).resize(size, Image.Resampling.BILINEAR))
                    self.assertEqual(self.reader.dialog(frame), (kind, amount))

    def test_lossy_downscale_never_guesses_the_amount(self):
        for amount in (26, 260, 2600, 26000, 27907):
            frame = Canvas(1280,720).frame(self.render('confirm', amount).resize((1280,720), Image.Resampling.BILINEAR))
            kind, actual = self.reader.dialog(frame)
            self.assertIn(actual, (None, amount))
            self.assertIn(kind, (None, 'confirm'))

    def test_mouse_actions_use_same_transform_as_capture(self):
        for size in ((1280,720), (1920,1080), (2560,1440)):
            control = object.__new__(WindowsInput)
            control.canvas = Canvas(*size)
            control.window = SimpleNamespace(click=Mock())
            control.check = Mock()
            control.move = Mock()
            for point in ((535,521), (638,537), (604,252), (735,423), (735,421), (783,421)):
                control.click(*point)
                control.window.click.assert_called_with(round(point[0]*size[0]/1366), round(point[1]*size[1]/768))

    def test_changed_dimensions_and_unverified_controls_fail_closed(self):
        with self.assertRaises(ValueError):
            Canvas(1920,1080).frame(np.zeros((768,1366,3), dtype=np.uint8))
        for size in ((1280,720), (1920,1080)):
            blank = Canvas(*size).frame(Image.new('RGB', size, 'white'))
            self.assertFalse(self.reader.shop(blank))
            self.assertEqual(self.reader.dialog(blank), (None,None))

    def test_unreadable_balance_in_verified_shop_skips_without_purchase(self):
        reader = Mock()
        reader.dialog.return_value = (None, None)
        reader.shop.return_value = True
        reader.balance.return_value = None
        control = Mock()
        self.assertFalse(WindowsPurchaser(reader, lambda window: control).prepare(object()))
        control.click.assert_not_called()
        control.quantity.assert_not_called()

    def native_frame(self, reference, size):
        frame=Image.new('RGB',size)
        frame.paste(reference,((size[0]-1366)//2,(size[1]-768)//2))
        return frame

    def shop_frame(self):
        image=Image.new('RGB',(1366,768))
        for name,x,y in [('buy',565,244),('leave',565,264)]:
            image.paste(Image.fromarray(self.reader.templates[name]),(x,y))
        return image

    def native_control(self,size,frames):
        control=object.__new__(WindowsInput)
        bounds=(10,20,*size)
        control.canvas=Canvas(*size)
        control.reader=self.reader
        control.geometry_checked=False
        control.window=SimpleNamespace(bounds=bounds,capture=Mock(side_effect=[(f,bounds) for f in frames]),click=Mock())
        control.check=Mock()
        control.move=Mock()
        return control

    def test_native_shop_calibration_preserves_dialog_digits_and_input(self):
        for size in [(1280,720),(1365,767),(1920,1080)]:
            with self.subTest(size=size):
                frames=[self.native_frame(f,size) for f in [self.shop_frame(),self.render('quantity',193),self.render('confirm',54040)]]
                control=self.native_control(size,frames)
                self.assertTrue(self.reader.shop(control.capture()))
                self.assertTrue(control.canvas.native)
                control.click(604,252)
                control.window.click.assert_called_with(604+(size[0]-1366)//2,252+(size[1]-768)//2)
                self.assertEqual(self.reader.dialog(control.capture()),('quantity',193))
                self.assertEqual(self.reader.dialog(control.capture()),('confirm',54040))
                self.assertTrue(control.canvas.native,'do not recalibrate while a payment dialog is open')

    def test_scaled_shop_keeps_existing_geometry_and_one_control_is_insufficient(self):
        size=(1920,1080)
        scaled=self.shop_frame().resize(size,Image.Resampling.BILINEAR)
        control=self.native_control(size,[scaled])
        self.assertTrue(self.reader.shop(control.capture()))
        self.assertFalse(control.canvas.native)
        incomplete=self.shop_frame()
        incomplete.paste(0,(565,244,645,260))
        control=self.native_control((1280,720),[self.native_frame(incomplete,(1280,720))])
        self.assertFalse(self.reader.shop(control.capture()))
        self.assertFalse(control.canvas.native)

    def test_unrecognized_preflight_skips_before_input_but_existing_modal_halts(self):
        reader=Mock();reader.dialog.return_value=(None,None);reader.shop.return_value=False
        control=Mock();buyer=WindowsPurchaser(reader,lambda _:control)
        with self.assertRaises(PurchasePreparationSkipped):buyer.prepare(object())
        control.click.assert_not_called();control.quantity.assert_not_called()
        reader.dialog.return_value=('confirm',100)
        with self.assertRaises(PurchaseHalt):buyer.prepare(object())
        control.click.assert_not_called()

    def test_purchase_stop_message_preserves_uncertain_transaction_and_nested_reason(self):
        inner=PurchaseHalt(PurchaseResult('unknown',reason='timeout'))
        outer=PurchaseHalt(PurchaseResult('not_bought',reason='window_lost'))
        outer.__cause__=inner
        message=purchase_halt_message(outer)
        self.assertIn('结果尚未确认',message)
        self.assertIn('超时',message)

    def closing_window(self, states):
        self.now = 0
        def pause(seconds):self.now += seconds
        bounds=(0,0,1920,1080)
        window=SimpleNamespace(bounds=bounds,capture=Mock(return_value=('raw',bounds)),
                               pause=pause,press=Mock(),vision=Mock())
        window.vision.window_markers.side_effect=states
        reader=Mock();reader.shop.return_value=True;reader.dialog.return_value=(None,None)
        control=Mock()
        buyer=WindowsPurchaser(reader,lambda window:control,lambda:self.now)
        helper=SimpleNamespace(try_keyboard_close=Mock(return_value=False),
                               game_menu_visible=lambda image:False,single_button_notice_visible=lambda image:False)
        return buyer,window,control,helper

    def test_post_purchase_direct_leave_closes_then_checks_inventory(self):
        buyer,window,control,helper=self.closing_window([
            dict(owner=[],leave=[1]),dict(owner=[],leave=[]),dict(owner=[],leave=[])])
        expected=dict(item_id=2012000,quantity=53,mesos=738993)
        with patch.dict('sys.modules',shop_window_control=helper), patch('inventory_check.InventoryChecker') as check:
            self.assertTrue(buyer.verify_inventory(window,'folder',expected))
            control.click.assert_called_once_with(604,272)
            helper.try_keyboard_close.assert_not_called()
            window.press.assert_not_called()
            check.return_value.run.assert_called_once_with(window,'purchase',expected)
            self.assertEqual(window.capture.call_count,3)

    def test_post_purchase_close_must_be_verified_before_inventory_input(self):
        for failure in ('unknown','moved','still_open'):
            with self.subTest(failure=failure):
                buyer,window,control,helper=self.closing_window(None)
                window.vision.window_markers.return_value=dict(owner=[],leave=[1])
                if failure=='unknown':buyer.reader.shop.return_value=False
                if failure=='moved':window.capture.return_value=('raw',(1,0,1920,1080))
                with patch.dict('sys.modules',shop_window_control=helper), patch('inventory_check.InventoryChecker') as check:
                    with self.assertRaises(InventoryCheckError):buyer.verify_inventory(window,'folder')
                    check.assert_not_called()
                    if failure=='unknown':control.click.assert_not_called()


if __name__ == '__main__':
    unittest.main()
