"""One launcher for manual capture, automatic scanning, accounts and uploads."""
import json
import os
import sys
import threading
import time
from pathlib import Path

HOME = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ClassicWorldMarket'


class CollectorRuntime:
    def __init__(self, options, launch_argv):
        self.home = options.home
        self.config_path = options.config or self.home/'member.json'
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
            main(self.capture_args, stop_event=self.stop_event, update_argv=self.launch_argv)
        except Exception as error:
            self.error = str(error)
            self.ready.set()

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
    from shared_client import main as collector_main
    if '--scanner-self-test' in sys.argv:
        from market_screen_scanner.scanner_gui import ScannerWindow
        from channel_plan import ChannelPlan
        from cloud_scan import LeaseStopEvent
        import cv2, numpy, mss, tkinter
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
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.restype = ctypes.c_void_p
    mutex = kernel.CreateMutexW(None, False, 'Local\\ClassicWorldMarketUnified')
    if not mutex or kernel.GetLastError() == 183:
        from tkinter import messagebox
        messagebox.showinfo('枫叶市集', '采集器已经在运行，请使用已打开的窗口。')
        return
    import argparse
    parser=argparse.ArgumentParser(add_help=False)
    parser.add_argument('--home',type=Path,default=HOME)
    parser.add_argument('--config',type=Path)
    parser.add_argument('--folder',type=Path)
    parser.add_argument('--backend',choices=('windows','windivert'),default='windows')
    parser.add_argument('--no-update',action='store_true')
    parser.add_argument('--no-browser',action='store_true')
    launch_argv=sys.argv[1:]
    options,scanner_argv=parser.parse_known_args()
    sys.argv=[sys.argv[0],*scanner_argv]
    options.home.mkdir(parents=True, exist_ok=True)
    log = (options.home / 'unified-client.log').open('a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = log
    runtime = CollectorRuntime(options,launch_argv)
    from market_screen_scanner.scanner_gui import main as scanner_main
    try:
        scanner_main(collector=runtime)
    finally:
        runtime.close()
        runtime.thread.join(timeout=90)
        log.close()
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle(mutex)


if __name__ == '__main__':
    main()
