"""The overlay's clicks and drags read from the system mouse (grind_overlay_mouse)."""
import unittest

from grind_overlay_mouse import OverlayPointer, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE

RECT = (1000, 300, 1296, 760)     # physical pixels
REGIONS = [dict(id='pause', x=10, y=400, w=130, h=30), dict(id='end', x=150, y=400, w=130, h=30),
           dict(id='grip', x=280, y=444, w=16, h=16)]


class OverlayPointerTest(unittest.TestCase):
    def setUp(self):
        self.pointer = OverlayPointer()
        self.pointer.set_regions(REGIONS)

    def send(self, message, x, y, scale=1.0, overlay_scale=1.0):
        return self.pointer.handle(message, x, y, RECT, scale, overlay_scale)

    def test_a_press_outside_the_overlay_goes_to_the_game(self):
        self.assertEqual(self.send(WM_LBUTTONDOWN, 500, 500), (False, []))
        self.assertEqual(self.send(WM_LBUTTONUP, 500, 500), (False, []))

    def test_a_button_is_clicked_when_released_over_it_and_kept_from_the_game(self):
        self.assertEqual(self.send(WM_LBUTTONDOWN, 1050, 715), (True, []))
        self.assertEqual(self.send(WM_MOUSEMOVE, 1052, 716), (False, []))
        self.assertEqual(self.send(WM_LBUTTONUP, 1052, 716), (True, [('click', 'pause')]))

    def test_released_elsewhere_the_button_is_not_clicked(self):
        self.send(WM_LBUTTONDOWN, 1050, 715)
        self.assertEqual(self.send(WM_LBUTTONUP, 1200, 715), (True, []))

    def test_dragging_the_card_moves_the_window_by_the_mouse_in_physical_pixels(self):
        self.assertEqual(self.send(WM_LBUTTONDOWN, 1100, 320, scale=1.5), (True, []))
        self.assertEqual(self.send(WM_MOUSEMOVE, 1102, 321, scale=1.5), (False, []))          # within the slop
        self.assertEqual(self.send(WM_MOUSEMOVE, 980, 260, scale=1.5), (False, [('move', 880, 240)]))
        self.assertEqual(self.send(WM_LBUTTONUP, 980, 260, scale=1.5), (True, [('moved',)]))

    def test_regions_are_in_css_pixels_scaled_to_the_display(self):
        # At 150 %, the pause button (10..140, 400..430 CSS px) is at 15..210, 600..645 physical.
        tall = (1000, 300, 1444, 990)     # the same window at 150 %
        self.assertEqual(self.pointer.hit(tall, 1.5, 1000 + 100, 300 + 620), 'pause')
        self.assertEqual(self.pointer.hit(tall, 1.5, 1000 + 100, 300 + 420), 'card')

    def test_the_grip_sizes_the_overlay(self):
        self.send(WM_LBUTTONDOWN, 1288, 752, overlay_scale=1.0)
        keep, actions = self.send(WM_MOUSEMOVE, 1288 + 148, 752)                                # width 296 -> 444
        self.assertEqual((keep, actions), (False, [('scale', 1.5, False)]))
        self.assertEqual(self.send(WM_LBUTTONUP, 1288 + 148, 752), (True, [('scale', 1.5, True)]))

    def test_bad_regions_from_the_page_are_dropped(self):
        self.pointer.set_regions([dict(id='x'), 'junk', dict(id='ok', x=0, y=0, w=1, h=1)])
        self.assertEqual([r['id'] for r in self.pointer.regions], ['ok'])


if __name__ == '__main__':
    unittest.main()
