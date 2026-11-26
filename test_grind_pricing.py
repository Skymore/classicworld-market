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
        prices.rows[4031147] = dict(typical=None, npc_sell=None)   # answered, no price anywhere
        self.assertEqual(prices.loot(4031147), (0, '无价格'))

    def test_pumpkin_pie_is_always_750(self):
        prices = Prices()
        prices.rows[2020027] = dict(typical=3000, npc_shop=None)
        self.assertEqual(prices.loot(2020027), (750, '按回复量'))
        self.assertEqual(prices.consumable(2020027), (750, '按回复量'))
        self.assertEqual(prices.consumable(2020028), (None, None), 'other new items are not valued')

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

    def test_materials_close_to_the_npc_price_count_at_the_npc_price(self):
        prices = Prices()
        prices.rows[4000021] = dict(typical=65, npc_sell=50)      # 1.3x: the NPC
        self.assertEqual(prices.loot(4000021), (50, 'NPC 回收价'))
        prices.rows[4000021]['typical'] = 66
        self.assertEqual(prices.loot(4000021), (66, '成交中位'))
        prices.rows[2040804] = dict(typical=60, npc_sell=50)      # not a material
        self.assertEqual(prices.loot(2040804), (60, '成交中位'))

    def test_equipment_priced_like_the_selling_page(self):
        import json
        keys = ['weapon_attack', 'magic_attack', 'critical_rate', 'critical_damage', 'str', 'dex']
        group = lambda attack, slots, recent=(), older=(), asks=(): dict(
            key=json.dumps([[['weapon_attack', attack]], slots, 0]), recent=list(recent), older=list(older), asks=list(asks))
        bow = lambda attack, slots: dict(stats=[dict(key='weapon_attack', value=attack), dict(key='weapon_defense', value=3)],
                                         remaining_upgrades=slots)
        prices = Prices()
        prices.rows[1452007] = dict(typical=250000, key_stats=keys, groups=[
            group(70, 7, recent=[248888, 250000, 260000, 270000]),
            group(82, 0, recent=[4400000], asks=[3999999, 4800000]),
            group(84, 0, asks=[8399999, 8500000, 8888888]),
            group(79, 0, recent=[1150000, 1299999]),
        ])
        # Three recent sales of the same stats: their median.
        self.assertEqual(prices.loot(1452007, bow(70, 7)), (255000, '同属性成交中位'))
        # One sale: with that group's asks.
        self.assertEqual(prices.loot(1452007, bow(82, 0)), (4400000, '同属性成交加在售'))
        # None: the closest stats with the same upgrades, three at least (82 and 84 tie).
        self.assertEqual(prices.loot(1452007, bow(83, 0)), (6599999.5, '相近属性'))
        # Nothing with those upgrades: the item's median.
        self.assertEqual(prices.loot(1452007, bow(75, 3)), (250000, '成交中位'))

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
