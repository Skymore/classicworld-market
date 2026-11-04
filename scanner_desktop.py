"""Local React desktop shell. Game actions stay in the existing scanner engine."""
import ctypes
import hashlib
import json
import sys
import os
import queue
import re
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from collector_update import VERSION
from collector_recovery import ScanIntent, RecoveryLog, atomic_json, failure_state, retry_delay, prune_diagnostics, read_json, memory_exhausted, system_memory_status
from collector_watchdog import STOP_NOTICE as WATCHDOG_STOP

RUNS = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ClassworldFMBot/screen_scanner'
ABORT_GRACE = 8
ACTIVITY_LIMIT = 40  # The activity panel fills the window and scrolls.
MIN_SIZE = (880, 740)  # Smallest window the layout is designed for.
SWEEP_HANDLED = 'sweep-handled.json'  # Last web sweep run this device started or served.


def scan_shop_callback(sweep):
    """Keep buying dynamic between visits; passive visits need no UI callback."""
    def visit(collected,window):
        return sweep.on_shop_open(collected,window)
    visit.requires_window=sweep.buying
    return visit


def scanner_modules(backend='windows'):
    from channel_state_collector import DEFAULT_STATE, run as channel_capture
    from position_state_collector import POSITION_STATE, run as position_capture
    from full_market_scan import run
    from cloud_scan import CloudScan, LeaseStopEvent
    from control_state import clear_pause, is_paused, request_pause
    from scan_progress import AssignedProgress
    if backend == 'windows':
        from functools import partial
        from market_passive import WindowsSniffer
        from channel_state_collector import packet as channel_packet
        from position_state_collector import packet as position_packet
        # The scanner must use the same capture backend as the collector.
        # Position decoding needs both directions; both parsers gate ports and
        # verify the owning game process before interpreting any data.
        channel_capture = partial(channel_capture, sniffer_factory=lambda: WindowsSniffer(accept=channel_packet))
        position_capture = partial(position_capture, sniffer_factory=lambda _: WindowsSniffer(accept=position_packet))
    return locals()


def game_windows():
    """Only actual game processes; a path containing MapleStory is not a game."""
    import psutil
    pids = {p.pid for p in psutil.process_iter(['name'])
            if (p.info.get('name') or '').lower() == 'maplestory.exe'}
    user = ctypes.windll.user32
    user.IsWindowVisible.argtypes = [ctypes.c_void_p]
    user.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    user.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_ssize_t)
    user.EnumWindows.argtypes = [callback, ctypes.c_ssize_t]
    found = []
    def visit(hwnd, _):
        pid = ctypes.c_ulong()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and user.IsWindowVisible(hwnd):
            text = ctypes.create_unicode_buffer(user.GetWindowTextLengthW(hwnd) + 1)
            user.GetWindowTextW(hwnd, text, len(text))
            found.append(dict(id=int(hwnd), title=text.value or 'MapleStory', pid=pid.value))
        return True
    user.EnumWindows(callback(visit), 0)
    return found


def focus_game(hwnd, *, allowed=lambda: True):
    """Best-effort activation of a verified game; never synthesize input."""
    if not allowed() or not any(w['id'] == hwnd for w in game_windows()):
        return False
    from ctypes import wintypes
    user = ctypes.windll.user32
    kernel = ctypes.windll.kernel32
    for name in ('IsIconic', 'IsHungAppWindow', 'BringWindowToTop', 'SetForegroundWindow'):
        getattr(user, name).argtypes = [wintypes.HWND]
        getattr(user, name).restype = wintypes.BOOL
    user.GetForegroundWindow.restype = wintypes.HWND
    user.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
    user.ShowWindowAsync.restype = wintypes.BOOL
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowThreadProcessId.restype = wintypes.DWORD
    user.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user.AttachThreadInput.restype = wintypes.BOOL
    kernel.GetCurrentThreadId.restype = wintypes.DWORD
    def focused():
        return user.GetForegroundWindow() == hwnd and not user.IsIconic(hwnd)
    if focused():
        return True
    if not allowed() or user.IsHungAppWindow(hwnd):
        return False
    if user.IsIconic(hwnd):
        user.ShowWindowAsync(hwnd, 9)  # SW_RESTORE, without waiting on the game.
    if not allowed():
        return False
    user.SetForegroundWindow(hwnd)
    if focused():
        return True
    foreground = user.GetForegroundWindow()
    if foreground and user.IsHungAppWindow(foreground):
        return False
    current = kernel.GetCurrentThreadId()
    attached = []
    try:
        # A worker thread does not own the launcher's foreground input queue.
        # Temporarily share it for activation, then always detach again.
        for window in (foreground, hwnd):
            thread = user.GetWindowThreadProcessId(window, None) if window else 0
            if thread and thread != current and thread not in attached and allowed():
                if user.AttachThreadInput(current, thread, True):
                    attached.append(thread)
        if allowed():
            user.BringWindowToTop(hwnd)
        if allowed():
            user.SetForegroundWindow(hwnd)
    finally:
        for thread in reversed(attached):
            user.AttachThreadInput(current, thread, False)
    return allowed() and focused()


def release_keys():
    from market_keyboard import send_key, release_held_keys
    release_held_keys()
    for key in ('left', 'right', 'up', 'down', 'space'):
        try:
            send_key(key, False)
        except OSError:
            pass


