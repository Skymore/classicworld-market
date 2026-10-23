"""Single-instance, receive-only collector for the Windows startup task."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, default=ROOT/'network_captures/market_live')
    args = parser.parse_args()
    folder = args.folder.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    log = (folder/'capture-service.log').open('a', encoding='utf-8', buffering=1)
    sys.stdout = sys.stderr = log
    if sys.platform != 'win32':
        raise RuntimeError('Windows is required')
    import ctypes
    import msvcrt
    if not ctypes.windll.shell32.IsUserAnAdmin():
        raise PermissionError('The startup collector requires administrator permission')
    with (folder/'capture-service.lock').open('a+b') as lock:
        lock.seek(0, 2)
        if lock.tell() == 0:
            lock.write(b'1');lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            print('Read-only capture service already running', flush=True)
            return
        (folder/'capture-service.pid').write_text(str(os.getpid()), encoding='ascii')
        from market_passive import run
        print(json.dumps(dict(event='capture_service_started', time=time.time(),
                              pid=os.getpid(), version='0.5.6', mode='windows-raw-receive-only')), flush=True)
        while True:
            try:
                run(folder,backend="windows")
            except KeyboardInterrupt:
                break
            except Exception:
                traceback.print_exc()
                print('Capture stopped unexpectedly; retrying in 15 seconds', flush=True)
                time.sleep(15)
            else:
                break


if __name__ == '__main__':
    main()
