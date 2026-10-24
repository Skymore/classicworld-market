import argparse
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from unified_client import CollectorRuntime
from build_unified_client import modules

class UnifiedTests(unittest.TestCase):
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
