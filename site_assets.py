"""The website's current front end for the collector's loopback pages.

The collector ships a copy of the site's front end, which goes stale between
collector releases. This keeps a newer copy from the official site on this PC:
when the site's asset version differs from the bundled one, the page shell and
every file its build manifest lists are downloaded into a cache folder, and only
a complete set is served. Anything else, including an unreachable site, falls
back to the bundled files, so the loopback pages always open.

Only static files under /web/ are fetched, without credentials; API requests
keep going through the loopback gateway's own routes.
"""
import json
import re
import shutil
import threading
import time
import urllib.request
from pathlib import Path

import web_assets

VERSION_FILE = '/web/react/asset-version.txt'
MANIFEST = '/web/react/.vite/manifest.json'
SHELL = '/web/index.html'
CORE = ('/web/react/app.js', '/web/react/shell.js', '/web/react/style.css', '/web/react/preload.json')
MAX_FILE = 16 * 1024 * 1024
MAX_FILES = 600


def safe(path):
    """A /web/ path of a servable type, with no hidden or parent segments."""
    if not isinstance(path, str) or not path.startswith(web_assets.PREFIX) or len(path) > 300:
        return False
    parts = path[len(web_assets.PREFIX):].split('/')
    return (all(part and not part.startswith('.') and re.fullmatch(r'[\w.@-]+', part) for part in parts)
            and Path(parts[-1]).suffix.lower() in web_assets.TYPES)


class LiveSite:
    def __init__(self, endpoint, cache, opener=None, interval=300):
        self.endpoint, self.cache, self.interval = endpoint.rstrip('/'), Path(cache), interval
        self.opener = opener or urllib.request.build_opener()
        self.lock = threading.Lock()
        self.version = None          # A fully downloaded site version newer than the bundle.
        self.checked = -float('inf')
        try:
            self.bundled = (web_assets.WEB/'react/asset-version.txt').read_text(encoding='utf-8').strip()
        except OSError:
            self.bundled = ''

    def fetch(self, path, limit=MAX_FILE):
        with self.opener.open(urllib.request.Request(self.endpoint+path), timeout=15) as response:
            if getattr(response, 'status', 200) != 200:
                raise ValueError('Unexpected status')
            body = response.read(limit+1)
        if len(body) > limit:
            raise ValueError('File too large')
        return body

    def store(self, version, path, body):
        target = self.cache/version/path[len(web_assets.PREFIX):]
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name+'.tmp')
        temporary.write_bytes(body)
        temporary.replace(target)

    def download(self, version):
        """Fetch the shell and everything its build lists; raises unless the set is complete."""
        shell = self.fetch(SHELL)
        manifest = json.loads(self.fetch(MANIFEST))
        paths = set(CORE)
        paths.update(match.split('?')[0] for match in re.findall(r'["\'](/web/[^"\'?#\s]+)', shell.decode('utf-8', 'replace')))
        for entry in manifest.values():
            for name in [entry.get('file'), *entry.get('css', []), *entry.get('assets', [])]:
                if name:
                    paths.add('/web/react/'+name)
        paths = sorted(path for path in paths if safe(path))
        if not paths or len(paths) > MAX_FILES:
            raise ValueError('Unexpected site file list')
        for path in paths:
            if not (self.cache/version/path[len(web_assets.PREFIX):]).is_file():
                self.store(version, path, self.fetch(path))
        self.store(version, SHELL, shell)
        # The site may have published again while this ran: a mixed set must not be served.
        if self.fetch(VERSION_FILE, 200).decode('ascii', 'replace').strip() != version:
            raise ValueError('Site changed during download')
        (self.cache/version/'complete').write_text('1', encoding='utf-8')

    def refresh(self, force=False):
        """Check the site at most once per interval. Safe to call from a background thread."""
        with self.lock:
            now = time.monotonic()
            if not force and now-self.checked < self.interval:
                return self.version
            self.checked = now
            try:
                version = self.fetch(VERSION_FILE, 200).decode('ascii', 'replace').strip()
                if not re.fullmatch(r'[0-9A-Za-z._-]{1,64}', version):
                    raise ValueError('Invalid version')
                if version == self.bundled:
                    self.version = None
                elif version != self.version:
                    if not (self.cache/version/'complete').is_file():
                        self.download(version)
                    self.version = version
                    for old in self.cache.iterdir():
                        if old.is_dir() and old.name != version:
                            shutil.rmtree(old, ignore_errors=True)
            except Exception:
                pass  # Offline or incomplete: keep what is already being served.
            return self.version

    def start(self, stop=None):
        def work():
            while not (stop and stop.is_set()):
                self.refresh()
                time.sleep(30)
        threading.Thread(target=work, daemon=True, name='site-assets').start()

    def read(self, path):
        """Bytes of a cached site file for the served version, or None for the bundled file."""
        version = self.version
        if not version or not (path == SHELL or safe(path)):
            return None
        target = self.cache/version/path[len(web_assets.PREFIX):]
        try:
            return target.read_bytes()
        except OSError:
            pass
        if path == SHELL:
            return None
        # A file the build does not list (an image, a stylesheet): fetch it once on demand.
        try:
            body = self.fetch(path)
            self.store(version, path, body)
            return body
        except Exception:
            return None
