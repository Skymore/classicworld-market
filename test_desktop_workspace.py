import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from desktop_workspace import DesktopWorkspace


class DesktopWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.workspace=DesktopWorkspace(Mock(home=Path(self.temp.name),folder=Path(self.temp.name)))
        self.workspace.gateway=Mock(last_error=False)
        self.workspace.local=Mock(return_value={'mode':'simulate','enabled':False})

    def test_rules_are_loaded_from_current_account_not_frontend_payload(self):
        group=dict(id='one',buy=True,cap=123,notify=False,reminder={})
        records=[dict(kind='watch',key='1002000',value=dict(groups=[group],buyLimit=2)),dict(kind='pref',key='watch.sweepSettings',value='{"budget":500}')]
        self.workspace.gateway.fetch.side_effect=[{'revision':'v1'},{'linked':True,'public_id':'owner','records':records},{'items':[{'item_id':1002000,'name_zh':'Hat'}]},{'base_stats':{'1002000':[['str',1]]}},{'linked':True,'public_id':'owner','records':records}]
        self.workspace.run('start',{'account':'owner','watches':[{'cap':99999}],'mode':'real'})
        sent=self.workspace.local.call_args_list[0].args[0]
        self.assertEqual(sent['mode'],'simulate');self.assertEqual(sent['watches'][0]['groups'][0]['cap'],123)
        self.assertEqual(sent['expected_revision'],'v1');self.assertEqual(sent['watches'][0]['base_stats'],[['str',1]])

    def test_account_switch_prevents_start(self):
        self.workspace.gateway.fetch.side_effect=[{'revision':'v2'},{'linked':True,'public_id':'other','records':[]}]
        with self.assertRaises(ValueError):self.workspace.run('start',{'account':'old'})
        self.workspace.local.assert_not_called()

    def test_login_never_opens_untrusted_url_or_returns_token(self):
        self.workspace.gateway.update.return_value={'url':'https://evil.example/account?link=x'}
        with patch('webbrowser.open') as browser:
            with self.assertRaises(ValueError):self.workspace.run('login')
            browser.assert_not_called()
            self.workspace.gateway.update.return_value={'url':'https://mxd.ruit.me/account?link=synthetic'}
            self.assertEqual(self.workspace.run('login'),{'opened':True})

    def test_save_stops_simulation_and_preserves_version(self):
        self.workspace.gateway.fetch.return_value={'linked':True,'public_id':'owner','records':[]}
        change={'account':'owner','operations':[{'kind':'watch','key':'1002000','version':3,'value':None}]}
        self.workspace.run('save',change)
        self.workspace.local.assert_any_call({'action':'stop'})
        self.workspace.gateway.update.assert_called_once_with('/api/v1/collector/watch-data',change)

    def test_no_arbitrary_command(self):
        with self.assertRaises(ValueError):self.workspace.run('shell','anything')

if __name__=='__main__':unittest.main()
