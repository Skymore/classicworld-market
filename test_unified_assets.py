"""The actual desktop web staging must retain Vite's route CSS and assets."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from build_unified_client import stage_web


class UnifiedAssetsTests(unittest.TestCase):
    def fixture(self, root):
        manifest = {'app': {'file': 'app.js'}, 'watch': {
            'file': 'chunks/watch-new.js', 'css': ['chunks/watch-new.css'],
            'assets': ['chunks/font-new.woff2', 'assets/icon.svg']}}
        files = ['index.html', 'react/app.js', 'react/chunks/watch-new.js',
                 'react/chunks/watch-new.css', 'react/chunks/font-new.woff2',
                 'react/assets/icon.svg', 'react/chunks/old.js', 'react/chunks/old.css',
                 'tests/private.mjs', 'images/large.png', 'releases/installer.zip']
        for name in files:
            target = root / 'web' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(name.encode())
        target = root / 'web/react/.vite/manifest.json'
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps(manifest))

    def test_staged_site_keeps_current_css_assets_and_omits_old_builds(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root)
            output = root / 'staged'
            stage_web(root, output)
            for name in ['react/chunks/watch-new.js', 'react/chunks/watch-new.css',
                         'react/chunks/font-new.woff2', 'react/assets/icon.svg']:
                self.assertEqual((output / name).read_bytes(), (root / 'web' / name).read_bytes())
            for name in ['react/chunks/old.js', 'react/chunks/old.css', 'tests', 'images', 'releases']:
                self.assertFalse((output / name).exists(), name)

    def test_missing_route_styles_stop_the_build(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root)
            (root / 'web/react/chunks/watch-new.css').unlink()
            with self.assertRaisesRegex(ValueError, 'watch-new.css'):
                stage_web(root, root / 'staged')
            self.assertFalse((root / 'staged').exists())
