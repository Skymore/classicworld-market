"""One launcher for manual capture, automatic scanning, accounts and uploads."""
import json
import os
import sys
import threading
import time
from pathlib import Path

HOME = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ClassicWorldMarket'


def prepare_standard_streams():
    """Keep updater diagnostic pipes working in the windowed Windows build.

    PyInstaller sets Python streams to None without a console, even when an
    older updater supplies stdout/stderr pipes. Reuse those inherited handles;
    never allocate or attach a console for a normal desktop launch.
    """
    if os.name != 'nt':
        return
    import ctypes
    import msvcrt
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE,
        wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
        wintypes.BOOL, wintypes.DWORD]
    kernel.DuplicateHandle.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    process = kernel.GetCurrentProcess()
    for name, number, mode, flags in [('stdin', -10, 'r', os.O_RDONLY),
                                    ('stdout', -11, 'w', os.O_WRONLY),
                                    ('stderr', -12, 'w', os.O_WRONLY)]:
        if getattr(sys, name) is not None:
            continue
        handle = kernel.GetStdHandle(number)
        stream = None
        if handle and kernel.GetFileType(handle) in (1, 3):  # disk or pipe
            duplicate = wintypes.HANDLE()
            if kernel.DuplicateHandle(process, handle, process,
                                      ctypes.byref(duplicate), 0, False, 2):
                try:
                    fd = msvcrt.open_osfhandle(duplicate.value, flags | os.O_BINARY)
                except OSError:
                    kernel.CloseHandle(duplicate)
                else:
                    stream = os.fdopen(fd, mode, encoding='utf-8', errors='replace', buffering=1)
        setattr(sys, name, stream or open(os.devnull, mode, encoding='utf-8'))


class CollectorRuntime:
    def __init__(self, options, launch_argv):
        self.home = options.home
        self.config_path = options.config or self.home/'member.json'
        self.folder = options.folder or self.home/'captures'
        self._listeners = []
        self._stats_lock = threading.Lock()
        self._captured_files = set()
        self._stats = dict(run_started_at=time.time(), run_shops=0, run_items=0)
        self.capture_args = ['--no-browser','--home',str(self.home),'--config',str(self.config_path),
                             '--backend',options.backend]
        if options.folder:
            self.capture_args += ['--folder',str(options.folder)]
        if options.no_update:
            self.capture_args.append('--no-update')
        self.launch_argv = launch_argv
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.error = None
        self.config = None
        self.thread = threading.Thread(target=self._run, name='market-collector', daemon=True)
        self.thread.start()

    def _run(self):
        try:
            from shared_client import ensure_identity, main
            self.home.mkdir(parents=True, exist_ok=True)
            self.config = ensure_identity(self.config_path)
            self.ready.set()
            main(self.capture_args, stop_event=self.stop_event, update_argv=self.launch_argv,
                 on_event=self._notify)
        except Exception as error:
            import traceback
            self.error = str(error)
            print(json.dumps(dict(time=time.time(),event='collector_runtime_failed',
                error=type(error).__name__,message=str(error))),flush=True)
            traceback.print_exc()
            self.ready.set()

    def add_listener(self, callback):
        self._listeners.append(callback)

    def _notify(self, event):
        events = (event,)
        if event.get('type') == 'captured':
            filename, items = event.get('file'), event.get('items')
            if not isinstance(filename, str) or not filename or type(items) is not int or items < 0:
                return
            with self._stats_lock:
                if filename in self._captured_files:
                    return
                self._captured_files.add(filename)
                self._stats['run_shops'] += 1
                self._stats['run_items'] += items
                # The sweep engine pairs a shop visit with this capture file.
                events = (event, dict(type='run_stats', **self._stats))
        for listener in tuple(self._listeners):
            for item in events:
                try:
                    listener(item)
                except Exception:
                    pass

    def statistics(self):
        with self._stats_lock:
            return dict(self._stats)

    def configuration(self):
        if not self.ready.wait(10):
            raise RuntimeError('正在连接采集服务，请稍后再开始。')
        if self.error:
            raise RuntimeError('采集未启动：' + self.error)
        return self.config

    def open_dashboard(self):
        import webbrowser
        try:
            state = json.loads((self.home / 'dashboard.json').read_text(encoding='utf-8'))
            port = int(state.get('port', 8780))
        except (OSError, ValueError):
            port = 8780
        webbrowser.open(f'http://127.0.0.1:{port}')

    def stopped(self):
        return self.stop_event.is_set()

    def close(self):
        self.stop_event.set()
        return not self.thread.is_alive()


