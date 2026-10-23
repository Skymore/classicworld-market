"""Static files and page routes of the redesigned web UI, shared by every server."""
from pathlib import Path

WEB = Path(__file__).resolve().parent/'web'
PREFIX = '/web/'
TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.woff2': 'font/woff2',
}
PAGES = ('/v2', '/v2/sales', '/v2/watch', '/v2/alerts')
LOCAL_PAGES = ('/v2/selling',)


def asset(path):
    """(file, content type) for a /web/ URL path, or None. Hidden files, other
    extensions and anything outside web/ are never served."""
    if not path.startswith(PREFIX):
        return None
    parts = path[len(PREFIX):].split('/')
    if any(not part or part.startswith('.') or '\\' in part for part in parts):
        return None
    target = WEB.joinpath(*parts).resolve()
    root = WEB.resolve()
    kind = TYPES.get(target.suffix.lower())
    if kind is None or root not in target.parents or not target.is_file():
        return None
    return target, kind


def page(path, local=False):
    """App shell for a redesigned page route, or None. The selling planner
    exists only on the private local dashboard."""
    route = path.rstrip('/') or '/'
    if route in PAGES or (local and route in LOCAL_PAGES):
        return (WEB/'index.html').read_bytes()
    return None
