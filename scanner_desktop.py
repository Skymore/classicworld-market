"""Local React desktop shell. Game actions stay in the existing scanner engine."""
import ctypes
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

RUNS = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ClassworldFMBot/screen_scanner'


def scanner_modules():
    from channel_state_collector import DEFAULT_STATE, run as channel_capture
    from position_state_collector import POSITION_STATE, run as position_capture
    from full_market_scan import run
    from cloud_scan import CloudScan, LeaseStopEvent
    from control_state import clear_pause, is_paused, request_pause
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


def focus_game(hwnd):
    user = ctypes.windll.user32
    for name in ('IsIconic', 'BringWindowToTop', 'SetForegroundWindow'):
        getattr(user, name).argtypes = [ctypes.c_void_p]
    user.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    if user.IsIconic(hwnd):
        user.ShowWindow(hwnd, 9)
    user.BringWindowToTop(hwnd)
    user.SetForegroundWindow(hwnd)


def release_keys():
    from market_keyboard import send_key
    for key in ('left', 'right', 'up', 'down', 'space'):
        try:
            send_key(key, False)
        except OSError:
            pass


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
    labels = {'full_preparing_capture': '正在连接游戏', 'waiting_for_game_foreground': '请将游戏切换到前台',
              'loading_keyboard_and_screenshot_backend': '正在准备扫描', 'started': '正在识别摊位',
              'route_calibration_connecting': '正在确认当前频道'}
    if value in labels:
        return labels[value]
    # Keep ordinary Chinese coordination messages; internal event names stay in logs.
    return value if re.search('[\u4e00-\u9fff]', value) else None


