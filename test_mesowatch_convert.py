import unittest

from mesowatch_convert import convert_product, convert_sale, mapping_status, numeric_id


class MesoWatchConversionTests(unittest.TestCase):
    def item(self, **overrides):
        return dict(id="basil:04010001", name="Iron Ore", unitBasis="item", price=399,
                    p25=389, p75=419, priceBasis="24h", priceSales=321, trend=-0.002,
                    sold=6684, asks=4477, askMedian=550, low=50, high=2999, **overrides)

    def product(self, item):
        return convert_product(item, {"name_en": "Iron Ore", "name_zh": "铁矿石"})

    def test_price_and_ask_fields_have_distinct_meanings(self):
        product = self.product(self.item())
        self.assertEqual((product["typical"], product["typical_low"], product["typical_high"]), (399, 389, 419))
        self.assertEqual(product["median"], 550)
        self.assertIsNone(product["low"])
        self.assertIsNone(product["high"])
        self.assertIsNone(product["listings"])
        self.assertIsNone(product["sales_10d"])
        self.assertEqual(product["change_24h"], -0.2)

    def test_last10_does_not_invent_24_hour_count(self):
        item = self.item()
        item.update(priceBasis="last10", priceSales=10)
        product = self.product(item)
        self.assertEqual(product["typical_basis"], "recent")
        self.assertIsNone(product["sales_24h"])
        self.assertEqual(product["typical_count"], 10)

    def test_set_price_is_not_divided_by_source_qty(self):
        item = self.item()
        item.update(id="basil:02070001", unitBasis="set", price=27888)
        product = self.product(item)
        self.assertEqual(product["typical"], 27888)
        self.assertTrue(product["requires_set_price_support"])
        sale = convert_sale(dict(id="s1", price=27888, qty=500,
                                 time="2026-10-22T12:00:00Z", how="found sold out"), item)
        self.assertIsNone(sale["sale_unit_price"])
        self.assertIsNone(sale["quantity"])
        self.assertIsNone(sale["bundle"])
        self.assertEqual(sale["source_qty"], 500)

    def test_numeric_id_requires_supported_namespace(self):
        self.assertEqual(numeric_id("basil:04010001"), 4010001)
        with self.assertRaises(ValueError):
            numeric_id("other:04010001")
        with self.assertRaises(ValueError):
            numeric_id("basil:99999999")

    def test_id_match_does_not_override_name_conflict(self):
        self.assertEqual(mapping_status(self.item(), {4010001: {"name_en": "Different Ore"}}), "same_id_different_name")
        self.assertEqual(mapping_status(self.item(), {}), "missing_id")

    def test_sale_preserves_inference_and_unknown_fields(self):
        sale = convert_sale(dict(id="s1", price=399, qty=1, time="2026-10-22T12:00:00Z",
                                 how="found sold out"), self.item())
        self.assertEqual(sale["kind"], "found_sold")
        self.assertEqual(sale["sale_unit_price"], 399)
        self.assertIsNone(sale["sale_price"])
        self.assertIsNone(sale["quantity"])
        self.assertIsNone(sale["previous_time"])
        self.assertEqual(sale["source"], "mesowatch")


if __name__ == "__main__":
    unittest.main()
