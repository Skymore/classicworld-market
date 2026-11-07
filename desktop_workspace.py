"""Native desktop account, watch and sweep commands. Credentials never enter the WebView."""
import json
import urllib.request
from urllib.parse import urlsplit
from account_device import DeviceError, browser_endpoint
from collector_dashboard import Gateway

# Website sections the collector window shows as tabs (page key -> path).
SITE_PAGES = {'home': '/prices', 'prices': '/prices', 'dex': '/search?kind=item', 'watch': '/watch', 'tools': '/tools'}

ERRORS = {'login_required': '请重新登录账号', 'sweep_running': '已有进行中的扫货',
          'rate_limited': '操作太频繁，请稍后再试', 'no_sweep_groups': '请先在关注中勾选可扫货的条件组',
          'device_unavailable': '此电脑暂不能参加扫货', 'invalid_request': '请求无效，请检查后重试',
          'sweep_stopped': '扫货已结束'}


class DesktopWorkspace:
    def __init__(self, runtime, sweep=None):
        self.runtime = runtime
        self.sweep = sweep
        self.gateway = None

    def cloud(self):
        if self.gateway is None:
            self.gateway = Gateway(self.runtime.configuration(), self.runtime.folder)
        return self.gateway

    def fetch(self, path, ttl=0):
        g = self.cloud()
        value = g.fetch(path, ttl, timeout=8)
        if g.last_error:
            raise ValueError('同步暂不可用，请稍后重试')
        return value

    def dashboard(self):
        state = json.loads((self.runtime.home/'dashboard.json').read_text(encoding='utf-8'))
        address = urlsplit(state['url'])
        if address.scheme != 'http' or address.hostname != '127.0.0.1' or not address.port:
            raise ValueError('本机服务地址无效')
        return address.port

    def local(self, path, body):
        # The login callback lives in the loopback dashboard process, so it starts the login.
        base = f'http://127.0.0.1:{self.dashboard()}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(base+path, timeout=8) as response:
            csrf = json.load(response)['csrf']
        request = urllib.request.Request(base+path, data=json.dumps(body).encode(), headers={
            'Content-Type': 'application/json', 'Origin': base, 'X-CSRF-Token': csrf})
        with opener.open(request, timeout=10) as response:
            return json.load(response)

    def engine(self):
        if self.sweep is None:
            raise ValueError('扫货服务未启动，请重新打开程序')
        return self.sweep

    def run(self, action, value=None):
        try:
            return self._run(action, value)
        except DeviceError as e:
            raise ValueError(ERRORS.get(e.code, '操作失败，请稍后重试')) from None
        except (OSError, RuntimeError):
            raise ValueError('同步暂不可用，请稍后重试') from None

    def _run(self, action, value):
        if action == 'status':
            return self.engine().status()
        if action == 'page':
            if not isinstance(value, dict) or value.get('page') not in SITE_PAGES:
                raise ValueError('无效页面')
            theme = value.get('theme') if value.get('theme') in ('light','dark') else 'light'
            lang = value.get('lang') if value.get('lang') in ('zh','en','ko') else 'zh'
            # embed=1: the site hides its own header, navigation and assistant inside the collector.
            query = '?lang='+lang+'&theme='+theme+'&embed=1'
            path = SITE_PAGES[value['page']]
            if value['page'] == 'watch':
                # The watch page signs in through the collector's loopback gateway.
                return {'url': f'http://127.0.0.1:{self.dashboard()}'+path+query}
            # Public pages come from the website itself, so they match it feature for feature.
            site = browser_endpoint(self.runtime.configuration())
            return {'url': site+path+('&' if '?' in path else '?')+query[1:]}
        if action == 'catalog':
            return self.fetch('/api/v1/watchlist/catalog', 300)
        if action == 'login':
            import webbrowser
            url = self.local('/api/v1/device/login', {}).get('url', '')
            expected = browser_endpoint(self.runtime.configuration())+'/device?'
            if not isinstance(url, str) or not url.startswith(expected) or len(url) > 2048:
                raise ValueError('登录地址无效')
            webbrowser.open(url)
            return {'opened': True}
        if action == 'logout':
            self.engine().logout()
            return self.engine().status()
        if action == 'settings':
            self.engine().save_settings(value)
            return self.engine().status()
        if action == 'start':
            self.engine().start_run(value)
            return self.engine().status()
        if action == 'stop':
            self.engine().stop_run()
            return self.engine().status()
        if action == 'devices':
            return self.engine().devices()
        if action == 'rename':
            self.engine().rename(value)
            return self.engine().status()
        raise ValueError('未知操作')
