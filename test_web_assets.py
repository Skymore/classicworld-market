import tempfile
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from html.parser import HTMLParser
from pathlib import Path

import web_assets


class References(HTMLParser):
    """Collects same-origin script and stylesheet URLs of a page."""
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.urls.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.urls.append(attrs['href'])


class WebAssetTests(unittest.TestCase):
    def test_serves_files_under_web_with_known_types(self):
        target, kind = web_assets.asset('/web/js/app.js')
        self.assertEqual(target, (web_assets.WEB/'js/app.js').resolve())
        self.assertIn('javascript', kind)
        self.assertIn('css', web_assets.asset('/web/css/base.css')[1])

    def test_rejects_paths_outside_web_hidden_files_and_other_types(self):
        for path in ('/web/../shared_server.py', '/web/js/../../web_assets.py', '/web/', '/web/js/',
                     '/web//etc/passwd', '/web/.hidden', '/web/js/.app.js', '/web/js\\app.js',
                     '/web/missing.js', '/web/index.py', '/market_ui.js', '/webjs/app.js'):
            with self.subTest(path=path):
                self.assertIsNone(web_assets.asset(path))

    def test_page_shell_routes(self):
        shell = (web_assets.WEB/'index.html').read_bytes()
        for path in ('/v2', '/v2/', '/v2/sales', '/v2/watch', '/v2/alerts'):
            with self.subTest(path=path):
                self.assertEqual(web_assets.page(path), shell)
        self.assertIsNone(web_assets.page('/v2/selling'))
        self.assertEqual(web_assets.page('/v2/selling', local=True), shell)
        for path in ('/', '/alerts', '/v2/unknown', '/v2x'):
            self.assertIsNone(web_assets.page(path, local=True))

    def test_shell_references_only_servable_assets(self):
        page = References()
        page.feed((web_assets.WEB/'index.html').read_text(encoding='utf-8'))
        self.assertTrue(page.urls)
        for url in page.urls:
            with self.subTest(url=url):
                self.assertIsNotNone(web_assets.asset(urlsplit(url).path))


class SharedServerWebTests(unittest.TestCase):
    def setUp(self):
        from shared_server import create_app
        from shared_store import SharedStore
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SharedStore(Path(self.tmp.name), Path(self.tmp.name)/'absent')
        self.public = create_app(self.store, public_read=True).test_client()
        self.private = create_app(self.store).test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_public_shell_and_assets(self):
        for path in ('/v2', '/v2/sales', '/v2/alerts'):
            page = self.public.get(path)
            self.assertEqual(page.status_code, 200)
            self.assertIn('text/html', page.content_type)
            references = References()
            references.feed(page.get_data(as_text=True))
            page.close()
            for url in references.urls:
                asset = self.public.get(url)
                self.assertEqual(asset.status_code, 200, url)
                self.assertEqual(asset.content_type.count('charset'), 1, asset.content_type)
                self.assertEqual(asset.headers['Cache-Control'], 'no-cache')
                self.assertIn('Content-Security-Policy', asset.headers)
                asset.close()
        self.assertEqual(self.public.get('/v2/selling').status_code, 404)
        self.assertEqual(self.public.get('/web/../shared_server.py').status_code, 404)
        self.assertEqual(self.public.get('/web/js/missing.js').status_code, 404)
        self.assertEqual(self.public.get('/api/v1/market?summary=1').headers['Cache-Control'], 'no-store')

    def test_private_mode_requires_sign_in_for_pages(self):
        page = self.private.get('/v2')
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'login', page.data.lower())
        self.assertNotIn(b'/web/js/app.js', page.data)
        page.close()


class CollectorDashboardWebTests(unittest.TestCase):
    def test_loopback_shell_and_assets(self):
        from collector_dashboard import create_server
        import threading
        with tempfile.TemporaryDirectory() as folder:
            config = dict(endpoint='http://127.0.0.1:9', token='t'*40)
            server = create_server(config, Path(folder), 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{server.server_port}'
            try:
                for path in ('/v2', '/v2/alerts', '/web/js/app.js', '/web/css/base.css'):
                    with urllib.request.urlopen(url+path, timeout=10) as response:
                        self.assertEqual(response.status, 200, path)
                for path in ('/v2/selling', '/web/../collector_dashboard.py'):
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        urllib.request.urlopen(url+path, timeout=10)
                    self.assertEqual(failure.exception.code, 404, path)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
