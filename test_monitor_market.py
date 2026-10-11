import unittest
from unittest.mock import patch
from pathlib import Path
from monitor_market import parse_connections, no_filters, Capture


class MonitorTests(unittest.TestCase):
    def test_process_and_ipv6_filtering(self):
        endpoints, records = parse_connections('''TCP 10.0.0.2:5000 1.2.3.4:8550 ESTABLISHED 10
TCP [::1]:5001 [2001:db8::1]:443 SYN_SENT 10
TCP 10.0.0.2:5002 8.8.8.8:443 ESTABLISHED 20
TCP 0.0.0.0:9000 0.0.0.0:0 LISTENING 10''', {10})
        self.assertEqual(endpoints, {('1.2.3.4', 8550), ('2001:db8::1', 443)})
        self.assertEqual(len(records), 2)

    def test_empty_filter_detection(self):
        self.assertTrue(no_filters('Packet Filters:\n    None'))
        self.assertFalse(no_filters('Packet Filters:\n 1 SomeOtherFilter TCP'))

    @patch('monitor_market.command')
    def test_refuses_existing_session_without_mutation(self, command):
        command.side_effect = ['Packet Filters:\n None', 'Packet capture is running.']
        capture = Capture(Path('.'), lambda *a, **kw: None)
        with self.assertRaises(RuntimeError):
            capture.start({('1.2.3.4',8550)})
        capture.finish()
        self.assertEqual(command.call_count, 2)

    @patch('monitor_market.command')
    def test_failed_start_cleans_only_owned_filters(self, command):
        command.side_effect = ['Packet Filters:\n None', 'Stopped', '', RuntimeError('start failed'), '']
        capture = Capture(Path('nonexistent-test-output'), lambda *a, **kw: None)
        with self.assertRaises(RuntimeError):
            capture.start({('1.2.3.4',8550)})
        capture.finish()
        self.assertEqual(command.call_args.args, ('pktmon.exe','filter','remove'))
        self.assertFalse(any(c.args == ('pktmon.exe','stop') for c in command.call_args_list))


if __name__ == '__main__':
    unittest.main()
