"""Fault injection without game input, real credentials or production writes."""
import json
import multiprocessing
import tempfile
import threading
import time
import unittest
import sys
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from collector_recovery import ScanIntent, failure_state, retry_after, retry_delay
from collector_http import request_json, scanner_request
from collector_watchdog import HealthMonitor, should_restart


class HealthTests(unittest.TestCase):
    def test_allocation_failure_stops_recovery_without_game_focus_retry(self):
        import cv2
        errors = [MemoryError(), OSError(12, 'out of memory')]
        native = OSError('paging file too small')
        native.winerror = 1455
        errors.append(native)
        cv_error = cv2.error('allocation failed')
        cv_error.code = -4
        errors.append(cv_error)
        for error in errors:
            with self.subTest(error=type(error).__name__):
                phase, message = failure_state(error)
                self.assertEqual(phase, 'needs_attention')
                self.assertIn('内存不足', message)
                self.assertNotIn('恢复前台', message)
        ordinary = cv2.error('bad input')
        ordinary.code = -215
        self.assertEqual(failure_state(ordinary)[0], 'waiting_game')
        self.assertNotIn('内存不足', failure_state(PermissionError('denied'))[1])

    def test_packet_channel_failure_has_bounded_capture_recovery(self):
        from channel_packet_state import PacketChannelConfirmationError
        from free_market_route import PositionSyncError
        error=PacketChannelConfirmationError(12,'map_entry_missing')
        self.assertIsInstance(error,PositionSyncError)
        self.assertEqual(failure_state(error,1)[0],'rebuilding')
        phase,message=failure_state(error,3)
        self.assertEqual(phase,'needs_attention')
        self.assertIn('频道收包',message)
        self.assertNotIn('前台',message)

    def test_packet_key_failure_reports_data_reason_without_ui_advice(self):
        from packet_keybindings import PacketKeyBindingError
        phase,message=failure_state(PacketKeyBindingError('waiting_for_active_preset'),3)
        self.assertEqual(phase,'needs_attention')
        self.assertIn('当前预设',message)
        self.assertNotIn('遮挡',message)
        self.assertNotIn('设置界面',message)

    def test_keyboard_menu_failure_is_distinct_from_missing_bindings(self):
        from keyboard_bindings import KeyBindingMenuError
        phase,message=failure_state(KeyBindingMenuError('Game menu was not recognized'))
        self.assertEqual(phase,'needs_attention')
        self.assertIn('设置界面',message)
        self.assertNotIn('移动和跳跃键',message)

    def test_keyboard_focus_loss_keeps_recovery_path(self):
        phase,message=failure_state(RuntimeError('Game lost foreground; stopped'))
        self.assertEqual(phase,'waiting_game')

    def test_unknown_key_bindings_require_attention_without_reconnect(self):
        from keyboard_bindings import KeyBindingError
        phase,message=failure_state(KeyBindingError('up binding missing'))
        self.assertEqual(phase,'needs_attention')
        self.assertIn('移动和跳跃键',message)
    def test_update_handoff_grace_is_launch_scoped_and_bounded(self):
        monitor=HealthMonitor('launch')
        intent=dict(enabled=True,session='session')
        health=dict(launch_id='launch',session='session',monotonic=100,updating=True)
        self.assertIsNone(monitor.check(health,intent,100))
        self.assertIsNone(monitor.check({},intent,180))
        self.assertIsNone(monitor.check({},intent,221))
        self.assertEqual(monitor.check({},intent,224),'stale')
        foreign=HealthMonitor('new',startup_grace=1)
        self.assertIsNone(foreign.check(health,intent,100))
        self.assertIsNone(foreign.check(health,intent,102))
        self.assertEqual(foreign.check(health,intent,105),'stale')

    def test_transient_missing_reads_do_not_kill_active_scanner(self):
        monitor = HealthMonitor('launch')
        intent = dict(enabled=True, session='session')
        for second in range(200):
            health = dict(launch_id='launch', session='session', monotonic=second, pid=123)
            self.assertIsNone(monitor.check(health, intent, second))
            # Includes a temporary read failure right after real progress, as in #5.
            self.assertIsNone(monitor.check({}, intent, second+.13))
            self.assertIsNone(monitor.check(dict(health, launch_id='previous'), intent, second+.55))

    def test_stuck_health_and_continuous_read_failure_still_restart(self):
        for missing in (False, True):
            monitor = HealthMonitor('launch', startup_grace=45)
            intent = dict(enabled=True, session='session')
            health = dict(launch_id='launch', session='session', monotonic=100)
            self.assertIsNone(monitor.check(health, intent, 100))
            if missing: health = {}
            self.assertIsNone(monitor.check(health, intent, 121))
            self.assertEqual(monitor.check(health, intent, 123), 'stale')
            self.assertIsNone(monitor.check(dict(launch_id='launch',session='session',monotonic=124),intent,124))

    def test_start_after_long_idle_has_grace_and_foreign_restart_is_ignored(self):
        monitor = HealthMonitor('launch')
        monitor.check({}, {}, 0)
        intent = dict(enabled=True, session='session')
        old = dict(launch_id='previous',session='session',monotonic=5000,restart=True)
        self.assertIsNone(monitor.check(old,intent,5000))
        self.assertIsNone(monitor.check({},intent,5044))
        fresh = dict(old,launch_id='launch',monotonic=5045)
        self.assertEqual(monitor.check(fresh,intent,5045),'blocked_step')
        self.assertIsNone(monitor.check(fresh,dict(enabled=False),5046))

    def test_atomic_health_write_retries_windows_sharing_violation(self):
        import os
        from collector_recovery import atomic_json, read_json
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'health.json'
            replace=os.replace
            attempts=[]
            def flaky(source,target):
                attempts.append(1)
                if len(attempts)<3:raise PermissionError('reader holds file')
                return replace(source,target)
            with patch('collector_recovery.os.replace',side_effect=flaky):
                atomic_json(path,dict(pid=123))
            self.assertEqual(read_json(path),dict(pid=123))
            self.assertEqual(len(attempts),3)
