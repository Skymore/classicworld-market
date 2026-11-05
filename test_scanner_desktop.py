import tempfile
import json
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from scanner_desktop import DesktopAPI, DesktopController, desktop_entry_url, purchase_text, status_text
import collector_dashboard
import scanner_desktop


class FocusGameTests(unittest.TestCase):
    def setUp(self):
        self.hwnd = 0x123456789
        self.user = Mock()
        self.kernel = Mock()
        self.user.GetForegroundWindow.return_value = 99
        self.user.IsIconic.return_value = False
        self.user.IsHungAppWindow.return_value = False
        self.user.GetWindowThreadProcessId.side_effect = lambda hwnd, _: {99: 2, self.hwnd: 3}[hwnd]
        self.kernel.GetCurrentThreadId.return_value = 1
        self.user.AttachThreadInput.return_value = True
        for target, value in [('scanner_desktop.ctypes.windll', SimpleNamespace(user32=self.user, kernel32=self.kernel)),
                              ('scanner_desktop.game_windows', Mock(return_value=[{'id': self.hwnd}]))]:
            patcher = patch(target, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def focus(self, **kwargs):
        from scanner_desktop import focus_game
        return focus_game(self.hwnd, **kwargs)

    def test_fallback_verifies_actual_foreground_and_detaches_queues(self):
        from unittest.mock import call
        def activate(hwnd):
            if self.user.SetForegroundWindow.call_count == 2:
                self.user.GetForegroundWindow.return_value = hwnd
            return True  # The first API success is deliberately not sufficient.
        self.user.SetForegroundWindow.side_effect = activate
        self.assertTrue(self.focus())
        self.assertEqual(self.user.AttachThreadInput.call_args_list,
                         [call(1, 2, True), call(1, 3, True), call(1, 3, False), call(1, 2, False)])
        self.user.SetForegroundWindow.assert_called_with(self.hwnd)

    def test_refused_activation_is_not_reported_as_success(self):
        self.assertFalse(self.focus())
        self.assertEqual(self.user.SetForegroundWindow.call_count, 2)

    def test_minimized_restore_and_already_foreground_noop(self):
        self.user.IsIconic.return_value = True
        self.assertFalse(self.focus())
        self.user.ShowWindowAsync.assert_called_once_with(self.hwnd, 9)
        self.user.reset_mock()
        self.user.IsIconic.return_value = False
        self.user.GetForegroundWindow.return_value = self.hwnd
        self.assertTrue(self.focus())
        self.user.SetForegroundWindow.assert_not_called()
        self.user.AttachThreadInput.assert_not_called()

    def test_stop_during_fallback_detaches_without_more_activation(self):
        allowed = Mock(return_value=True)
        def attach(*args):
            allowed.return_value = False
            return True
        self.user.AttachThreadInput.side_effect = attach
        self.assertFalse(self.focus(allowed=allowed))
        self.user.SetForegroundWindow.assert_called_once()
        self.user.BringWindowToTop.assert_not_called()
        self.user.AttachThreadInput.assert_called_with(1, 2, False)

    def test_exception_detaches_only_successfully_attached_threads(self):
        from unittest.mock import call
        self.user.AttachThreadInput.side_effect = lambda current, target, attach: target != 2
        self.user.BringWindowToTop.side_effect = OSError('window closed')
        with self.assertRaises(OSError):
            self.focus()
        self.assertEqual(self.user.AttachThreadInput.call_args_list,
                         [call(1, 2, True), call(1, 3, True), call(1, 3, False)])

    def test_foreign_window_stopped_intent_and_hung_game_are_untouched(self):
        with patch('scanner_desktop.game_windows', return_value=[]):
            self.assertFalse(self.focus())
        self.assertFalse(self.focus(allowed=lambda: False))
        self.user.IsHungAppWindow.return_value = True
        self.assertFalse(self.focus())
        self.user.SetForegroundWindow.assert_not_called()
        self.user.ShowWindowAsync.assert_not_called()


class DesktopEntryTests(unittest.TestCase):
    def test_entry_revision_changes_with_ui_without_changing_profile_origin(self):
        from urllib.parse import urlsplit
        from webview.window import Window
        with tempfile.TemporaryDirectory(prefix='desktop ui ') as folder:
            path = Path(folder) / 'index.html'
            path.write_text('<script src="assets/old.js"></script>')
            previous = desktop_entry_url(path)
            self.assertEqual(previous, desktop_entry_url(path))
            path.write_text('<script src="assets/new.js"></script>')
            current = desktop_entry_url(path)
            self.assertNotEqual(previous, current)
            window = Window('test', 'test', current)
            window._url_prefix = 'http://127.0.0.1:42001/'
            window._common_path = folder
            resolved = urlsplit(window._resolve_url(current))
            self.assertEqual(resolved.netloc, '127.0.0.1:42001')
            self.assertEqual(resolved.path, '/index.html')
            self.assertTrue(resolved.query.startswith('ui='))


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
        self.runtime = Mock(home=Path(self.temp.name), folder=Path(self.temp.name)/'captures', error=None, diagnostics=None, remote_debug=None)
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
        def run(folder, hwnd, begin, stop, callback, assignments, ready_callback):
            self.assertTrue(callable(ready_callback))
            started.set()
            callback('full_scanning_room_8_channel_12')
            callback(('progress', {'channel': 12, 'visited': 3}))
            stop.wait(2)
            return {'reason': 'cancelled'}
        self.modules.update({'channel_capture': lambda path, stop, ready_event: (ready_event.set(), stop.wait(2)), 'position_capture': lambda path, stop, ready_event: (ready_event.set(), stop.wait(2)),
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

    def test_undersized_client_waits_without_claiming_a_room(self):
        small = threading.Event()
        small.set()
        started = threading.Event()
        def run(folder, hwnd, begin, stop, callback, assignments, ready_callback):
            started.set()
            stop.wait(2)
            return {'reason': 'cancelled'}
        cloud = Mock(return_value=Mock())
        self.modules.update(channel_capture=lambda path, stop, ready_event: (ready_event.set(), stop.wait(2)),
            position_capture=lambda path, stop, ready_event: (ready_event.set(), stop.wait(2)),
            DEFAULT_STATE=None, POSITION_STATE=None, CloudScan=cloud, run=run)
        controller = DesktopController(self.runtime, modules=self.modules,
            windows=lambda: [{'id': 12, 'title': 'MapleStory', 'pid': 42}], ready=lambda _: True,
            emergency=lambda: False, too_small=lambda _: small.is_set())
        with patch('scanner_desktop.focus_game'), patch('scanner_desktop.release_keys'), \
             patch('scanner_desktop.RUNS', Path(self.temp.name)/'runs'):
            controller.start(12)
            time.sleep(.5)
            self.assertFalse(started.is_set())
            cloud.assert_not_called()
            self.assertEqual(controller.snapshot()['phase'], 'waiting_game')
            self.assertIn('1024×600', controller.snapshot()['message'])
            small.clear()
            self.assertTrue(started.wait(2))
            controller.command('stop')
            controller._worker.join(3)
        self.assertFalse(controller._worker.is_alive())

    def test_client_size_limit_matches_scanner(self):
        import re
        source = (Path(__file__).parent/'scanner'/'market_browser_bot.py').read_text(encoding='utf-8')
        limit = re.search(r'^MIN_CLIENT_SIZE = \((\d+), (\d+)\)', source, re.M)
        self.assertEqual(tuple(map(int, limit.groups())), scanner_desktop.MIN_CLIENT_SIZE)

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
        self.modules.update(channel_capture=lambda path,stop,ready_event:(ready_event.set(),stop.wait(2)),
            position_capture=lambda path,stop,ready_event:(ready_event.set(),stop.wait(2)), DEFAULT_STATE=None, POSITION_STATE=None,
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
        sweep.next_live_target.return_value = []
        sweep.lock = threading.RLock()
        sweep.buying.return_value = False
        sweep.summary.return_value = {'enabled': True, 'units': 2, 'spent': 300, 'message': '扫货中'}
        controller = DesktopController(self.runtime, modules=self.modules, windows=lambda: [{'id': 12, 'title': 'MapleStory', 'pid': 42}], sweep=sweep, ready=lambda _:True, emergency=lambda:False)
        hooks = {}
        def run(folder, hwnd, begin, stop, callback, assignments, **kwargs):
            hooks.update(kwargs)
            controller.command('stop')
            return {'reason': 'cancelled'}
        self.modules.update({'channel_capture': lambda path, stop, ready_event: (ready_event.set(), stop.wait(2)), 'position_capture': lambda path, stop, ready_event: (ready_event.set(), stop.wait(2)),
                             'DEFAULT_STATE': None, 'POSITION_STATE': None, 'CloudScan': Mock(), 'run': run})
        with patch('scanner_desktop.focus_game'), patch('scanner_desktop.release_keys'), patch('scanner_desktop.RUNS', Path(self.temp.name)/'runs'):
            controller.start(12)
            controller._worker.join(3)
        self.assertIs(hooks['shop_callback'].requires_window, sweep.buying)
        hooks['shop_callback']('capture','window')
        sweep.on_shop_open.assert_called_once_with('capture','window')
        self.assertIs(hooks['capture_receipt'], sweep.receipt)
        controller.read_local_status()
        self.assertEqual(controller.snapshot()['sweep'], sweep.summary.return_value)
        self.assertIs(DesktopAPI(controller)._workspace.sweep, sweep)

    def test_live_target_handoff_releases_lease_and_reuses_checkpoint_without_restarting_capture(self):
        from scan_progress import AssignedProgress
        sweep = Mock()
        sweep.buying.return_value=True
        sweep.scan_mode.return_value='market'
        self.controller.sweep=sweep
        pending, events, checkpoints=[],[],[]
        sweep.next_live_target.side_effect=lambda:list(pending)
        sweep.complete_live_target.side_effect=lambda shops:pending.clear()
        def factory(*args,**kw):
            checkpoints.append(kw['progress'])
            return Mock(close=lambda:events.append('release'))
        stop=threading.Event()
        def run(folder,hwnd,ready,cancel,status,**kw):
            if 'assignments' in kw:
                events.append('ordinary')
                if events.count('ordinary')==1:
                    pending.append(dict(room=3,channel=9,owner='A',offers=[]))
                    kw['safe_checkpoint']()
                stop.set()
                return dict(reason='cancelled')
            events.append('target')
            self.assertEqual(events[-2],'release')
            kw['progress'].begin(3,9,1)
            kw['progress'].save(3,10,1,phase='pending')
        self.modules.update(channel_capture=lambda path,cancel,ready_event:(ready_event.set(),cancel.wait(5)),
            position_capture=lambda path,cancel,ready_event:(ready_event.set(),cancel.wait(5)),
            DEFAULT_STATE=None,POSITION_STATE=None,CloudScan=factory,AssignedProgress=AssignedProgress,run=run)
        with patch('scanner_desktop.release_keys'),patch('scanner_desktop.RUNS',Path(self.temp.name)/'runs'):
            failure,clean=self.controller._attempt(stop)
        self.assertEqual(str(failure),'Scan worker returned without completing service')
        self.assertTrue(clean)
        self.assertEqual(events,['ordinary','release','target','ordinary','release'])
        self.assertIs(checkpoints[0],checkpoints[1])

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

    def test_handled_sweep_run_is_not_restarted_after_update_or_reopen(self):
        sweep = Mock(lock=threading.RLock(), run={'id':'run-1'})
        sweep.buying.return_value = True
        sweep.scan_mode.return_value = 'recent'
        self.controller.sweep = sweep
        with patch.object(self.controller, 'start'), patch('scanner_desktop.release_keys'):
            self.controller.sync_sweep()  # Accepted on the website: starts once.
            self.controller.command('stop')  # The player's Stop/F9 during the run.
        # A new process (after an update or a manual reopen) sees the same run.
        fresh = DesktopController(self.runtime, modules=self.modules, sweep=sweep,
            windows=lambda: [{'id': 12, 'title': 'MapleStory', 'pid': 42}], ready=lambda _:True, emergency=lambda:False)
        with patch.object(fresh, 'start') as start:
            fresh.sync_sweep()
            start.assert_not_called()
            sweep.run = {'id':'run-2'}  # A genuinely new run still starts.
            fresh.sync_sweep()
            start.assert_called_once_with(12)
        reopened = DesktopController(self.runtime, modules=self.modules, sweep=sweep,
            windows=lambda: [{'id': 12, 'title': 'MapleStory', 'pid': 42}], ready=lambda _:True, emergency=lambda:False)
        with patch.object(reopened, 'start') as start:
            reopened.sync_sweep()
            start.assert_not_called()

    def test_capture_warning_is_shown_only_while_capture_status_is_fresh(self):
        self.runtime.folder.mkdir(parents=True)
        status = self.runtime.folder/'passive_status.json'
        status.write_text(json.dumps({'time': time.time(), 'health_state': 'capturing', 'capture_warning': '加速器连接不可用'}))
        self.controller.read_local_status()
        self.assertEqual(self.controller.snapshot()['capture_warning'], '加速器连接不可用')
        status.write_text(json.dumps({'time': time.time(), 'health_state': 'capturing'}))
        self.controller.read_local_status()
        self.assertIsNone(self.controller.snapshot()['capture_warning'])
        status.write_text(json.dumps({'time': time.time()-60, 'capture_warning': '加速器连接不可用'}))
        self.controller.read_local_status()
        self.assertIsNone(self.controller.snapshot()['capture_warning'])

    def test_rejected_upload_message_states_the_retry_limit(self):
        self.controller._collector_event({'type': 'upload_rejected', 'reason': 'bad_request'})
        text = self.controller.snapshot()['activities'][0]['text']
        self.assertIn('最多尝试 3 次', text)
        self.assertNotIn('自动重试', text)

    def test_watchdog_crash_loop_reason_is_shown_once(self):
        from collector_watchdog import STOP_NOTICE
        (self.runtime.home/STOP_NOTICE).write_text(json.dumps({'reason': 'crash_loop', 'exit_code': 7}))
        self.controller._show_watchdog_stop()
        state = self.controller.snapshot()
        self.assertEqual(state['phase'], 'error')
        self.assertIn('多次异常退出', state['message'])
        self.assertEqual(state['activities'][0]['kind'], 'error')
        self.assertFalse((self.runtime.home/STOP_NOTICE).exists())
        other = DesktopController(self.runtime, modules=self.modules, windows=lambda: [])
        other._show_watchdog_stop()
        self.assertEqual(other.snapshot()['phase'], 'idle')

    def test_accepted_sweep_preserves_saved_scan_session_on_startup(self):
        sweep = Mock(lock=threading.RLock(), run={'id':'resumed-run'})
        sweep.buying.return_value = True
        sweep.scan_mode.return_value = 'market'
        self.controller.sweep = sweep
        self.controller._intent.start(12, 'saved-session')
        with patch.object(self.controller, 'start') as start:
            self.controller.sync_sweep()
            start.assert_called_once_with(12, restore=True)

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
