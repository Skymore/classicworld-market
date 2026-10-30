import tempfile
import json
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from scanner_desktop import DesktopAPI, DesktopController, purchase_text, status_text
import collector_dashboard


class DashboardReadinessTests(unittest.TestCase):
    def test_readiness_retries_parent_read_handle_on_windows(self):
        server = Mock(server_port=8780)
        original = Path.replace
        attempts = []
        def replace(path, target):
            attempts.append(path)
            if len(attempts) < 3:
                raise PermissionError('reader briefly holds file')
            return original(path, target)
        with tempfile.TemporaryDirectory() as folder, patch.object(collector_dashboard, 'create_server', return_value=server), patch.object(Path, 'replace', new=replace):
            collector_dashboard.run(folder, {}, folder, instance='synthetic')
            self.assertEqual(json.loads((Path(folder)/'dashboard.json').read_text())['instance'], 'synthetic')
        self.assertEqual(len(attempts), 3)
        server.serve_forever.assert_called_once()
        server.server_close.assert_called_once()

    def test_persistent_readiness_failure_closes_socket(self):
        server = Mock(server_port=8780)
        with tempfile.TemporaryDirectory() as folder, patch.object(collector_dashboard, 'create_server', return_value=server), patch.object(Path, 'replace', side_effect=PermissionError('locked')), patch.object(collector_dashboard.time, 'monotonic', side_effect=[0, 4]):
            with self.assertRaises(PermissionError): collector_dashboard.run(folder, {}, folder)
        server.server_close.assert_called_once()
        server.serve_forever.assert_not_called()


