import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from account_device import DeviceError
from desktop_workspace import DesktopWorkspace

STATUS = {'linked': True, 'account': {'id': 'acct', 'nickname': 'N'}, 'device': {'id': 'dev', 'name': 'PC'},
          'sweep': {'settings': {}, 'executor': {'ready': False, 'reason': '此电脑尚未安装购买执行器'},
                    'run': None, 'recent': [], 'message': ''}}


class DesktopWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        runtime=Mock(home=Path(self.temp.name),folder=Path(self.temp.name))
        runtime.configuration.return_value={'endpoint':'https://mxd.ruit.me','token':'collector-secret'}
        self.sweep=Mock()
        self.sweep.status.return_value=STATUS
        self.workspace=DesktopWorkspace(runtime,self.sweep)
        self.workspace.gateway=Mock(last_error=False)

    def test_status_and_sweep_commands_go_to_the_engine(self):
        self.assertEqual(self.workspace.run('status'),STATUS)
        settings={'allow_web_start':True,'max_spend':1000,'max_order':0,'reserve_mesos':0}
        self.assertEqual(self.workspace.run('settings',settings),STATUS)
        self.sweep.save_settings.assert_called_once_with(settings)
        self.workspace.run('start',{'budget':1000,'minutes':60})
        self.sweep.start_run.assert_called_once_with({'budget':1000,'minutes':60})
        self.workspace.run('stop')
        self.sweep.stop_run.assert_called_once_with()
        self.assertEqual(self.workspace.run('logout'),STATUS)
        self.sweep.logout.assert_called_once_with()

    def test_errors_are_short_chinese_messages(self):
        self.sweep.start_run.side_effect=DeviceError(409,{'error':'sweep_running'})
        with self.assertRaisesRegex(ValueError,'已有进行中的扫货'):self.workspace.run('start',{'budget':1,'minutes':5})
        self.sweep.stop_run.side_effect=OSError('offline')
        with self.assertRaisesRegex(ValueError,'同步暂不可用'):self.workspace.run('stop')
        self.sweep.save_settings.side_effect=ValueError('本机设置无效')
        with self.assertRaisesRegex(ValueError,'本机设置无效'):self.workspace.run('settings',{})
        self.sweep.status.side_effect=DeviceError(500,{})
        with self.assertRaisesRegex(ValueError,'操作失败'):self.workspace.run('status')

    def test_login_opens_only_the_official_device_page_and_returns_no_secret(self):
        with patch('webbrowser.open') as browser, patch.object(self.workspace,'local') as local:
            for bad in ['https://evil.example/device?x','https://mxd.ruit.me/account?link=x','https://mxd.ruit.me.evil/device?x',None]:
                local.return_value={'url':bad}
                with self.assertRaises(ValueError):self.workspace.run('login')
            browser.assert_not_called()
            local.return_value={'url':'https://mxd.ruit.me/device?redirect_uri=x&state=s&challenge=c&name=PC'}
            self.assertEqual(self.workspace.run('login'),{'opened':True})
            local.assert_called_with('/api/v1/device/login',{})
            browser.assert_called_once_with(local.return_value['url'])

    def test_page_uses_only_trusted_local_routes(self):
        (self.workspace.runtime.home/'dashboard.json').write_text('{"url":"http://127.0.0.1:8780/alerts"}')
        self.assertEqual(self.workspace.run('page',{'page':'watch'})['url'],'http://127.0.0.1:8780/watch?lang=zh&theme=light')
        with self.assertRaises(ValueError):self.workspace.run('page',{'page':'https://example.com'})
        (self.workspace.runtime.home/'dashboard.json').write_text('{"url":"https://example.com/alerts"}')
        with self.assertRaises(ValueError):self.workspace.run('page',{'page':'prices'})

    def test_catalog_and_no_arbitrary_command(self):
        self.workspace.gateway.fetch.return_value={'items':[]}
        self.assertEqual(self.workspace.run('catalog'),{'items':[]})
        self.workspace.gateway.fetch.assert_called_with('/api/v1/watchlist/catalog',300,timeout=8)
        for action in ('shell','save','simulate'):
            with self.assertRaises(ValueError):self.workspace.run(action,'anything')

if __name__=='__main__':unittest.main()
