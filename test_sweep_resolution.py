import unittest
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
from PIL import Image

from sweep_screen import Canvas, Reader
from sweep_purchaser_windows import WindowsInput, WindowsPurchaser


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


if __name__ == '__main__':
    unittest.main()
