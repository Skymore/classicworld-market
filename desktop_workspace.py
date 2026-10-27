"""Native desktop account/watch commands. Credentials never enter the WebView."""
import hashlib
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from collector_dashboard import Gateway


class DesktopWorkspace:
    def __init__(self, runtime):
        self.runtime = runtime
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

    def local(self, command=None):
        state = json.loads((self.runtime.home/'dashboard.json').read_text(encoding='utf-8'))
        address = urlsplit(state['url'])
        if address.scheme != 'http' or address.hostname != '127.0.0.1' or not address.port:
            raise ValueError('本机服务地址无效')
        base = f'http://127.0.0.1:{address.port}'
        url = base+'/api/v1/collector/sweep'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=8) as response:
            current = json.load(response)
        if command:
            request = urllib.request.Request(url, data=json.dumps(command).encode(), headers={
                'Content-Type':'application/json', 'Origin':base, 'X-CSRF-Token':current['csrf']})
            with opener.open(request, timeout=10) as response:
                current = json.load(response)
        current.pop('csrf', None)
        return current

    def status(self):
        data = self.fetch('/api/v1/collector/watch-data')
        try:
            data['simulation'] = self.local()
        except (OSError, ValueError):
            data['simulation'] = None
        return data

    def run(self, action, value=None):
        try:
            return self._run(action, value)
        except urllib.error.HTTPError as e:
            if e.code == 409:
                raise ValueError('条件已在其他设备修改，请刷新后再编辑') from None
            if e.code in (401,403):
                raise ValueError('请重新登录账号') from None
            raise ValueError('同步失败，请检查条件并重试') from None

    def _run(self, action, value):
        if action == 'status':
            return self.status()
        if action == 'page':
            if not isinstance(value, dict) or value.get('page') not in ('watch', 'prices'):
                raise ValueError('无效页面')
            state = json.loads((self.runtime.home/'dashboard.json').read_text(encoding='utf-8'))
            address = urlsplit(state['url'])
            if address.scheme != 'http' or address.hostname != '127.0.0.1' or not address.port:
                raise ValueError('本机服务地址无效')
            theme = value.get('theme') if value.get('theme') in ('light','dark') else 'light'
            return {'url': f'http://127.0.0.1:{address.port}/'+value['page']+'?lang=zh&theme='+theme}
        if action == 'catalog':
            return self.fetch('/api/v1/watchlist/catalog', 300)
        if action == 'login':
            import webbrowser
            result = self.cloud().update('/api/v1/collector/account-link', {})
            url = urlsplit(result.get('url',''))
            if url.scheme != 'https' or url.netloc != 'mxd.ruit.me' or url.path != '/account':
                raise ValueError('登录地址无效')
            webbrowser.open(result['url'])
            return {'opened':True}
        if action in ('save','logout'):
            if not isinstance(value,dict):raise ValueError('无效设置')
            self.local({'action':'stop'})
            path = '/api/v1/collector/watch-data' if action == 'save' else '/api/v1/collector/account-disconnect'
            self.cloud().update(path, value)
            return self.status()
        if action == 'stop':
            self.local({'action':'stop'})
            return self.status()
        if action == 'start':
            revision = self.fetch('/api/v1/collector/watch-revision')['revision']
            data = self.fetch('/api/v1/collector/watch-data')
            if not data.get('linked') or not isinstance(value,dict) or value.get('account')!=data.get('public_id'):
                raise ValueError('请先登录同一账号')
            records = data['records']
            watches = []
            limits = None
            for r in records:
                setting = r.get('value')
                if r['kind']=='pref' and r['key']=='watch.sweepSettings' and setting:
                    limits = json.loads(setting)
                elif r['kind']=='watch' and setting:
                    groups = [g for g in setting.get('groups',[]) if g.get('buy')]
                    if groups:
                        watches.append(dict(item_id=int(r['key']),limit=setting.get('buyLimit',1),groups=groups))
            if not watches:raise ValueError('请勾选至少一组扫货条件并保存')
            if not limits:raise ValueError('请先保存本轮预算设置')
            catalog = {int(i['item_id']):i for i in self.fetch('/api/v1/watchlist/catalog',300).get('items',[])}
            reference = self.fetch('/api/v1/watchlist/listings?ids='+','.join(str(w['item_id']) for w in watches))
            for w in watches:
                item = catalog.get(w['item_id'],{})
                w['name'] = item.get('name_zh') or item.get('name_en') or str(w['item_id'])
                w['base_stats'] = reference.get('base_stats',{}).get(str(w['item_id']),[])
            # Only the latest synchronized server rules are executable.
            config = dict(mode='simulate',limits=limits,watches=watches)
            config['source_key'] = hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()
            self.local(dict(action='start',expected_revision=revision,**config))
            return self.status()
        raise ValueError('未知操作')