class DesktopTests(unittest.TestCase):
    def test_capture_failure_keeps_window_open_with_error(self):
        self.runtime.error='synthetic capture failure'
        self.runtime.stopped.return_value=True
        original_get=self.controller._events.get
        def finish_one_iteration(*args,**kwargs):
            self.controller._closed.set()
            return original_get(*args,**kwargs)
        with patch.object(self.controller,'close') as close, \
             patch.object(self.controller._events,'get',side_effect=finish_one_iteration):
            self.controller.pump()
        close.assert_not_called()
        self.assertEqual(self.controller.snapshot()['capture'],'offline')
        self.assertTrue(self.controller._stop.is_set())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Mock(home=Path(self.temp.name), folder=Path(self.temp.name)/'captures', error=None)
        self.runtime.stopped.return_value = False
        self.modules = {'LeaseStopEvent': threading.Event, 'clear_pause': Mock(), 'request_pause': Mock(), 'is_paused': Mock(return_value=False)}
        self.controller = DesktopController(self.runtime, modules=self.modules,
            windows=lambda: [{'id': 12, 'title': 'MapleStory', 'pid': 42}], ready=lambda _:True, emergency=lambda:False)

    def test_theme_persists_and_snapshot_has_no_credentials(self):
        self.controller.command('theme', 'dark')
        other = DesktopController(self.runtime, modules=self.modules, windows=lambda: [])
        self.assertEqual(other.snapshot()['theme'], 'dark')
        self.assertNotIn('config', other.snapshot())
        with self.assertRaises(ValueError): self.controller.command('theme', 'javascript:bad')
        with self.assertRaises(ValueError): self.controller.command('run', 'anything')

    def test_window_controls_do_not_stop_manual_capture(self):
        window = Mock()
        self.controller._window = window
        self.controller.command('window', 'minimize')
        window.minimize.assert_called_once()
        self.assertTrue(self.controller.command('window', 'maximize')['maximized'])
        window.maximize.assert_called_once()
        self.assertFalse(self.controller.command('window', 'maximize')['maximized'])
        window.restore.assert_called_once()
        self.runtime.close.assert_not_called()
        with self.assertRaises(ValueError): self.controller.command('window', 'anything')
        # The corner grip resizes, never below the designed minimum and not while maximized.
        self.controller._window = Mock()
        self.controller.command('window', {'resize': [1200, 500]})
        self.controller._window.resize.assert_called_once_with(1200, 740)
        for bad in ({'resize': [1200]}, {'resize': ['1200', 900]}, {'resize': [1200, 900], 'x': 1}):
            with self.assertRaises(ValueError): self.controller.command('window', bad)
        self.controller._change(maximized=True)
        self.controller.command('window', {'resize': [1300, 900]})
        self.controller._window.resize.assert_called_once()

    def test_invalid_game_window_cannot_start_input(self):
        with patch('scanner_desktop.focus_game') as focus:
            for hwnd in [None, '12', 13, True]:
                with self.assertRaises(ValueError): self.controller.start(hwnd)
            focus.assert_not_called()

    def test_events_update_quotes_without_network_reads(self):
        self.controller._collector_event({'type': 'uploaded', 'count': 7})
        self.controller._collector_event({'type': 'upload_error'})
        self.assertEqual(self.controller.snapshot()['uploaded'], 7)
        self.assertEqual(self.controller.snapshot()['upload'], 'retrying')
        self.controller._collector_event({'type': 'uploaded', 'count': 2})
        self.assertEqual(self.controller.snapshot()['uploaded'], 9)
        self.assertEqual(self.controller.snapshot()['upload'], 'ready')

    def test_scan_releases_task_without_stopping_manual_capture(self):
        lease = Mock()
        started = threading.Event()
        def run(folder, hwnd, begin, stop, callback, assignments):
            started.set()
            callback('full_scanning_room_8_channel_12')
            callback(('progress', {'channel': 12, 'visited': 3}))
            stop.wait(2)
            return {'reason': 'cancelled'}
        self.modules.update({'channel_capture': lambda path, stop: stop.wait(2), 'position_capture': lambda path, stop: stop.wait(2),
                             'DEFAULT_STATE': None, 'POSITION_STATE': None, 'CloudScan': Mock(return_value=lease), 'run': run})
        with patch('scanner_desktop.focus_game'), patch('scanner_desktop.release_keys'), patch('scanner_desktop.RUNS', Path(self.temp.name)/'runs'):
            self.controller._change(run_shops=12,run_items=90)
            self.controller.start(12)
            self.assertTrue(started.wait(2))
            self.controller.command('pause')
            self.assertEqual(self.controller.snapshot()['phase'], 'paused')
            self.controller.command('resume')
            self.assertEqual(self.controller.snapshot()['phase'], 'rebuilding')
            self.controller.command('stop')
            self.controller._worker.join(3)
        self.assertFalse(self.controller._worker.is_alive())
        lease.close.assert_called_once()
        self.runtime.close.assert_not_called()
        self.assertEqual(self.controller.snapshot()['room'], 8)
        self.assertEqual(self.controller.snapshot()['phase'], 'stopped')
        self.assertEqual(self.controller.snapshot()['run_shops'],12)
        self.assertEqual(self.controller.snapshot()['run_items'],90)

    def test_purchase_halt_revokes_auto_recovery_across_relaunch(self):
        from sweep_purchase import PurchaseHalt, PurchaseResult
        from collector_recovery import ScanIntent
        calls=[]
        def run(*args, **kwargs):
            calls.append(1)
            try:
                raise PurchaseHalt(PurchaseResult('unknown', reason='timeout'))
            except PurchaseHalt as error:
                raise RuntimeError('shop callback stopped') from error
        self.modules.update(channel_capture=lambda path,stop:stop.wait(2),
            position_capture=lambda path,stop:stop.wait(2), DEFAULT_STATE=None, POSITION_STATE=None,
            CloudScan=Mock(return_value=Mock()),run=run)
        with patch('scanner_desktop.focus_game'), patch('scanner_desktop.release_keys'), \
             patch('scanner_desktop.RUNS',Path(self.temp.name)/'runs'):
            self.controller.start(12)
            self.controller._worker.join(3)
        self.assertEqual(calls,[1])
        self.assertFalse(self.controller._worker.is_alive())
        self.assertFalse(self.controller._desired)
        self.assertFalse(ScanIntent(self.runtime.home).load()['enabled'])

    def test_sweep_hooks_reach_the_scan_and_status_line(self):
        sweep = Mock()
        sweep.lock = threading.RLock()
        sweep.buying.return_value = False
        sweep.summary.return_value = {'enabled': True, 'units': 2, 'spent': 300, 'message': '扫货中'}
        controller = DesktopController(self.runtime, modules=self.modules, windows=lambda: [{'id': 12, 'title': 'MapleStory', 'pid': 42}], sweep=sweep, ready=lambda _:True, emergency=lambda:False)
        hooks = {}
        def run(folder, hwnd, begin, stop, callback, assignments, **kwargs):
            hooks.update(kwargs)
            controller.command('stop')
            return {'reason': 'cancelled'}
        self.modules.update({'channel_capture': lambda path, stop: stop.wait(2), 'position_capture': lambda path, stop: stop.wait(2),
                             'DEFAULT_STATE': None, 'POSITION_STATE': None, 'CloudScan': Mock(), 'run': run})
        with patch('scanner_desktop.focus_game'), patch('scanner_desktop.release_keys'), patch('scanner_desktop.RUNS', Path(self.temp.name)/'runs'):
            controller.start(12)
            controller._worker.join(3)
        self.assertIs(hooks['shop_callback'], sweep.on_shop_open)
        self.assertIs(hooks['capture_receipt'], sweep.receipt)
        controller.read_local_status()
        self.assertEqual(controller.snapshot()['sweep'], sweep.summary.return_value)
        self.assertIs(DesktopAPI(controller)._workspace.sweep, sweep)

    def test_new_web_sweep_starts_once_and_does_not_undo_manual_stop(self):
        sweep = Mock(lock=threading.RLock(), run={'id':'new-run'})
        sweep.buying.return_value = True
        sweep.scan_mode.return_value = 'recent'
        self.controller.sweep = sweep
        # release_keys imports market_keyboard, which needs ctypes.WinDLL.
        with patch.object(self.controller, 'start') as start, patch('scanner_desktop.release_keys'):
            self.controller.sync_sweep()
            self.controller.sync_sweep()
            start.assert_called_once_with(12)
            self.controller.command('stop')
            self.controller.sync_sweep()
            start.assert_called_once_with(12)

    def test_purchases_are_added_to_the_activity_list(self):
        sweep = Mock(lock=threading.RLock())
        controller = DesktopController(self.runtime, modules=self.modules, windows=lambda: [], sweep=sweep)
        notify = sweep.add_listener.call_args.args[0]
        entry = dict(name='红色药水', item_id=2000000, units=100, quantity=100, price=41, room=3, channel=12, owner='COSTCO')
        notify(entry)
        notify(entry)  # The same listing bought twice is two rows.
        rows = controller.snapshot()['activities']
        self.assertEqual([(r['text'], r['kind']) for r in rows[:2]], [('买到 红色药水 ×100 @41 · 3 洞 12 频道 COSTCO', 'sweep')]*2)
        self.assertEqual(purchase_text(dict(name='弯刀', units=1, price=9000, room=None, channel=None, owner=None)), '买到 弯刀 ×1 @9,000')
        for i in range(60):
            controller._activity(f'步骤 {i}')
        self.assertEqual(len(controller.snapshot()['activities']), 40)

    def test_internal_event_names_do_not_leak_into_ui(self):
        self.assertEqual(status_text('full_scanning_room_8_channel_12'), '正在扫描 8 洞 · 12频道')
        self.assertIsNone(status_text('unknown_internal_event'))
        self.assertEqual(status_text('已领到 8 洞'), '已领到 8 洞')