from scanner_desktop import DesktopController


def stalled_request(pipe):
    pipe.recv()
    time.sleep(60)


def crashing_request(pipe):
    import os
    os._exit(7)


def response_429(pipe):
    pipe.recv()
    pipe.send(('http', 429, '120'))


class PolicyTests(unittest.TestCase):
    def test_conflict_messages_and_retry_match_the_operation(self):
        for action, message in (('claim','占用'),('heartbeat','过期'),('complete','过期')):
            error=HTTPError('',409,'',{},None)
            error.scanner_action=action
            self.assertIn(message,failure_state(error)[1])
            for attempt in (1,4,10,100):
                self.assertLessEqual(retry_delay(attempt,error),2)
            error.headers['Retry-After']='30'
            self.assertEqual(retry_delay(100,error),30)
        self.assertNotIn('过期',failure_state(HTTPError('',409,'',{},None))[1])

    def test_scanner_cleanup_survives_stop_but_other_new_requests_do_not(self):
        stop=threading.Event();stop.set()
        config=dict(endpoint='https://mxd.ruit.me',token='fixture')
        with patch('collector_http.request_json',return_value={}) as request:
            scanner_request(config,'release',{'lease_id':'owned'},stop=stop)
            self.assertIsNone(request.call_args.kwargs['stop'])
            self.assertEqual(request.call_args.kwargs['timeout'],3)
            for action in ('claim','heartbeat','complete'):
                with self.assertRaises(InterruptedError):scanner_request(config,action,{},stop=stop)
            self.assertEqual(request.call_count,1)
        self.assertTrue(stop.is_set())

    def test_map_configuration_failure_is_actionable_and_keeps_local_diagnostic(self):
        from free_market_route import MapResourceError, RouteError
        error = MapResourceError(80002000, dict(reason='map_resource_parse_failed',
            map_file='D:/SteamLibrary/Map0_000.wz', error='invalid WZ header', token='must not be logged'))
        phase, message = failure_state(error)
        self.assertEqual(phase, 'needs_attention')
        self.assertIn('地图', message)
        self.assertEqual(error.resource_diagnostic['error'], 'invalid WZ header')
        self.assertNotIn('token', error.resource_diagnostic)
        self.assertEqual(failure_state(RouteError('Position feed is stale'))[0], 'waiting_game')

    def test_unrecognized_received_shop_has_specific_attention_message(self):
        from market_browser_bot import ShopWindowUnconfirmed
        phase,message=failure_state(ShopWindowUnconfirmed('exit button missing'))
        self.assertEqual(phase,'needs_attention')
        self.assertIn('离店状态',message)
        self.assertNotIn('游戏尚未就绪',message)

    def test_full_disk_stop_revokes_existing_permit_without_new_file(self):
        with tempfile.TemporaryDirectory() as folder:
            intent=ScanIntent(folder)
            intent.start(12)
            with patch.object(Path,'open',side_effect=OSError('disk full')):
                with self.assertRaises(OSError):intent.stop()
            self.assertFalse(ScanIntent(folder).load()['enabled'])

    def test_independent_watchdog_recovers_real_crashed_and_stuck_processes(self):
        from collector_watchdog import run
        for fault in ('crash', 'stuck'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as folder:
                ScanIntent(folder).start(12)
                code = '''
import json,os,sys,time
from pathlib import Path
home=Path(sys.argv[1]); counter=home/'counter'
n=int(counter.read_text())+1 if counter.exists() else 1
counter.write_text(str(n))
if n==1:
    if sys.argv[2]=='crash': os._exit(7)
    (home/'scan-health.json').write_text(json.dumps(dict(at=time.time(),pid=os.getpid(),restart=True)))
    time.sleep(60)
(home/'scan-stopped').write_text('normal exit')
'''
                result=run(Path(folder),[],command=[sys.executable,'-c',code,folder,fault],
                           emergency=lambda:False,release=lambda:None,startup_grace=.2)
                self.assertEqual(result,0)
                self.assertEqual((Path(folder)/'counter').read_text(),'2')
                self.assertFalse(ScanIntent(folder).load()['enabled'])

    def test_watchdog_stops_crash_loop_releases_input_and_leaves_a_notice(self):
        from collector_watchdog import run, STOP_NOTICE
        with tempfile.TemporaryDirectory() as folder:
            ScanIntent(folder).start(12)
            code='''
import os,sys
from pathlib import Path
counter=Path(sys.argv[1])/'counter'
counter.write_text(str(int(counter.read_text())+1 if counter.exists() else 1))
os._exit(7)
'''
            released=[]
            result=run(Path(folder),[],command=[sys.executable,'-c',code,folder],
                       emergency=lambda:False,release=lambda:released.append(1),startup_grace=.2)
            self.assertEqual(result,7)
            self.assertEqual((Path(folder)/'counter').read_text(),'3')
            self.assertEqual(len(released),3)
            self.assertFalse(ScanIntent(folder).load()['enabled'])
            self.assertEqual(json.loads((Path(folder)/STOP_NOTICE).read_text())['reason'],'crash_loop')

    def test_stop_is_durable_even_when_intent_replace_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            intent = ScanIntent(folder)
            intent.start(12)
            with patch('collector_recovery.atomic_json', side_effect=OSError('full')):
                with self.assertRaises(OSError):
                    intent.stop()
            self.assertFalse(ScanIntent(folder).load()['enabled'])
            self.assertTrue(intent.start(12)['enabled'])

    def test_transient_errors_and_auth_are_distinct(self):
        for code in (408, 429, 500, 502, 503, 504):
            self.assertEqual(failure_state(HTTPError('', code, '', {}, None))[0], 'recovering_network')
        for code in (400, 401, 403, 404):
            self.assertEqual(failure_state(HTTPError('', code, '', {}, None))[0], 'needs_attention')
        self.assertEqual(failure_state(HTTPError('', 409, '', {}, None))[0], 'rebuilding')
        for error in (TimeoutError(), ConnectionResetError(), URLError('DNS unavailable')):
            self.assertEqual(failure_state(error)[0], 'recovering_network')

    def test_retry_after_takes_precedence_over_capped_jitter(self):
        with patch('collector_recovery.random.uniform', return_value=1):
            self.assertEqual([retry_delay(n) for n in range(1, 8)], [1, 2, 4, 8, 16, 30, 30])
        self.assertEqual(retry_delay(100, HTTPError('',429,'',{'Retry-After':'120'},None)),120)
        self.assertEqual(retry_after(HTTPError('',429,'',{'Retry-After':'Thu, 01 Jan 1970 00:02:00 GMT'},None),now=0),120)

    def test_real_request_process_is_killed_on_total_timeout(self):
        before = {p.pid for p in multiprocessing.active_children()}
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            request_json('unused', {}, {}, timeout=.3, worker=stalled_request)
        self.assertLess(time.monotonic()-started, 2)
        self.assertEqual(before, {p.pid for p in multiprocessing.active_children()})

    def test_request_crash_and_429_are_visible(self):
        with self.assertRaises(ConnectionError):
            request_json('unused', {}, {}, worker=crashing_request)
        with self.assertRaises(HTTPError) as error:
            request_json('unused', {}, {}, worker=response_429)
        self.assertEqual(retry_after(error.exception),120)

    def test_stop_cancels_blocked_network_request(self):
        stop = threading.Event()
        timer = threading.Timer(.2, stop.set)
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaises(InterruptedError):
                request_json('unused', {}, {}, stop=stop, worker=stalled_request)
        finally:
            timer.join()
        self.assertLess(time.monotonic()-started, 2)

    def test_process_crash_restarts_only_with_persisted_intent(self):
        self.assertTrue(should_restart(7, False, {'enabled':True}))
        self.assertTrue(should_restart(0, True, {'enabled':True}))
        self.assertFalse(should_restart(0, False, {'enabled':True}))
        self.assertFalse(should_restart(7, True, {'enabled':False}))


class RecoveryTests(unittest.TestCase):
    def scan_with_preflight(self, folder, hwnd, started, stop, callback, ready_callback, **kwargs):
        ready_callback(object())
        callback(('confirmed',dict(step='scan',room=5)))
        stop.wait()

    def buying_sweep(self):
        sweep=Mock()
        sweep.buying.return_value=True
        sweep.scan_mode.return_value='market'
        self.controller.sweep=sweep
        return sweep

    def test_price_scanning_does_not_require_personal_inventory(self):
        self.modules['run']=self.scan_with_preflight
        with patch('inventory_check.check_at_start',side_effect=AssertionError('not buying')) as check:
            self.controller.start(12)
            self.until(lambda:self.controller.snapshot()['phase']=='scanning')
            check.assert_not_called()
        self.assertTrue(ScanIntent(self.home).load()['enabled'])

    def test_sweep_inventory_failure_keeps_reason_and_requires_manual_restart(self):
        from inventory_check import InventoryCheckError
        self.buying_sweep()
        self.modules['run']=self.scan_with_preflight
        with patch('inventory_check.check_at_start',side_effect=InventoryCheckError('背包数据尚未完成核对')) as check:
            self.controller.start(12)
            self.controller._worker.join(3)
            check.assert_called_once()
        state=self.controller.snapshot()
        self.assertEqual(state['phase'],'needs_attention')
        self.assertFalse(state['desired'])
        self.assertIn('背包数据尚未完成核对',state['message'])
        self.assertTrue(any('背包数据尚未完成核对' in row['text'] for row in state['activities']))
        self.assertFalse(ScanIntent(self.home).load()['enabled'])
        rows=[json.loads(row) for row in (self.home/'scan-recovery.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertTrue(any(row['event']=='scan_stopped' and '背包' in row['reason'] for row in rows))
        self.assertFalse(any(row['event']=='user_stop' for row in rows))
        # Fixing the problem and starting again clears the previous fault.
        with patch('inventory_check.check_at_start'):
            self.controller.start(12)
            self.until(lambda:self.controller.snapshot()['phase']=='scanning')
        self.assertIsNone(self.controller.snapshot()['failure'])

    def test_startup_focus_interruption_waits_then_resumes_without_user_stop(self):
        self.buying_sweep()
        self.modules['run']=self.scan_with_preflight
        attempts=[]
        def check(*args):
            attempts.append(1)
            if len(attempts)==1:
                self.ready=False
                raise RuntimeError('Game lost foreground; stopped')
        with patch('inventory_check.check_at_start',side_effect=check):
            self.controller.start(12)
            self.until(lambda:self.controller.snapshot()['phase']=='waiting_game')
            self.assertTrue(ScanIntent(self.home).load()['enabled'])
            self.assertTrue(self.controller.snapshot()['desired'])
            self.ready=True
            self.until(lambda:self.controller.snapshot()['phase']=='scanning')
        self.assertEqual(len(attempts),2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.runtime = Mock(home=self.home, folder=self.home/'captures', error=None, diagnostics=None, remote_debug=None)
        self.runtime.stopped.return_value = False
        self.runtime.configuration.return_value = dict(endpoint='https://mxd.ruit.me', token='fixture')
        self.sessions = []
        def cloud(config, stop, status, **kwargs):
            self.sessions.append(kwargs['session'])
            return Mock()
        self.modules = dict(LeaseStopEvent=threading.Event, clear_pause=Mock(), request_pause=Mock(),
                            is_paused=lambda:False, CloudScan=cloud, DEFAULT_STATE=None, POSITION_STATE=None,
                            channel_capture=lambda path,stop,ready_event:(ready_event.set(),stop.wait()), position_capture=lambda path,stop,ready_event:(ready_event.set(),stop.wait()))
        self.ready = True
        self.emergency = False
        self.controller = DesktopController(self.runtime, modules=self.modules,
            windows=lambda:[dict(id=12,pid=42,title='MapleStory')], ready=lambda _:self.ready,
            emergency=lambda:self.emergency)
        for target, value in [('scanner_desktop.focus_game',Mock()), ('scanner_desktop.release_keys',Mock()),
                              ('scanner_desktop.RUNS',self.home/'runs'), ('scanner_desktop.retry_delay',lambda *a:.01)]:
            patcher=patch(target,value);patcher.start();self.addCleanup(patcher.stop)
        self.addCleanup(self.stop)

    def stop(self):
        self.controller.command('stop')
        for thread in (self.controller._worker,self.controller._guard_thread):
            if thread:thread.join(3)
        self.controller._journal.close()

    def until(self, predicate, timeout=3):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if predicate():return
            time.sleep(.01)
        self.fail('Timed out waiting for recovery condition')

    def test_position_failure_stops_after_three_attempts(self):
        from free_market_route import PositionSyncError
        self.modules['run']=Mock(side_effect=PositionSyncError('Position feed is stale'))
        self.controller.start(12)
        self.until(lambda:self.controller.snapshot()['phase']=='needs_attention')
        time.sleep(.1)
        self.assertEqual(self.modules['run'].call_count,3)
        self.assertIn('停止重复切频道',self.controller.snapshot()['message'])

    def offer_update(self):
        (self.home/'update-status.json').write_text(json.dumps(dict(state='ready_to_update',available='v0.6.57')))

    def replacement_stays_stopped(self):
        """The post-update process restores nothing; the player presses Start."""
        replacement=DesktopController(self.runtime,modules=self.modules,
            windows=lambda:[dict(id=12,pid=42,title='MapleStory')],ready=lambda _:True,emergency=lambda:False)
        try:
            self.assertFalse(ScanIntent(self.home).load()['enabled'])
            replacement.start(None,restore=True)
            self.assertIsNone(replacement._worker)
        finally:
            replacement._journal.close()

    def test_update_waits_for_click_then_post_shop_checkpoint_and_new_process_stays_stopped(self):
        entered=threading.Event();finished_shop=threading.Event()
        def scan(folder,hwnd,start,stop,callback,**kwargs):
            entered.set()
            finished_shop.wait(3)
            callback(('progress',dict(room=7,channel=2,visited=1)))
            stop.wait(3)
        self.modules['run']=scan
        self.offer_update()
        self.controller.start(12);self.assertTrue(entered.wait(2))
        self.assertFalse(self.controller.prepare_update())  # Ready is not consent.
        self.assertFalse(self.controller._update_pending)
        self.controller.command('update')
        self.assertTrue(self.controller.snapshot()['update_requested'])
        self.assertFalse(self.controller.prepare_update())
        self.assertFalse(self.controller._stop.is_set())
        self.assertFalse(self.controller._cancel.is_set())
        with self.assertRaises(ValueError):self.controller.start(12)
        finished_shop.set()
        self.until(lambda:not self.controller._worker.is_alive())
        self.until(self.controller.prepare_update)
        self.assertTrue(json.loads((self.home/'scan-health.json').read_text())['updating'])
        self.replacement_stays_stopped()

    def test_update_click_needs_a_staged_release_and_waits_for_remote_debug(self):
        with self.assertRaises(ValueError):self.controller.command('update')
        self.offer_update()
        debug=Mock();debug.view.return_value={'active':True}
        self.runtime.remote_debug=debug
        with self.assertRaises(ValueError):self.controller.command('update')
        self.assertFalse(self.controller._update_pending)
        self.assertFalse(self.controller.prepare_update())
        debug.stop.assert_not_called()

    def test_update_of_attention_state_does_not_reenable_input(self):
        self.offer_update()
        self.controller._intent.start(12)
        self.controller._change(phase='needs_attention')
        self.controller.command('update')
        self.assertTrue(self.controller.prepare_update())
        self.assertFalse(ScanIntent(self.home).load()['enabled'])

    def test_attention_error_after_update_click_is_logged_and_never_resumed(self):
        from free_market_route import MapResourceError
        entered=threading.Event()
        def scan(folder,hwnd,start,stop,callback,**kw):
            entered.set()
            time.sleep(.3)  # The player clicks Update while this shop visit runs.
            raise MapResourceError(80002000,dict(reason='map_resource_parse_failed'))
        self.modules['run']=scan
        self.offer_update()
        self.controller.start(12)
        self.assertTrue(entered.wait(2))
        self.controller.command('update')
        self.assertFalse(self.controller.prepare_update())
        self.until(lambda:self.controller.snapshot()['phase']=='needs_attention')
        self.until(self.controller.prepare_update)
        rows=[json.loads(row) for row in (self.home/'scan-recovery.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertTrue(any(row['event']=='recovery_wait' and row['error']=='MapResourceError' for row in rows))
        self.assertTrue(any(row['event']=='update_handoff' for row in rows))
        self.replacement_stays_stopped()

    def test_pause_after_update_click_hands_off_and_new_process_stays_stopped(self):
        self.modules['run']=lambda folder,hwnd,start,stop,callback,**kw:stop.wait(3)
        self.offer_update()
        self.controller.start(12)
        self.until(lambda:self.controller._attempt_active)
        self.controller.command('update')
        self.assertFalse(self.controller.prepare_update())
        self.controller.command('pause')
        self.until(lambda:not self.controller._attempt_active)
        self.until(self.controller.prepare_update)
        self.replacement_stays_stopped()

    def test_repeated_faults_recover_with_one_scanner_and_same_session(self):
        failures=[TimeoutError(),URLError('DNS'),HTTPError('',502,'',{},None),HTTPError('',503,'',{},None)]
        calls=0
        live=0
        maximum=0
        def run(folder,hwnd,start,stop,callback,**kwargs):
            nonlocal calls,live,maximum
            calls+=1;live+=1;maximum=max(maximum,live)
            try:
                if failures:raise failures.pop(0)
                callback(('confirmed',dict(step='claim',room=17)))
                stop.wait()
            finally:live-=1
        self.modules['run']=run
        self.controller.start(12)
        self.until(lambda:self.controller.snapshot()['phase']=='scanning')
        self.assertEqual(calls,5)
        self.assertEqual(maximum,1)
        self.assertEqual(len(set(self.sessions)),1)
        self.assertTrue(ScanIntent(self.home).load()['enabled'])

    def test_stop_and_restart_release_real_cloud_assignment_without_expiry_wait(self):
        from scanner.cloud_scan import CloudScan, LeaseStopEvent
        owner=None
        sessions=[]
        actions=[]
        # Exercise controller -> HTTP cancellation policy -> CloudScan cleanup.
        # The fake service enforces the same cross-session exclusion as the API.
        def request(url,body,headers,*,stop,timeout):
            nonlocal owner
            if stop is not None and stop.is_set():raise InterruptedError('cancelled')
            action=url.rsplit('/',1)[-1]
            actions.append(action)
            if action=='claim':
                if owner and owner!=body['session_id']:raise HTTPError(url,409,'',{},None)
                owner=body['session_id'];sessions.append(owner)
                # Reproduce stopping while the claim response is on its way.
                if len(sessions)==1:self.controller.command('stop')
                return dict(assignment=dict(room=5,lease_id=owner,ttl_seconds=30))
            if action=='release':
                self.assertEqual(body['lease_id'],owner)
                owner=None
                return dict(ok=True)
            return dict(ttl_seconds=30)
        def run(folder,hwnd,started,stop,callback,assignments,**kwargs):
            assignments.claim()
            stop.wait()
        self.modules.update(CloudScan=lambda *a,**kw:CloudScan(*a,connected=lambda:True,**kw),
                            LeaseStopEvent=LeaseStopEvent,run=run)
        with patch('collector_http.request_json',side_effect=request):
            self.controller.start(12)
            self.controller._worker.join(3)
            self.assertFalse(self.controller._worker.is_alive())
            self.assertIsNone(owner)
            self.controller.start(12)
            self.until(lambda:self.controller.snapshot()['phase']=='scanning')
            self.controller.command('stop')
            self.controller._worker.join(3)
        self.assertIsNone(owner)
        self.assertEqual(actions,['claim','release','claim','release'])
        self.assertNotEqual(sessions[0],sessions[1])
        self.assertEqual(self.controller.snapshot()['retries'],0)

    def test_auth_does_not_retry_until_user_intervenes(self):
        self.modules['run']=Mock(side_effect=HTTPError('',401,'',{},None))
        self.controller.start(12)
        self.until(lambda:self.controller.snapshot()['phase']=='needs_attention')
        time.sleep(.1)
        self.assertEqual(self.modules['run'].call_count,1)

    def test_map_resource_error_stops_retry_and_records_the_actual_cause(self):
        from free_market_route import MapResourceError
        self.modules['run'] = Mock(side_effect=MapResourceError(80002000, dict(
            reason='map_resource_parse_failed', map_file='D:/SteamLibrary/Map0_000.wz',
            error='invalid WZ header', token='do-not-log')))
        self.controller.start(12)
        self.until(lambda: self.controller.snapshot()['phase'] == 'needs_attention')
        time.sleep(.1)
        self.assertEqual(self.modules['run'].call_count, 1)
        rows = [json.loads(line) for line in (self.home/'scan-recovery.jsonl').read_text(encoding='utf-8').splitlines()]
        failure = next(row for row in rows if row['event'] == 'recovery_wait')
        self.assertEqual(failure['resource']['reason'], 'map_resource_parse_failed')
        self.assertEqual(failure['resource']['error'], 'invalid WZ header')
        self.assertNotIn('token', failure['resource'])

    def test_f9_during_backoff_cancels_persisted_restart_intent(self):
        self.modules['run']=Mock(side_effect=TimeoutError())
        with patch('scanner_desktop.retry_delay',return_value=1800):
            self.controller.start(12)
            self.until(lambda:self.controller.snapshot()['phase']=='recovering_network')
            self.emergency=True
            self.until(lambda:not self.controller._worker.is_alive(),timeout=2)
        self.assertFalse(ScanIntent(self.home).load()['enabled'])
        self.assertEqual(self.modules['run'].call_count,1)

    def test_game_wait_has_no_input_and_resumes_without_another_start(self):
        self.ready=False
        self.modules['run']=Mock(side_effect=lambda folder,hwnd,start,stop,callback,**kw:stop.wait())
        self.controller.start(12)
        self.until(lambda:self.controller.snapshot()['phase']=='waiting_game')
        self.modules['run'].assert_not_called()
        self.ready=True
        self.until(lambda:self.modules['run'].call_count==1)

    def test_restored_session_automatically_recovers_foreground_before_scanning(self):
        self.ready = False
        self.modules['run'] = Mock(side_effect=lambda folder,hwnd,start,stop,callback,**kw:stop.wait())
        self.controller._intent.start(12, 'saved-session')
        def focus(hwnd, *, allowed):
            self.assertTrue(allowed())
            self.modules['run'].assert_not_called()
            self.ready = True
            return True
        with patch('scanner_desktop.focus_game', side_effect=focus) as activate:
            self.controller.start(12, restore=True)
            self.until(lambda:self.modules['run'].call_count==1)
            activate.assert_called_once()
        self.assertEqual(self.sessions, ['saved-session'])

    def test_foreground_loss_finishes_old_attempt_before_refocusing(self):
        lease = Mock()
        self.modules['CloudScan'] = Mock(return_value=lease)
        calls = []
        def run(folder,hwnd,start,stop,callback,**kw):
            calls.append(stop)
            if len(calls) == 1:
                self.ready = False
                raise RuntimeError('Game lost foreground; stopped')
            stop.wait()
        self.modules['run'] = run
        def focus(hwnd, *, allowed):
            self.assertTrue(allowed())
            self.assertTrue(calls[0].is_set())
            self.assertFalse(self.controller._attempt_active)
            lease.close.assert_called_once()
            self.ready = True
            return True
        with patch('scanner_desktop.focus_game', side_effect=focus) as activate:
            self.controller.start(12)
            self.until(lambda:len(calls)==2)
            activate.assert_called_once()
        self.assertIsNot(calls[0], calls[1])

    def test_focus_retries_are_throttled_and_blocked_by_pause_stop_or_emergency(self):
        controller = self.controller
        controller._intent.start(12)
        controller._hwnd = 12
        controller._desired = True
        controller._cancel.clear()
        with patch('scanner_desktop.focus_game', return_value=False) as focus:
            controller._restore_foreground()
            controller._restore_foreground()
            focus.assert_called_once()
            controller._focus_retry_at = 0
            controller._paused.set()
            controller._restore_foreground()
            controller._paused.clear()
            self.emergency = True
            controller._restore_foreground()
            self.emergency = False
            controller._intent.stop()
            controller._restore_foreground()
            controller._intent.start(12)
            controller.command('stop')
            controller._restore_foreground()
            focus.assert_called_once()

    def test_blocked_activation_keeps_stop_responsive_and_requests_watchdog(self):
        entered, unblock = threading.Event(), threading.Event()
        self.ready = False
        self.modules['run'] = Mock()
        def blocked(hwnd, *, allowed):
            entered.set()
            unblock.wait(3)
            self.assertFalse(allowed())
            return False
        with patch('scanner_desktop.focus_game', side_effect=blocked):
            try:
                self.controller.start(12)
                self.assertTrue(entered.wait(2))
                self.controller._focus_deadline = time.monotonic()-1
                self.until(lambda:self.controller._restart_requested)
                self.controller.command('stop')
                self.assertFalse(ScanIntent(self.home).load()['enabled'])
            finally:
                unblock.set()
                self.controller._worker.join(3)
        self.modules['run'].assert_not_called()

    def test_dead_capture_worker_is_rebuilt(self):
        count=0
        def capture(path,stop,ready_event):
            ready_event.set()
            nonlocal count
            count+=1
            if count==1:raise RuntimeError('injected capture exit')
            stop.wait()
        self.modules['channel_capture']=capture
        self.modules['run']=lambda folder,hwnd,start,stop,callback,**kw:stop.wait()
        self.controller.start(12)
        self.until(lambda:count==2)
        self.assertTrue(self.controller._worker.is_alive())

    def test_stuck_step_requests_process_restart_without_duplicate_scanner(self):
        unblock=threading.Event()
        self.modules['run']=Mock(side_effect=lambda *args,**kw:unblock.wait(3))
        try:
            with patch('scanner_desktop.ABORT_GRACE',.1):
                self.controller.start(12)
                self.until(lambda:self.modules['run'].called)
                self.controller._step_deadline=time.monotonic()-1
                self.until(lambda:self.controller._restart_requested)
                self.assertTrue(self.controller._stop.is_set())
                self.assertEqual(self.modules['run'].call_count,1)
        finally:unblock.set()

    def test_late_callback_after_stop_cannot_report_scanning(self):
        self.modules['run']=lambda folder,hwnd,start,stop,callback,**kw:stop.wait()
        self.controller.start(12)
        self.controller.command('stop')
        self.controller._on_scan(('confirmed',dict(step='claim',room=1)))
        self.assertFalse(self.controller.snapshot()['desired'])
        self.assertNotEqual(self.controller.snapshot()['phase'],'scanning')

    def test_guard_survives_failed_health_writes_and_publishes_again(self):
        from collector_recovery import atomic_json, read_json
        attempts=[]
        def flaky(path,value):
            attempts.append(1)
            if len(attempts)<=2:raise PermissionError('temporary sharing violation')
            return atomic_json(path,value)
        self.modules['run']=lambda *args,**kw:args[3].wait()
        with patch('scanner_desktop.atomic_json',side_effect=flaky):
            self.controller.start(12)
            self.until(lambda:bool(read_json(self.home/'scan-health.json')),timeout=4)
        self.assertTrue(self.controller._guard_thread.is_alive())
        self.assertFalse(self.controller._restart_requested)