def emergency_stop():
    if not hasattr(ctypes, 'windll'):
        return False
    from ctypes import wintypes
    point = wintypes.POINT()
    user = ctypes.windll.user32
    return bool(user.GetAsyncKeyState(0x78) & 0x8000 or
                (user.GetCursorPos(ctypes.byref(point)) and point.x == 0 and point.y == 0))


def game_ready(hwnd):
    """Input remains gated on the actual foreground and game connection."""
    from cloud_scan import game_connected
    user = ctypes.windll.user32
    user.GetForegroundWindow.restype = ctypes.c_void_p
    user.IsIconic.argtypes = [ctypes.c_void_p]
    return user.GetForegroundWindow() == hwnd and not user.IsIconic(hwnd) and game_connected()


def status_text(value):
    for pattern, template in [
        (r'full_scanning_room_(\d+)_channel_(\d+)', '正在扫描 {0} 洞 · {1}频道'),
        (r'full_switching_room_(\d+)_channel_(\d+)', '正在切换 {0} 洞 · {1}频道'),
        (r'full_entering_room_(\d+)', '正在前往 {0} 洞'),
        (r'full_exiting_room_(\d+)', '正在离开 {0} 洞'),
        (r'full_returning_room_(\d+)_channel_(\d+)', '正在准备离开 {0} 洞'),
        (r'full_retrying_(?:scan|channel|return)_room_(\d+)_channel_(\d+)_attempt_(\d+)', '正在重试 {0} 洞 · {1}频道'),
        (r'route_calibration_trying_channel_(\d+)', '正在连接 {0}频道'),
        (r'route_calibration_connection_ready_(\d+)', '已连接 {0}频道'),
    ]:
        match = re.fullmatch(pattern, value)
        if match:
            return template.format(*match.groups())
    labels = {'reading_movement_bindings':'正在同步移动和跳跃键',
              'full_preparing_capture': '正在连接游戏', 'waiting_for_game_foreground': '正在恢复游戏前台',
              'loading_keyboard_and_screenshot_backend': '正在准备扫描', 'started': '正在识别摊位',
              'route_calibration_connecting': '正在确认当前频道'}
    if value in labels:
        return labels[value]
    # Keep ordinary Chinese coordination messages; internal event names stay in logs.
    return value if re.search('[\u4e00-\u9fff]', value) else None


def purchase_text(entry):
    """'买到 红色药水 ×100 @41 · 3 洞 12 频道 COSTCO' for a bought sweep entry."""
    price = entry.get('price')
    place = ' '.join(part for part in (
        f"{entry['room']} 洞" if entry.get('room') is not None else '',
        f"{entry['channel']} 频道" if entry.get('channel') is not None else '',
        str(entry.get('owner') or '')) if part)
    head = f"买到 {entry.get('name') or entry.get('item_id')} ×{entry.get('units') or entry.get('quantity') or 0}"
    if type(price) is int:
        head += f' @{price:,}'
    return head + (f' · {place}' if place else '')


