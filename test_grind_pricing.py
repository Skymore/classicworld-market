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

    def test_equipment_without_recent_sales_in_its_group_uses_the_groups_lowest_ask(self):
        from grind_pricing import group_key
        piece = dict(stats=[dict(key='weapon_attack', value=73)], remaining_upgrades=7)
        prices = Prices()
        prices.rows[1442007] = dict(typical=1350000, groups=[dict(key=group_key(piece), median=None, sales=0, lowest_ask=240000)])
        self.assertEqual(prices.loot(1442007, piece), (240000, '同属性最低挂单'))
        prices.rows[1442007]['groups'][0]['median'] = 500000
        self.assertEqual(prices.loot(1442007, piece), (500000, '同属性成交中位'))

    def test_equipment_groups_by_the_key_stats_the_site_sends(self):
        from grind_pricing import group_key
        keys = ['weapon_attack', 'magic_attack', 'int', 'luk']
        sold = dict(stats=[dict(key='int', value=3), dict(key='weapon_defense', value=28), dict(key='hp', value=5)],
                    remaining_upgrades=7)
        piece = dict(stats=[dict(key='int', value=3), dict(key='weapon_defense', value=27), dict(key='hp', value=4)],
                     remaining_upgrades=7)
        prices = Prices()
        prices.rows[1052075] = dict(typical=7000, key_stats=keys,
                                    groups=[dict(key=group_key(sold, keys), median=5555, sales=1)])
        self.assertEqual(prices.loot(1052075, piece), (5555, '同属性成交中位'))

    def test_a_cache_from_another_client_version_is_asked_again(self):
        import json, tempfile, time
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'prices.json'
            path.write_text(json.dumps(dict(version='0.0.1', items={'1442007': dict(typical=750000, at=time.time())})))
            asked = []
            prices = Prices(path, fetch=lambda ids, maps=(), mobs=(): asked.append(list(ids)) or {'prices': {'1442007': {'typical': 240000}}})
            prices.want([1442007])
            prices.refresh_once()
            self.assertEqual(asked, [[1442007]])
            self.assertEqual(prices.rows[1442007]['typical'], 240000)
            self.assertNotEqual(json.loads(path.read_text())['version'], '0.0.1')

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
