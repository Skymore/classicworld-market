"""Client-render import boundaries; synthetic pictures only."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from tools import niadb_map_assets as assets


class ClientSceneTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        for name, value in (("NIADB", self.root / "data"), ("SCENES", self.root / "scenes"),
                            ("SCENES_SMALL", self.root / "scenes/small")):
            value.mkdir(parents=True, exist_ok=True)
            patched = patch.object(assets, name, value)
            patched.start()
            self.addCleanup(patched.stop)
        self.index = assets.NIADB / "scenes.json"
        assets.write_json(self.index, {"fetched": "original date", "maps": {"1": {"key": "niadb", "w": 800}}})
        assets.write_json(assets.SCENES / "sources.json", {"fetched": "original date", "maps": [1]})

    def picture(self, map_id, size=(800, 600), rect=None):
        Image.new("RGB", size, (90, 60, 30)).save(self.raw / f"{map_id}.png")
        assets.write_json(self.raw / f"{map_id}.json", rect or {"x": -100, "y": -200, "w": size[0], "h": size[1]})

    def test_large_scene_keeps_world_coordinates_and_original_sources(self):
        self.picture(10005060, (2200, 1300))
        result = assets.client_scenes(self.raw)
        self.assertEqual(result["imported"], [10005060])
        data = assets.read_json(self.index)
        self.assertEqual(data["maps"]["1"], {"key": "niadb", "w": 800})
        self.assertEqual(data["fetched"], "original date")
        entry = data["maps"]["10005060"]
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (-100, -200, 2200, 1300))
        self.assertEqual(entry["source_size"], [2200, 1300])
        self.assertEqual(entry["size"], [1760, 1040])
        self.assertEqual((entry["key"], entry["source"]), ("client", "client Map.wz"))
        with Image.open(assets.SCENES_SMALL / "10005060.webp") as image:
            self.assertEqual(image.size, (1100, 650))
        self.assertEqual(assets.read_json(assets.SCENES / "sources.json")["maps"], [1, 10005060])

    def test_small_indoor_scene_also_has_a_phone_copy(self):
        self.picture(1013)
        assets.client_scenes(self.raw)
        for folder in (assets.SCENES, assets.SCENES_SMALL):
            with Image.open(folder / "1013.webp") as image:
                self.assertEqual(image.size, (800, 600))

    def test_existing_index_and_orphan_images_are_never_overwritten(self):
        for map_id in (1, 2, 3):
            self.picture(map_id)
        full, small = assets.SCENES / "2.webp", assets.SCENES_SMALL / "3.webp"
        full.write_bytes(b"existing full picture")
        small.write_bytes(b"existing phone picture")
        original = self.index.read_bytes()
        result = assets.client_scenes(self.raw)
        self.assertEqual(result["existing"], [1, 2, 3])
        self.assertEqual(self.index.read_bytes(), original)
        self.assertEqual(full.read_bytes(), b"existing full picture")
        self.assertEqual(small.read_bytes(), b"existing phone picture")

    def test_invalid_rectangles_and_aspect_ratios_do_not_publish_files(self):
        self.picture(10, rect={"x": 0, "y": 0, "w": 600, "h": 800})
        self.picture(11, rect={"x": 0, "y": 0, "w": 0, "h": 600})
        self.picture(12, rect={"x": False, "y": 0, "w": 800, "h": 600})
        self.picture(13)
        (self.raw / "13.json").write_text("malformed")
        original = self.index.read_bytes()
        result = assets.client_scenes(self.raw)
        self.assertEqual(set(result["rejected"]), {10, 11, 12, 13})
        self.assertEqual(self.index.read_bytes(), original)
        self.assertEqual(list(assets.SCENES.glob("*.webp")), [])


if __name__ == "__main__":
    unittest.main()