class DesktopController:
    def __init__(self, collector, *, modules=None, windows=game_windows, sweep=None,
                 ready=game_ready, emergency=emergency_stop):
        self.collector = collector
        self.sweep = sweep
        self._modules = modules or scanner_modules(getattr(collector, 'backend', 'windows'))
        self._windows = windows
        self._game_ready, self._emergency = ready, emergency
        self._intent = ScanIntent(collector.home)
        self._journal = RecoveryLog(collector.home)
        self._cancel = threading.Event()
        self._cancel.set()
        self._paused = threading.Event()
        self._desired = False
        self._halt_reason = None
        self._session = None
        self._step_deadline = None
        self._guard_thread = None
        self._last_confirmed = None
        self._restart_requested = False
        self._retry_at = 0
        self._retry_deadline = 0
        self._focus_retry_at = 0
        self._focus_deadline = None
        self._attempt_active = False
        self._update_pending = False
        self._update_handoff = False
        self._last_prune = 0
        self._lock = threading.RLock()
        self._events = queue.Queue()
        self._closed = threading.Event()
        self._worker = None
        self._window = None
        self._ready = False
        self._closing = False
        self._hwnd = None
        self._stop = self._modules['LeaseStopEvent']()
        self._folder = None
        self._observer = None
        self._bound = 0
        self._state = dict(version=VERSION, phase='idle', mode='scan', message='准备就绪，选择游戏后即可开始。',
                           room=None, channel=None, visited=0, uploaded=0, started_at=None, stopped_at=None,
                           run_shops=0, run_items=0, run_started_at=time.time(),
                           capture='connecting', upload='ready', last_shop_at=None, windows=[],
                           selected=None, theme='system', updates='checking', activities=[], maximized=False,
                           desired=False, last_progress_at=None, retries=0, next_retry_at=None,
                           pending_uploads=0, failure=None, update_version=None, update_requested=False,
                           capture_warning=None)
        # A run handled before an update or reopen is not a newly accepted run.
        self._observed_sweep = read_json(collector.home/SWEEP_HANDLED).get('run')
        try:
            prefs = json.loads((collector.home/'desktop-settings.json').read_text(encoding='utf-8'))
            if prefs.get('theme') in ('light', 'dark', 'system'):
                self._state['theme'] = prefs['theme']
        except (OSError, ValueError):
            pass
        collector.add_listener(self._collector_event)
        if sweep is not None:
            sweep.add_listener(lambda entry: self._activity(purchase_text(entry), 'sweep', repeat=True))
        self._read_statistics()
        if getattr(collector, 'diagnostics', None):
            collector.diagnostics.snapshot = self.snapshot
        collector.update_gate = self.prepare_update

    def _update_health(self):
        atomic_json(self.collector.home/'scan-health.json', dict(at=time.time(), pid=os.getpid(),
                    monotonic=time.monotonic(), launch_id=os.environ.get('CW_SCANNER_LAUNCH_ID'),
                    session=self._session, restart=False, updating=True, phase='updating'))

    def _stop_for_update(self):
        # Called between attempts or from the scanner's post-close checkpoint.
        # The new process starts stopped, whatever state this one was in: no
        # one watches F9 during the restart, so the player presses Start again.
        with self._lock:
            if self._update_handoff:
                return
            self._update_handoff = True
            self._user_stop(persist=False)
            self._intent.stop()

    def _request_update(self):
        """The player's update click; hand-off waits for a saved, closed-shop boundary."""
        debug = getattr(self.collector, 'remote_debug', None)
        with self._lock:
            if debug and debug.view()['active']:
                raise ValueError('请先终止远程调试，再更新。')
            status = read_json(self.collector.home/'update-status.json')
            if status.get('state') != 'ready_to_update':
                raise ValueError('新版本还没有准备好，请稍后再试。')
            if self._update_pending:
                return
            self._update_pending = True
            self._change(update_requested=True)
            self._activity(f"正在更新到 {status.get('available') or '新版本'}，采集器会短暂重启，游戏无需退出。")
            if not self._attempt_active:
                self._stop_for_update()

    def prepare_update(self):
        """Polled by the update checker; True once the requested hand-off is safe."""
        with self._lock:
            debug = getattr(self.collector, 'remote_debug', None)
            if not self._update_pending or self._closing or (debug and debug.view()['active']):
                return False
            if not self._attempt_active:
                self._stop_for_update()
            if self._worker and self._worker.is_alive():
                return False
            if self._guard_thread and self._guard_thread.is_alive():
                return False
            self._update_health()
            return True

    def _read_statistics(self):
        stats = self.collector.statistics()
        if isinstance(stats, dict):
            self._change(**{key: stats[key] for key in ('run_shops', 'run_items', 'run_started_at') if key in stats})

    def snapshot(self):
        with self._lock:
            return json.loads(json.dumps(self._state))

    def _change(self, **values):
        with self._lock:
            if all(self._state.get(key) == value for key, value in values.items()):
                return
            self._state.update(values)
        self._events.put(None)

    def _activity(self, text, kind='info', repeat=False):
        with self._lock:
            items = self._state['activities']
            if items and items[0]['text'] == text and not repeat:
                return
            items.insert(0, dict(at=time.time(), text=text, kind=kind))
            del items[ACTIVITY_LIMIT:]
        self._events.put(None)

    def _collector_event(self, event):
        if event['type'] == 'run_stats':
            self._read_statistics()
        elif event['type'] == 'uploaded':
            with self._lock:
                self._state['uploaded'] += event['count']
                self._state['upload'] = 'ready'
            self._events.put(None)
        elif event['type'] == 'upload_error':
            self._change(upload='retrying')
            self._activity('上传暂时中断，记录已保存在本机。', 'warning')
        elif event['type'] == 'upload_queue':
            self._change(pending_uploads=event['pending'])
        elif event['type'] == 'upload_rejected':
            self._change(upload='retrying')
            message = ('电脑时间超前，这些记录不会上传，请校准时间。'
                       if event.get('reason') == 'capture_time_ahead' else
                       '上传被拒收；每条记录最多尝试 3 次，之后保留在本机，不再上传。')
            self._activity(message, 'warning')
        elif event['type'] == 'storage_error':
            self._stop.failure = OSError('Capture storage unavailable')
            self._stop.set()
            self._change(phase='needs_attention', message='采集无法保存，请检查磁盘空间及权限。')

    def refresh(self):
        choices = self._windows()
        with self._lock:
            if self._state['phase'] not in ('idle', 'stopped', 'error'):
                return self.snapshot()
            selected = self._state['selected']
        if selected not in [w['id'] for w in choices]:
            selected = choices[0]['id'] if choices else None
        self._change(windows=choices, selected=selected)
        return self.snapshot()

    def command(self, name, value=None):
        if name in ('debug_start', 'debug_stop'):
            debug = getattr(self.collector, 'remote_debug', None)
            if debug is None:
                raise ValueError('远程调试不可用')
            if name == 'debug_start':
                with self._lock:
                    if self._update_pending:
                        raise ValueError('正在更新，请稍后再开启远程调试。')
                    self._user_stop()
                    debug.start(value)
            else:
                debug.stop()
            self._change(remote_debug=debug.view())
            return self.snapshot()
        if name == 'report_bug':
            diagnostics = getattr(self.collector, 'diagnostics', None)
            if diagnostics is None:
                raise ValueError('诊断服务未启动')
            diagnostics.report(value)
            self._change(diagnostics=diagnostics.view())
            return self.snapshot()
        if name == 'window':
            if isinstance(value, dict) and set(value) == {'resize'}:
                # Frameless windows have no native resize border on Windows; the corner grip sends sizes here.
                size = value['resize']
                if not (isinstance(size, list) and len(size) == 2 and all(type(n) is int for n in size)):
                    raise ValueError('无效窗口操作')
                width, height = max(MIN_SIZE[0], min(size[0], 7680)), max(MIN_SIZE[1], min(size[1], 4320))
                if self._window and not self.snapshot().get('maximized'):
                    self._window.resize(width, height)
                return self.snapshot()
            if value not in ('minimize', 'maximize', 'close'):
                raise ValueError('无效窗口操作')
            if self._window:
                if value == 'close':
                    self.close()
                elif value == 'maximize':
                    # A frameless window has no resize border on Windows; this toggles a large layout.
                    maximized = not self.snapshot().get('maximized')
                    if maximized:
                        self._window.maximize()
                    else:
                        self._window.restore()
                    self._change(maximized=maximized)
                else:
                    self._window.minimize()
            return self.snapshot()
        if name == 'refresh':
            return self.refresh()
        if name == 'theme':
            if value not in ('light', 'dark', 'system'):
                raise ValueError('无效主题')
            self.collector.home.mkdir(parents=True, exist_ok=True)
            (self.collector.home/'desktop-settings.json').write_text(json.dumps({'theme': value}), encoding='utf-8')
            self._change(theme=value)
        elif name == 'start':
            self.start(value)
        elif name == 'pause':
            with self._lock:
                if self._update_handoff:
                    self._user_stop()
                    return self.snapshot()
                if not self._desired:
                    return self.snapshot()
                self._paused.set()
                self._modules['request_pause']()
                self._stop.set()
                release_keys()
                self._change(phase='paused', message='已暂停，扫描进度已保留。')
        elif name == 'resume':
            with self._lock:
                if self._state['phase'] != 'paused':
                    return self.snapshot()
                if self._window:
                    self._window.minimize()
                self._paused.clear()
                self._modules['clear_pause']()
                self._change(phase='rebuilding', message='正在重新确认游戏和任务。')
        elif name == 'stop':
            self._user_stop()
        elif name == 'update':
            self._request_update()
        elif name == 'mode':
            if value not in ('scan', 'manual'):
                raise ValueError('无效采集方式')
            if self._worker and self._worker.is_alive():
                raise ValueError('请先停止自动扫描')
            self._change(mode=value, message='照常逛摊即可，报价会自动上传。' if value == 'manual' else '准备就绪，选择游戏后即可开始。')
        elif name == 'account':
            self.collector.open_dashboard()
        elif name == 'website':
            import webbrowser
            webbrowser.open('https://mxd.ruit.me')
        elif name == 'watch':
            import webbrowser
            webbrowser.open('https://mxd.ruit.me/watch')
        else:
            raise ValueError('未知操作')
        return self.snapshot()

    def _user_stop(self, *, persist=True, reason=None):
        if getattr(self.collector, 'remote_debug', None):
            self.collector.remote_debug.stop()
        # Close the input gate BEFORE disk I/O or teardown. Never clear a gate
        # that an earlier scanner still holds.
        with self._lock:
            if self._desired or reason:
                self._halt_reason = reason
            self._desired = False
            self._cancel.set()
            self._stop.set()
            self._paused.clear()
            self._modules['clear_pause']()
            release_keys()
            if persist:
                self._intent.stop()
            self._change(desired=False, phase='stopping' if self._worker and self._worker.is_alive()
                         else ('needs_attention' if self._halt_reason else 'stopped'),
                         message=self._halt_reason or '已停止，自动恢复已取消。',
                         failure=self._halt_reason, next_retry_at=None)
            if reason:
                self._activity(reason, 'error')
                self._journal.event('scan_stopped', reason=reason)
            else:
                self._journal.event('user_stop' if persist else 'update_handoff')

    def start(self, hwnd, *, restore=False):
        if getattr(self.collector, 'remote_debug', None) and self.collector.remote_debug.view()['active']:
            raise ValueError('请先终止远程调试，再开始扫描。')
        with self._lock:
            if self._update_pending:
                raise ValueError('正在更新，完成后请再点开始。')
            if self._worker and self._worker.is_alive():
                return
            if self._guard_thread and self._guard_thread.is_alive():
                # The old guard captured its own cancellation event below.
                # Wait for its final health write before installing a new run.
                self._guard_thread.join(timeout=1)
                if self._guard_thread.is_alive():
                    raise RuntimeError('正在结束上次扫描，请稍后再开始。')
            choices = self._windows()
            saved = self._intent.load() if restore else {}
            if restore:
                if not saved.get('enabled'):
                    return
                previous = saved.get('window')
                hwnd = previous if previous in [w['id'] for w in choices] else (choices[0]['id'] if len(choices)==1 else None)
            elif type(hwnd) is not int or hwnd not in [w['id'] for w in choices]:
                raise ValueError('请打开游戏并重新选择游戏窗口。')
            if self.collector.error or self.collector.stopped():
                raise ValueError('采集服务未连接，请重新启动程序。')
            self._session = self._intent.start(hwnd, saved.get('session'))['session']
            self._desired = True
            self._halt_reason = None
            self._cancel = threading.Event()
            self._restart_requested = False
            self._retry_at = 0
            self._retry_deadline = 0
            self._focus_retry_at = 0
            self._focus_deadline = None
            self._paused.clear()
            self._stop = self._modules['LeaseStopEvent']()
            self._modules['clear_pause']()
            self._hwnd = hwnd
            self._change(phase='rebuilding', desired=True, mode='scan', selected=hwnd, visited=0, room=None,
                         channel=None, started_at=time.time(), stopped_at=None, failure=None, retries=0,
                         next_retry_at=None, message='正在连接游戏并领取任务…')
            if self._window:
                self._window.minimize()
            self._worker = threading.Thread(target=self._run, name='shop-scanner', daemon=True)
            self._worker.start()
            self._guard_thread = threading.Thread(target=self._guard, args=(self._cancel,), name='scan-guard', daemon=True)
            self._guard_thread.start()

    def _on_scan(self, message):
        if self._cancel.is_set():
            return
        if isinstance(message, tuple) and message[0] == 'state':
            self._step_deadline = None
            self._change(**message[1])
            return
        if isinstance(message, tuple) and message[0] == 'confirmed':
            self._confirmed(message[1])
            return
        if isinstance(message, tuple) and message[0] == 'progress':
            progress = message[1]
            self._change(channel=progress.get('channel'), visited=progress.get('visited', 0))
            marker = (self.snapshot()['room'], progress.get('channel'), progress.get('visited', 0))
            if marker != self._last_confirmed:
                self._last_confirmed = marker
                self._confirmed(dict(step='scan', room=marker[0], channel=marker[1], visited=marker[2]))
            if self._bound and progress.get('visited', 0) >= self._bound:
                self._user_stop()
        elif isinstance(message, str):
            text = status_text(message)
            match = re.search(r'room_(\d+)(?:_channel_(\d+))?', message)
            if match:
                if self.snapshot()['room'] != int(match[1]):
                    self._change(visited=0)
                self._change(room=int(match[1]), **({'channel': int(match[2])} if match[2] else {}))
            if text:
                self._change(message=text)
                self._activity(text)
                if self.sweep:
                    self.sweep.progress(text)

    def _confirmed(self, progress):
        if progress.get("step") == "scan":
            self._position_failures = 0
        with self._lock:
            if self._cancel.is_set() or self._stop.is_set():
                return
            self._step_deadline = time.monotonic() + 120
            if self.snapshot()['phase'] != 'scanning':
                self._journal.event('recovery_end', outcome='progress', **progress)
            self._change(phase='scanning', last_progress_at=time.time(), next_retry_at=None, failure=None)
            self._journal.event('progress', **progress)
            if self._update_pending and progress.get('step') in ('scan', 'complete', 'recent_wait'):
                self._stop_for_update()

    def _guard(self, cancel):
        blocked_gate = None
        restart_at = None
        last_health = 0
        health_error_at = None
        while not cancel.wait(.1):
            if self._emergency() or self._intent.tombstone.exists() or not self._intent.permit.exists():
                self._user_stop()
                return
            if self._focus_deadline and time.monotonic() >= self._focus_deadline:
                # Native activation can block on another application's queue.
                # Keep this guard responsive and let the watchdog replace us.
                self._restart_requested = True
            if not self._paused.is_set() and self._step_deadline and time.monotonic() >= self._step_deadline:
                self._stop.failure = TimeoutError('Scan step exceeded deadline')
                self._stop.set()
                release_keys()
                self._step_deadline = None
                self._change(phase='rebuilding', message='扫描步骤超时，正在重建任务。')
                blocked_gate = self._stop
                restart_at = time.monotonic() + ABORT_GRACE
                # A blocked scanner may not unwind. Never launch a second
                # input thread; ask the independent process watchdog to restart.
            if restart_at and time.monotonic() >= restart_at:
                if blocked_gate is self._stop and self._attempt_active:
                    self._restart_requested = True
                restart_at = None
            if self._worker and not self._worker.is_alive() and self._desired:
                self._restart_requested = True
            if time.monotonic() - last_health >= 1:
                last_health = time.monotonic()
                state = self.snapshot()
                try:
                    atomic_json(self.collector.home/'scan-health.json', dict(at=time.time(), pid=os.getpid(),
                                monotonic=time.monotonic(), launch_id=os.environ.get('CW_SCANNER_LAUNCH_ID'),
                                session=self._session, restart=self._restart_requested, desired=self._desired,
                                updating=self._update_handoff,
                                **{key:state[key] for key in ('phase','room','channel','last_progress_at','retries','pending_uploads')}))
                    health_error_at = None
                except OSError as error:
                    # A single sharing violation must not kill the guard thread.
                    if health_error_at is None or time.monotonic()-health_error_at > 30:
                        health_error_at = time.monotonic()
                        try:
                            self._journal.event('health_write_retry', error=type(error).__name__)
                        except OSError:
                            pass  # Keep the input guard alive even on a full disk.

    def _focus_permitted(self):
        return (self._desired and not self._cancel.is_set() and not self._paused.is_set()
                and not self._emergency() and not self._intent.tombstone.exists()
                and self._intent.permit.exists())

    def _restore_foreground(self):
        # Called only between attempts, after old input and leases have ended.
        with self._lock:
            if not self._focus_permitted() or time.monotonic() < self._focus_retry_at:
                return False
            self._focus_retry_at = time.monotonic() + 2
            self._focus_deadline = time.monotonic() + 5
        # Never hold the controller lock across a Windows activation call;
        # F9/Stop must still revoke intent if another app's queue is blocked.
        try:
            return focus_game(self._hwnd, allowed=self._focus_permitted)
        except OSError:
            return False  # A locked desktop or vanished window is retried.
        finally:
            self._focus_deadline = None

    def _run(self):
        attempts = 0
        self._position_failures = 0
        try:
            while not self._cancel.is_set():
                if self._paused.is_set():
                    self._cancel.wait(.2)
                    continue
                if time.monotonic() < self._retry_deadline:
                    self._cancel.wait(min(.2, self._retry_deadline - time.monotonic()))
                    continue
                choices = self._windows()
                if not any(w['id'] == self._hwnd for w in choices) and len(choices) == 1:
                    self._hwnd = choices[0]['id']
                    self._change(selected=self._hwnd, windows=choices)
                present = any(w['id'] == self._hwnd for w in choices)
                if not present or not self._game_ready(self._hwnd):
                    self._step_deadline = None
                    self._change(phase='waiting_game', message='正在恢复游戏前台并等待连接。' if present else '等待游戏连接。')
                    if present:
                        self._restore_foreground()
                    self._cancel.wait(.2)
                    continue
                with self._lock:
                    if self._cancel.is_set():
                        break
                    if self._update_pending:
                        # The previous attempt already ended and logged its
                        # result; never open another shop before the restart.
                        self._stop_for_update()
                        break
                    if not self._focus_permitted():
                        continue
                    self._stop = self._modules['LeaseStopEvent']()
                    stop = self._stop
                    self._step_deadline = time.monotonic() + 120
                    self._attempt_active = True
                self._change(phase='rebuilding', message='正在重建扫描任务…', next_retry_at=None)
                self._journal.event('recovery_begin', attempt=attempts + 1)
                error, clean = self._attempt(stop)
                with self._lock:
                    self._attempt_active = False
                self._step_deadline = None
                if not clean:
                    self._restart_requested = True
                    self._change(phase='rebuilding', message='正在重启无响应的扫描组件。')
                    while not self._cancel.wait(.2):
                        pass
                    break
                if self._cancel.is_set():
                    break
                if self._paused.is_set():
                    self._change(phase='paused', message='已暂停，继续时重新领取任务。')
                    continue
                attempts += 1
                from free_market_route import PositionSyncError
                if isinstance(error, PositionSyncError):
                    self._position_failures += 1
                phase, message = failure_state(error, self._position_failures)
                self._journal.event('recovery_wait', attempt=attempts, state=phase, error=type(error).__name__, reason=str(error)[:500],
                                    resource=(system_memory_status() if memory_exhausted(error) else getattr(error, 'resource_diagnostic', None)))
                self._journal.event('recovery_end', outcome='waiting', state=phase)
                self._change(phase=phase, message=message, retries=attempts, failure=message)
                if phase == 'needs_attention':
                    # Keep intent observable, but require an explicit Stop/Start
                    # after repairing storage/credentials. No request storm.
                    self._cancel.wait()
                    break
                delay = retry_delay(attempts, error)
                self._retry_at = time.time() + delay
                self._retry_deadline = time.monotonic() + delay
                self._change(next_retry_at=self._retry_at)
        finally:
            self._stop.set()
            release_keys()
            if not self._desired:
                self._change(phase='needs_attention' if self._halt_reason else 'stopped',
                             stopped_at=time.time(), desired=False, next_retry_at=None,
                             message=self._halt_reason or '扫描已停止，手动采集仍在运行。')

    def _attempt(self, stop):
        threads = []
        assignments = None
        failure = RuntimeError('Scan worker returned without completing service')
        try:
            self._folder = RUNS / 'supervised' / datetime.now().strftime('%Y%m%d_%H%M%S_%f')
            self._folder.mkdir(parents=True, exist_ok=False)
            ready_events = []
            for capture, path in [('channel_capture', 'DEFAULT_STATE'), ('position_capture', 'POSITION_STATE')]:
                capture_ready = threading.Event()
                ready_events.append(capture_ready)
                def listen(capture=capture, path=path, capture_ready=capture_ready):
                    try:
                        self._modules[capture](self._modules[path], stop, ready_event=capture_ready)
                        if not stop.is_set():
                            stop.failure = RuntimeError('Capture worker exited')
                            stop.set()
                    except Exception as error:
                        traceback.print_exc()
                        stop.failure = error
                        stop.set()
                thread = threading.Thread(target=listen, daemon=True, name=capture)
                thread.start()
                threads.append(thread)
            capture_deadline = time.monotonic() + 10
            while not all(event.is_set() for event in ready_events):
                if stop.wait(.05):
                    raise stop.failure or RuntimeError('Capture startup cancelled')
                if time.monotonic() >= capture_deadline:
                    from free_market_route import PositionSyncError
                    raise PositionSyncError('Capture listeners did not become ready')
            config = self.collector.configuration()
            from collector_http import scanner_request
            def transport(action, body):
                began = time.monotonic()
                result = 'ok'
                status_code = None
                diagnostic = None
                try:
                    return scanner_request(config, action, body, stop=stop)
                except Exception as error:
                    result = type(error).__name__
                    status_code = getattr(error, 'code', None)
                    diagnostic = getattr(error, 'request_diagnostic', None)
                    raise
                finally:
                    self._journal.event('request', action=action, result=result,
                                        status_code=status_code,
                                        diagnostic=diagnostic,
                                        duration_ms=round((time.monotonic()-began)*1000))
            started = threading.Event()
            started.set()
            # The sweep engine buys in shops the scanner opens; it decides per visit.
            hooks = dict(shop_callback=scan_shop_callback(self.sweep), capture_receipt=self.sweep.receipt) if self.sweep else {}
            from inventory_check import check_at_start
            def ready(switcher):
                # Reading shop prices does not need the character's inventory.
                # Keep the preflight while buying, as well as per-purchase checks.
                if self.sweep and self.sweep.buying():
                    check_at_start(self.collector.folder, switcher)
            def scan(*args, **kwargs):
                return self._modules['run'](*args, **kwargs,
                    ready_callback=ready)
            if self.sweep and self.sweep.buying() and self.sweep.scan_mode() == 'recent':
                from sweep_routes import run_recent
                outcome = run_recent(self._folder, self._hwnd, started, stop, self._on_scan, self.sweep, scan)
                if not self.sweep.buying():
                    self._user_stop()
            else:
                if self.sweep and self.sweep.buying() and self.sweep.scan_mode() == 'priority':
                    from sweep_routes import run_recent
                    run_recent(self._folder, self._hwnd, started, stop, self._on_scan, self.sweep, scan, once=True)
                    if not self.sweep.buying():
                        stop.set()
                    self.sweep.progress('全市场扫描')
                progress_type = self._modules.get('AssignedProgress')
                progress_options = {'progress': progress_type(self.collector.home/'scan-progress.json')} if progress_type else {}
                assignments = self._modules['CloudScan'](config, stop, self._on_scan,
                    paused=self._modules['is_paused'], session=self._session, transport=transport,
                    diagnostic=self._journal.event, **progress_options)
                outcome = scan(self._folder, self._hwnd, started, stop,
                                              self._on_scan, assignments=assignments, **hooks)
            if outcome and outcome.get('reason') == 'room_scan_incomplete':
                raise RuntimeError('Room scan incomplete')
        except Exception as error:
            failure = error
            from sweep_purchase import purchase_halted, purchase_halt_message
            from inventory_check import inventory_check_failed
            if inventory_check_failed(error) or purchase_halted(error):
                # Preserve the concrete cause in the existing attention panel
                # and activity feed instead of reporting an unexplained user stop.
                cause = error
                seen = set()
                while id(cause) not in seen:
                    seen.add(id(cause))
                    nested = cause.__cause__ or cause.__context__
                    if nested is None:
                        break
                    cause = nested
                message = '背包核对失败：'+str(cause) if inventory_check_failed(error) else purchase_halt_message(error)
                self._user_stop(reason=message)
            elif any(s in str(error).lower() for s in ('stopped with f9', 'mouse failsafe')):
                self._user_stop()
        finally:
            failure = getattr(stop, 'failure', None) or failure
            stop.set()
            self._modules['clear_pause']()
            release_keys()
            if assignments:
                try:
                    assignments.close()
                except Exception:
                    traceback.print_exc()
            for thread in threads:
                thread.join(timeout=2)
        monitor = getattr(assignments, 'thread', None)
        clean = not any(thread.is_alive() for thread in threads)
        if isinstance(monitor, threading.Thread):
            clean = clean and not monitor.is_alive()
        return failure, clean

    def read_local_status(self):
        folder = self.collector.folder
        if getattr(self.collector, 'remote_debug', None):
            self._change(remote_debug=self.collector.remote_debug.view())
        if getattr(self.collector, 'diagnostics', None):
            self._change(diagnostics=self.collector.diagnostics.view())
        if time.monotonic() - self._last_prune > 60:
            self._last_prune = time.monotonic()
            prune_diagnostics(RUNS/'supervised')
        if self.sweep:
            self._change(sweep=self.sweep.summary())
            self.sync_sweep()
        try:
            capture = json.loads((folder/'passive_status.json').read_text(encoding='utf-8'))
            fresh = 0 <= time.time() - capture.get('time', 0) < 10
            health = capture.get('health_state', 'waiting')
            if not fresh:
                health = 'offline'
            elif capture.get('decoding', 0):
                health = 'connected'
            # A short capture caveat (e.g. accelerator connection unavailable).
            warning = capture.get('capture_warning') if fresh else None
            warning = warning.strip()[:60] if isinstance(warning, str) and warning.strip() else None
            self._change(capture=health, last_shop_at=capture.get('last_shop_at'), capture_warning=warning)
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        try:
            update = json.loads((self.collector.home/'update-status.json').read_text(encoding='utf-8'))
            self._change(updates=update.get('state', 'checking'), update_version=update.get('available'))
        except (OSError, ValueError):
            pass

    def sync_sweep(self):
        """A newly accepted web run starts its route once, never after a manual stop."""
        if self._update_pending:
            return
        if getattr(self.collector, 'remote_debug', None) and self.collector.remote_debug.view()['active']:
            return
        if not self.sweep:
            return
        with self.sweep.lock:
            run = self.sweep.run['id'] if self.sweep.buying() else None
            mode = self.sweep.scan_mode()
        previous = self._observed_sweep
        if run != previous:
            self._observed_sweep = run
            self._pending_sweep = run
            if run and self._desired and mode == 'market':
                self._pending_sweep = None
                self._sweep_handled(run)
            elif self._desired and (run or getattr(self, '_sweep_started', None)):
                self._user_stop(persist=False)
        if run and getattr(self, '_pending_sweep', None) == run and (not self._worker or not self._worker.is_alive()):
            choices = self._windows()
            if len(choices) == 1:
                if self._intent.load().get('enabled'):
                    self.start(choices[0]['id'], restore=True)
                else:
                    self.start(choices[0]['id'])
                self._pending_sweep = None
                self._sweep_started = run
                self._sweep_handled(run)

    def _sweep_handled(self, run):
        # A later Stop/F9 must hold across an update or reopen of this run.
        try:
            atomic_json(self.collector.home/SWEEP_HANDLED, dict(run=run, at=time.time()))
        except OSError:
            pass  # Same-process behaviour is unchanged; only a reopen could restart it.

    def _show_watchdog_stop(self):
        path = self.collector.home/WATCHDOG_STOP
        if read_json(path).get('reason') == 'crash_loop':
            message = '采集器短时间内多次异常退出，已停止自动扫描。请点“报 Bug”，然后再开始。'
            self._change(phase='error', message=message, failure=message)
            self._activity(message, 'error')
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def pump(self, auto_start=False):
        self.refresh()
        self._activity('扫描器已就绪。')
        self._show_watchdog_stop()
        saved = self._intent.load()
        if auto_start or saved.get('enabled'):
            try:
                # Only reuse the same existing window. If it disappeared, wait
                # for an unambiguous game window rather than trust a reused HWND.
                self.start(self.snapshot()['selected'], restore=not auto_start)
            except Exception as error:
                self._change(phase='error', message=str(error))
        last = ''
        while not self._closed.is_set():
            try:
                self._events.get(timeout=1)
            except queue.Empty:
                pass
            while not self._events.empty():
                self._events.get_nowait()
            # Local health freshness only; no network polling and no repeated
            # directory/history scans. Scanner/upload events arrive directly.
            self.read_local_status()
            if not self._worker and self._intent.load().get('enabled') and not self.collector.error:
                choices = self._windows()
                if len(choices) == 1:
                    try:
                        self.start(choices[0]['id'], restore=True)
                    except (RuntimeError, ValueError):
                        pass
            if self.collector.error:
                self._stop.set()
                self._change(capture='offline', message='采集服务已停止，请重新启动程序。')
                self._activity('采集服务已停止，请重新启动程序。', 'warning')
                if self._desired and self.snapshot()['phase'] != 'needs_attention':
                    self._restart_requested = True
            if self.collector.stopped() and not self.collector.error:
                self.close()  # Also after an update: the new process waits for Start.
            value = json.dumps(self.snapshot(), ensure_ascii=False)
            if value != last and self._window and self._ready:
                try:
                    self._window.evaluate_js('window.dispatchEvent(new CustomEvent("scanner-state", {detail:' + value + '}))')
                    last = value
                except Exception:
                    pass
            self._closed.wait(.1)

    def close(self):
        if not self._closing:
            self._closing = True
            self._user_stop()
            self._modules['clear_pause']()
            self._change(phase='stopping', message='正在保存并退出…')
            def finish():
                if self._worker:
                    self._worker.join(timeout=40)
                release_keys()
                if self.sweep:
                    self.sweep.close()
                self.collector.close()
                self.collector.thread.join(timeout=40)
                self._closed.set()
                if self._window:
                    self._window.destroy()
            threading.Thread(target=finish, daemon=True).start()
        return self._closed.is_set()