def main():
    prepare_standard_streams()
    from shared_client import main as collector_main
    if '--scanner-self-test' in sys.argv:
        from scanner_desktop import scanner_modules
        scanner_modules()
        from channel_plan import ChannelPlan
        from cloud_scan import LeaseStopEvent
        import cv2, numpy, mss, webview, clr
        assert (Path(__file__).resolve().parent/'desktop_ui/index.html').is_file()
        assert ChannelPlan().channel == 1
        assert not LeaseStopEvent().is_set()
        print('Scanner self-test passed', flush=True)
        return
    collector_commands = {'--version','--self-test','--check-updates','--repair-history','--apply-update',
        '--legacy-update-bridge','--check-firewall','--once','--setup','--dashboard-only',
        '--capture-only','--upload-only','--proxy'}
    # Internal dashboard/update children and existing command-line tools retain
    # the same executable and protocol. They must never spawn another GUI.
    if any(arg in collector_commands for arg in sys.argv[1:]):
        collector_main()
        return
    import ctypes
    if not ctypes.windll.shell32.IsUserAnAdmin():
        import subprocess
        command = sys.argv[1:] if getattr(sys, 'frozen', False) else sys.argv
        result = ctypes.windll.shell32.ShellExecuteW(None, 'runas', sys.executable,
            subprocess.list2cmdline(command), None, 1)
        if result <= 32:
            raise PermissionError('Administrator permission was declined')
        return
    if '--supervised' not in sys.argv:
        import argparse
        from collector_watchdog import run as supervise
        options = argparse.ArgumentParser(add_help=False)
        options.add_argument('--home', type=Path, default=HOME)
        home = options.parse_known_args()[0].home
        home.mkdir(parents=True, exist_ok=True)
        kernel = ctypes.windll.kernel32
        kernel.CreateMutexW.restype = ctypes.c_void_p
        supervisor_mutex = kernel.CreateMutexW(None, False, 'Local\\ClassicWorldMarketSupervisor')
        if not supervisor_mutex or kernel.GetLastError() == 183:
            return
        try:
            supervise(home, sys.argv[1:])
        finally:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(supervisor_mutex)
        return
    sys.argv.remove('--supervised')
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.restype = ctypes.c_void_p
    mutex = kernel.CreateMutexW(None, False, 'Local\\ClassicWorldMarketUnified')
    if not mutex or kernel.GetLastError() == 183:
        ctypes.windll.user32.MessageBoxW(None,
            '扫描器已经在运行，请使用已打开的窗口。', '枫叶市集', 0x40)
        return
    import argparse
    parser=argparse.ArgumentParser(add_help=False)
    parser.add_argument('--home',type=Path,default=HOME)
    parser.add_argument('--config',type=Path)
    parser.add_argument('--folder',type=Path)
    parser.add_argument('--backend',choices=('windows','windivert'),default='windows')
    parser.add_argument('--no-update',action='store_true')
    parser.add_argument('--no-browser',action='store_true')
    # An updater must not replay a prior one-shot CLI Start after the user
    # pressed Stop. Restart authorization comes exclusively from saved intent.
    launch_argv=[arg for arg in sys.argv[1:] if arg != '--auto-start']
    options,scanner_argv=parser.parse_known_args()
    sys.argv=[sys.argv[0],*scanner_argv]
    options.home.mkdir(parents=True, exist_ok=True)
    from collector_recovery import RotatingOutput
    log = RotatingOutput(options.home / 'unified-client.log')
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = log
    runtime = CollectorRuntime(options,launch_argv)
    from scanner_desktop import main as scanner_main
    try:
        scanner_main(collector=runtime)
    finally:
        runtime.close()
        runtime.thread.join(timeout=90)
        sys.stdout, sys.stderr = old_stdout, old_stderr
        log.close()
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle(mutex)


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    try:
        main()
    except Exception as error:
        import traceback
        prepare_standard_streams()
        traceback.print_exc()
        # Diagnostic commands must return failure, not block an old updater on
        # PyInstaller's exception dialog until its timeout expires.
        diagnostic = any(arg in sys.argv for arg in ('--scanner-self-test', '--self-test',
            '--version', '--check-updates', '--apply-update', '--dashboard-only'))
        if not diagnostic:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,
                '启动未完成，请确认安装包已完整解压。\n' + str(error), '枫叶市集', 0x10)
        raise SystemExit(1)
