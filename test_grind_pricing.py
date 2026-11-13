import unittest

from grind_pricing import Prices


class LootPriceTests(unittest.TestCase):
    def test_missing_api_price_falls_back_to_npc_even_offline(self):
        prices = Prices()
        prices.rows[4000156] = dict(typical=None, npc_sell=None)
        self.assertEqual(prices.loot(4000156), (57, 'NPC 回收价'))
        self.assertEqual(prices.loot(4000157), (63, 'NPC 回收价'))
        prices.rows[4000156]['typical'] = 80
        self.assertEqual(prices.loot(4000156), (80, '成交中位'))
        self.assertEqual(prices.loot(4000156, basis='npc'), (57, 'NPC 回收价'))
        self.assertEqual(prices.loot(4000156, basis='none'), (0, '不计'))
        self.assertEqual(prices.loot(4999999), (None, None))

    def test_consumables_cost_their_median_sale_and_the_shop_only_when_never_sold(self):
        prices = Prices()
        prices.rows[2060001] = dict(npc_shop=2, typical=1.4375)
        prices.rows[2060002] = dict(npc_shop=None, typical=3)
        prices.rows[2000001] = dict(npc_shop=160, typical=None)
        self.assertEqual(prices.consumable(2060001), (1.4375, '成交中位'))
        self.assertEqual(prices.consumable(2060002), (3, '成交中位'))
        self.assertEqual(prices.consumable(2000001), (160, '商店价'))
        for item in (2070000, 2070006, 2330000):
            prices.rows[item] = dict(npc_shop=500, typical=1000000)
            self.assertEqual(prices.consumable(item)[0], 0)


if __name__ == '__main__':
    unittest.main()
