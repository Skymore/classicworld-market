import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import site_assets
from site_assets import LiveSite, safe


class Site:
    """A fake official site: path -> bytes; counts requests and can go offline."""
    def __init__(self, version='newversion1'):
        self.offline, self.requests = False, []
        self.files = {
            '/web/react/asset-version.txt': version.encode(),
            '/web/index.html': b'<html><link href="/web/css/base.css?v=1"><script src="/web/react/app.js?v=1"></script><a href="/web/../secret"></a></html>',
            '/web/react/.vite/manifest.json': json.dumps({
                'main': {'file': 'chunks/main-NEW.js', 'css': ['chunks/main-NEW.css']},
                'bad': {'file': '../../outside.js'}}).encode(),
            '/web/react/app.js': b'new app', '/web/react/shell.js': b's', '/web/react/style.css': b'c',
            '/web/react/preload.json': b'{}', '/web/css/base.css': b'base',
            '/web/react/chunks/main-NEW.js': b'new main', '/web/react/chunks/main-NEW.css': b'css',
            '/web/img/extra.svg': b'<svg/>',
        }

    def open(self, request, timeout=None):
        path = request.full_url.removeprefix('https://site.example')
        self.requests.append(path)
        self.last_headers = dict(request.header_items())
        if self.offline or path not in self.files:
            raise urllib.error.URLError('unavailable')
        response = io.BytesIO(self.files[path])
        response.status = 200
        return response


class LiveSiteTests(unittest.TestCase):
    def setUp(self):
        self.cache = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.site = Site()
        self.live = LiveSite('https://site.example', self.cache, self.site, interval=0)
        self.live.bundled = 'bundled0'

    def test_complete_newer_copy_is_served_and_only_safe_paths_are_fetched(self):
        self.assertIsNone(self.live.read('/web/react/app.js'))  # Nothing cached yet: bundled.
        self.assertEqual(self.live.refresh(), 'newversion1')
        self.assertEqual(self.live.read('/web/react/app.js'), b'new app')
        self.assertEqual(self.live.read('/web/react/chunks/main-NEW.js'), b'new main')
        self.assertIn(b'/web/react/app.js', self.live.read(site_assets.SHELL))
        self.assertFalse(any('..' in path or 'secret' in path or 'outside' in path for path in self.site.requests))
        self.assertNotIn('Authorization', self.site.last_headers)
        # Files the build does not list arrive on demand and are cached.
        self.assertEqual(self.live.read('/web/img/extra.svg'), b'<svg/>')
        self.site.offline = True
        self.assertEqual(self.live.read('/web/img/extra.svg'), b'<svg/>')
        self.assertIsNone(self.live.read('/web/img/missing.svg'))

    def test_same_version_as_the_bundle_uses_the_bundle(self):
        self.live.bundled = 'newversion1'
        self.assertIsNone(self.live.refresh())
        self.assertEqual(self.site.requests, ['/web/react/asset-version.txt'])
        self.assertIsNone(self.live.read('/web/react/app.js'))

    def test_incomplete_download_is_never_served(self):
        del self.site.files['/web/react/chunks/main-NEW.js']
        self.assertIsNone(self.live.refresh())
        self.assertIsNone(self.live.read('/web/react/app.js'))
        self.assertIsNone(self.live.read(site_assets.SHELL))

    def test_offline_keeps_serving_the_cached_copy_and_old_versions_are_removed(self):
        self.live.refresh()
        self.site.offline = True
        self.assertEqual(self.live.refresh(), 'newversion1')
        self.assertEqual(self.live.read('/web/react/app.js'), b'new app')
        # A later collector start finds the complete copy without downloading it again.
        self.site.offline = False
        again = LiveSite('https://site.example', self.cache, self.site, interval=0)
        again.bundled = 'bundled0'
        before = len(self.site.requests)
        self.assertEqual(again.refresh(), 'newversion1')
        self.assertEqual(self.site.requests[before:], ['/web/react/asset-version.txt'])
        self.site.files['/web/react/asset-version.txt'] = b'newversion2'
        self.assertEqual(again.refresh(), 'newversion2')
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), ['newversion2'])

    def test_site_publishing_during_the_download_is_not_adopted(self):
        real = self.site.open

        def changing(request, timeout=None):
            if request.full_url.endswith('main-NEW.css'):
                self.site.files['/web/react/asset-version.txt'] = b'newversion2'
            return real(request, timeout)
        with patch.object(self.site, 'open', side_effect=changing):
            self.assertIsNone(self.live.refresh())

    def test_path_rules(self):
        for good in ('/web/react/app.js', '/web/css/base.css', '/web/react/chunks/a-B_c.js', '/web/img/x.svg'):
            self.assertTrue(safe(good), good)
        for bad in ('/web/../x.js', '/web/.vite/manifest.json', '/api/v1/x', '/web/a.exe', '/web/a b.js', '/web//a.js', None):
            self.assertFalse(safe(bad), bad)


if __name__ == '__main__':
    unittest.main()