class DesktopController:
    def __init__(self, collector, *, modules=None, windows=game_windows, sweep=None):
        self.collector = collector
        self.sweep = sweep
        self._modules = modules or scanner_modules()
        self._windows = windows
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
                           selected=None, theme='system', updates='checking', activities=[])
        try:
            prefs = json.loads((collector.home/'desktop-settings.json').read_text(encoding='utf-8'))
            if prefs.get('theme') in ('light', 'dark', 'system'):
                self._state['theme'] = prefs['theme']
        except (OSError, ValueError):
            pass
        collector.add_listener(self._collector_event)
        self._read_statistics()

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

    def _activity(self, text, kind='info'):
        with self._lock:
            items = self._state['activities']
            if items and items[0]['text'] == text:
                return
            items.insert(0, dict(at=time.time(), text=text, kind=kind))
            del items[8:]
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
        if name == 'window':
            if value not in ('minimize', 'close'):
                raise ValueError('无效窗口操作')
            if self._window:
                if value == 'close':
                    self.close()
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
                if self._state['phase'] != 'scanning':
                    return self.snapshot()
                self._modules['request_pause']()
                release_keys()
                self._change(phase='paused', message='已暂停，扫描进度已保留。')
        elif name == 'resume':
            with self._lock:
                if self._state['phase'] != 'paused' or self._stop.is_set():
                    return self.snapshot()
                if self._window:
                    self._window.minimize()
                focus_game(self._hwnd)
                self._modules['clear_pause']()
                self._change(phase='scanning', message='继续扫描当前任务。')
        elif name == 'stop':
            if self._worker and self._worker.is_alive():
                self._stop.set()
                self._modules['clear_pause']()
                release_keys()
                self._change(phase='stopping', message='正在停止并保存进度…')
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

    def start(self, hwnd):
        with self._lock:
            if self._worker and self._worker.is_alive():
                return
            choices = self._windows()
            if type(hwnd) is not int or hwnd not in [w['id'] for w in choices]:
                raise ValueError('请打开游戏并重新选择游戏窗口。')
            if self.collector.error or self.collector.stopped():
                raise ValueError('采集服务未连接，请重新启动程序。')
            self._stop.clear()
            self._modules['clear_pause']()
            self._hwnd = hwnd
            self._change(phase='scanning', mode='scan', selected=hwnd, visited=0, room=None,
                         channel=None, started_at=time.time(), stopped_at=None, message='正在连接游戏并领取任务…')
            if self._window:
                self._window.minimize()
            focus_game(hwnd)
            self._worker = threading.Thread(target=self._run, name='shop-scanner', daemon=True)
            self._worker.start()

    def _on_scan(self, message):
        if isinstance(message, tuple) and message[0] == 'progress':
            progress = message[1]
            self._change(channel=progress.get('channel'), visited=progress.get('visited', 0))
            if self._bound and progress.get('visited', 0) >= self._bound:
                self._stop.set()
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

    def _run(self):
        threads = []
        assignments = None
        failed = False
        try:
            self._folder = RUNS / datetime.now().strftime('%Y%m%d_%H%M%S_%f')
            self._folder.mkdir(parents=True, exist_ok=False)
            for capture, path in [('channel_capture', 'DEFAULT_STATE'), ('position_capture', 'POSITION_STATE')]:
                def listen(capture=capture, path=path):
                    try:
                        self._modules[capture](self._modules[path], self._stop)
                    except Exception:
                        traceback.print_exc()
                        self._activity('游戏连接读取失败，请停止后重新开始。', 'warning')
                        self._stop.set()
                thread = threading.Thread(target=listen, daemon=True, name=capture)
                thread.start()
                threads.append(thread)
            assignments = self._modules['CloudScan'](self.collector.configuration(), self._stop,
                self._on_scan, paused=self._modules['is_paused'])
            started = threading.Event()
            started.set()
            # The sweep engine buys in shops the scanner opens; it decides per visit.
            hooks = dict(shop_callback=self.sweep.on_shop_open, capture_receipt=self.sweep.receipt) if self.sweep else {}
            outcome = self._modules['run'](self._folder, self._hwnd, started, self._stop,
                                          self._on_scan, assignments=assignments, **hooks)
            if outcome and outcome.get('reason') == 'room_scan_incomplete':
                raise RuntimeError('当前洞扫描未完成，请重新开始。')
        except Exception as error:
            cancelled = self._stop.is_set() or any(s in str(error).lower() for s in (
                'stopped from scanner', 'stopped with f9', 'mouse failsafe', 'game lost foreground'))
            failed = not cancelled
            if failed:
                if self._folder:
                    (self._folder/'error.txt').write_text(traceback.format_exc(), encoding='utf-8')
                self._activity('扫描中断，进度已保存。请确认游戏连接后重试。', 'warning')
            elif 'game lost foreground' in str(error).lower():
                self._activity('游戏离开前台，已停止自动扫描。', 'warning')
        finally:
            self._stop.set()
            self._modules['clear_pause']()
            release_keys()
            if assignments:
                try:
                    assignments.close()
                except Exception:
                    traceback.print_exc()
            for thread in threads:
                thread.join(timeout=2)
            reason = getattr(self._stop, 'reason', None)
            self._change(phase='error' if failed else 'stopped', stopped_at=time.time(),
                         message=reason or ('扫描中断，确认游戏连接后可重新开始。' if failed else '扫描已停止，手动采集仍在运行。'))
            if self._window and not self._closing:
                self._window.restore()

    def read_local_status(self):
        folder = self.collector.folder
        if self.sweep:
            self._change(sweep=self.sweep.summary())
        try:
            capture = json.loads((folder/'passive_status.json').read_text(encoding='utf-8'))
            fresh = 0 <= time.time() - capture.get('time', 0) < 10
            health = capture.get('health_state', 'waiting')
            if not fresh:
                health = 'offline'
            elif capture.get('decoding', 0):
                health = 'connected'
            self._change(capture=health, last_shop_at=capture.get('last_shop_at'))
        except (OSError, ValueError, TypeError):
            pass
        try:
            update = json.loads((self.collector.home/'update-status.json').read_text(encoding='utf-8'))
            self._change(updates=update.get('state', 'checking'))
        except (OSError, ValueError):
            pass

    def pump(self, auto_start=False):
        self.refresh()
        self._activity('扫描器已就绪。')
        if auto_start:
            try:
                self.start(self.snapshot()['selected'])
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
            if self.collector.error:
                self._stop.set()
                self._change(capture='offline', message='采集服务已停止，请重新启动程序。')
                self._activity('采集服务已停止，请重新启动程序。', 'warning')
            if self.collector.stopped() and not self.collector.error:
                self.close()
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
            self._stop.set()
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
    window = webview.create_window('枫叶市集 · 扫描与采集', str(assets), js_api=DesktopAPI(controller),
        width=880, height=740, resizable=False, background_color='#e6e1d6',
        frameless=True, easy_drag=False, shadow=True)
    controller._window = window
    window.events.closing += controller.close
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
