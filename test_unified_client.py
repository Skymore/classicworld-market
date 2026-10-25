import argparse
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import io
import contextlib
from pathlib import Path
from unittest.mock import patch
from unified_client import CollectorRuntime
from build_unified_client import modules

class UnifiedTests(unittest.TestCase):
    def test_capture_failure_keeps_traceback_in_runtime_log(self):
        with tempfile.TemporaryDirectory() as folder:
            options=argparse.Namespace(home=Path(folder),config=None,folder=None,
                backend='windows',no_update=True)
            with patch('threading.Thread.start'):
                runtime=CollectorRuntime(options,[])
            output=io.StringIO()
            with patch('shared_client.ensure_identity',return_value={}), \
                 patch('shared_client.main',side_effect=PermissionError('synthetic locked status')), \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                runtime._run()
            self.assertEqual(runtime.error,'synthetic locked status')
            self.assertIn('collector_runtime_failed',output.getvalue())
            self.assertIn('Traceback',output.getvalue())
            self.assertIn('PermissionError',output.getvalue())

    @unittest.skipUnless(os.name == 'nt', 'Windows windowed launcher')
    def test_windowed_diagnostics_preserve_old_updater_pipes(self):
        code = ('import sys; sys.stdin = sys.stdout = sys.stderr = None; '
                'from unified_client import prepare_standard_streams; '
                'prepare_standard_streams(); '
                'print("diagnostic output", flush=True); '
                'print("diagnostic error", file=sys.stderr, flush=True)')
        result = subprocess.run([sys.executable, '-c', code], capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), b'diagnostic output')
        self.assertEqual(result.stderr.strip(), b'diagnostic error')

    def test_existing_identity_paths_and_update_arguments_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder)/'existing'
            options=argparse.Namespace(home=home,config=Path(folder)/'owner.json',
                folder=Path(folder)/'captures',backend='windows',no_update=True)
            launch=['--home',str(home),'--auto-start']
            with patch('threading.Thread.start'):
                runtime=CollectorRuntime(options,launch)
            with patch('shared_client.ensure_identity',return_value={'token':'existing'}) as identity, \
                 patch('shared_client.main') as capture:
                runtime._run()
            identity.assert_called_once_with(options.config)
            self.assertEqual(capture.call_args.kwargs['update_argv'],launch)
            self.assertIs(capture.call_args.kwargs['stop_event'],runtime.stop_event)
            self.assertIn(str(options.folder),capture.call_args.args[0])
            self.assertIn('--no-update',capture.call_args.args[0])

    def test_collector_and_scanner_runtime_modules_do_not_collide(self):
        root=Path(__file__).resolve().parent
        self.assertTrue((root/'scanner/market_screen_scanner/scanner_gui.py').is_file())
        self.assertFalse(modules(root,['shared_client']) & modules(root/'scanner',['market_screen_scanner.scanner_gui']))