class DesktopAPI:
    """The only methods exposed to bundled, local React code."""
    def __init__(self, controller):
        self._controller = controller
        from desktop_workspace import DesktopWorkspace
        self._workspace = DesktopWorkspace(controller.collector, controller.sweep)

    def ready(self):
        self._controller._ready = True
        return self._controller.refresh()

    def command(self, name, value=None):
        return self._controller.command(name, value)

    def workspace(self, name, value=None):
        return self._workspace.run(name, value)


def desktop_entry_url(assets):
    # Persistent WebView profiles reuse the local HTTP origin between upgrades.
    # Hash the entry document (which references hashed JS/CSS) so a cached old
    # index cannot load an old UI while the Python bridge reports a new version.
    revision = hashlib.sha256(assets.read_bytes()).hexdigest()[:20]
    return f'{assets}?ui={revision}'


def main(collector, argv=None):
    import argparse
    import webview
    parser = argparse.ArgumentParser()
    parser.add_argument('--auto-start', action='store_true')
    parser.add_argument('--stop-after-visits', type=int, default=0)
    parser.add_argument('--exit-after-stop', action='store_true')
    parser.add_argument('--trace-channels', action='store_true')
    args = parser.parse_args(argv)
    if args.trace_channels:
        os.environ['CW_SCANNER_CHANNEL_TRACE'] = str(RUNS / ('channel_diagnostics_' + datetime.now().strftime('%Y%m%d_%H%M%S')))
    from collector_sweep import create_engine
    sweep = create_engine(collector)
    sweep.start()
    controller = DesktopController(collector, sweep=sweep)
    controller._bound = max(0, args.stop_after_visits)
    assets = Path(__file__).resolve().parent/'desktop_ui/index.html'
    if not assets.is_file():
        raise RuntimeError('界面文件缺失，请完整解压安装包。')
    window = webview.create_window('枫叶市集 · 扫描与采集', desktop_entry_url(assets), js_api=DesktopAPI(controller),
        width=MIN_SIZE[0], height=MIN_SIZE[1], resizable=True, min_size=MIN_SIZE, background_color='#e6e1d6',
        frameless=True, easy_drag=False, shadow=True)
    controller._window = window
    window.events.closing += controller.close
    window.events.maximized += lambda: controller._change(maximized=True)
    window.events.restored += lambda: controller._change(maximized=False)
    def run():
        controller.pump(args.auto_start)
    if args.exit_after_stop:
        def bounded_close():
            while not controller._closed.wait(.25):
                if controller._worker and not controller._worker.is_alive():
                    controller.close()
                    return
        threading.Thread(target=bounded_close, daemon=True).start()
    webview.settings['ALLOW_FILE_URLS'] = False
    webview.start(run, gui='edgechromium', private_mode=False,
                  icon=str(Path(__file__).resolve().parent / ('app-icon.ico' if getattr(sys, 'frozen', False) else 'assets/app-icon.ico')),
                  storage_path=str(collector.home/'desktop-webview'), debug=False)
