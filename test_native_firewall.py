import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from native_firewall import ensure_capture_firewall
from market_passive import capture_health


class FirewallTests(unittest.TestCase):
    def test_rule_setup_passes_executable_as_data_and_checks_result(self):
        output=json.dumps({'state':'existing','rule':'test','protocol':'TCP','remote_ports':'8500-8999'}).encode()
        with patch('native_firewall.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=output)) as run:
            status=ensure_capture_firewall()
        self.assertEqual(status['state'],'existing')
        args,kwargs=run.call_args
        self.assertNotIn(kwargs['env']['CLASSICWORLD_CAPTURE_EXE'],args[0][-1])
        self.assertNotIn('shell',kwargs)

    def test_policy_failure_does_not_report_success(self):
        with patch('native_firewall.subprocess.run',return_value=SimpleNamespace(returncode=1,stderr=b'policy denied')):
            with self.assertRaisesRegex(RuntimeError,'Firewall setup failed'):ensure_capture_firewall()

    def test_unexpected_response_and_timeout_fail_closed(self):
        with patch('native_firewall.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=b'{}')):
            with self.assertRaisesRegex(RuntimeError,'Could not verify'):ensure_capture_firewall()
        with patch('native_firewall.subprocess.run',side_effect=subprocess.TimeoutExpired('powershell',40)):
            with self.assertRaisesRegex(RuntimeError,'timed out'):ensure_capture_firewall()


class HealthTests(unittest.TestCase):
    def test_process_alive_is_not_mistaken_for_working_capture(self):
        collector=SimpleNamespace(flows={},captured=0,last_shop_at=None)
        self.assertEqual(capture_health(collector,False,30)[0],'no_game')
        self.assertEqual(capture_health(collector,True,30)[0],'no_inbound')
        collector.captured=1
        self.assertEqual(capture_health(collector,True,30)[0],'handshake')
        collector.flows={'test':{'decoder':SimpleNamespace(iv=b'1234'),'failed':False}}
        self.assertEqual(capture_health(collector,True,30)[0],'connected')
        collector.last_shop_at=123
        self.assertEqual(capture_health(collector,True,30)[0],'capturing')
        collector.flows['test']['failed']=True
        self.assertEqual(capture_health(collector,True,30)[0],'parse_error')
