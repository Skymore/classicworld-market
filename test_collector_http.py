import socket
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

from collector_http import network_diagnostic, request_json


class RequestTests(unittest.TestCase):
    def test_reply_arriving_at_process_exit_is_consumed(self):
        parent, child, process = Mock(), Mock(), Mock()
        parent.poll.side_effect = [False, True]
        parent.recv.return_value = ('ok', {'ttl_seconds': 30})
        process.is_alive.return_value = False
        process.exitcode = 0
        process.pid = 123
        context = Mock()
        context.Pipe.return_value = (parent, child)
        context.Process.return_value = process
        with patch('collector_http.multiprocessing.get_context', return_value=context):
            self.assertEqual(request_json('unused', {}, {}), {'ttl_seconds': 30})
        process.terminate.assert_not_called()

    def test_early_worker_exit_reports_exit_code_and_stage(self):
        parent, child, process = Mock(), Mock(), Mock()
        parent.poll.return_value = False
        process.is_alive.return_value = False
        process.exitcode = 7
        process.pid = 123
        context = Mock()
        context.Pipe.return_value = (parent, child)
        context.Process.return_value = process
        with patch('collector_http.multiprocessing.get_context', return_value=context):
            with self.assertRaises(ConnectionError) as caught:
                request_json('unused', {}, {})
        self.assertEqual(caught.exception.request_diagnostic['worker_exitcode'], 7)
        self.assertEqual(caught.exception.request_diagnostic['stage'], 'await_response')

    def test_native_network_reason_is_retained_without_private_text(self):
        cause = socket.gaierror(11001, 'private-host?token=secret')
        detail = network_diagnostic(URLError(cause))
        self.assertEqual(detail, {'type': 'URLError', 'cause': 'gaierror', 'errno': 11001})
        self.assertNotIn('secret', str(detail))
        self.assertEqual(network_diagnostic(URLError(TimeoutError('secret')))['cause'], 'TimeoutError')


if __name__ == '__main__':
    unittest.main()
