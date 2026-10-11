import unittest
from market_browser_bot import Vision, Image


class VisionSafetyTests(unittest.TestCase):
    def setUp(self):
        self.vision=Vision()

    def scene(self, button=None):
        image=Image.new('RGB',(800,600),'#839fbd')
        image.paste(Image.fromarray(self.vision.templates['coin_small']),(240,220))
        if button:
            image.paste(Image.fromarray(self.vision.templates[button]),(380,280))
        return image

    def test_visible_shop_target(self):
        state=self.vision.inspect(self.scene())
        self.assertEqual([(x['x'],x['y']) for x in state['targets']],[(280,200)])

    def test_owner_blocks_all_open_targets(self):
        state=self.vision.inspect(self.scene('owner'))
        self.assertTrue(state['owner'])
        self.assertEqual(state['targets'],[])
        self.assertEqual(state['leave'],[])

    def test_visitor_window_blocks_background_targets(self):
        state=self.vision.inspect(self.scene('leave'))
        self.assertTrue(state['leave'])
        self.assertEqual(state['targets'],[])

    def test_blank_screen_has_no_action(self):
        state=self.vision.inspect(Image.new('RGB',(800,600),'black'))
        self.assertFalse(any(state.values()))


if __name__=='__main__':unittest.main()
