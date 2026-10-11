"""Passive Windows market capture monitor; Python standard library only."""
import argparse
import csv
import ctypes
from datetime import datetime
import io
import json
from pathlib import Path
import queue
import re
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, errors='replace',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1:]}: {result.stdout} {result.stderr}')
    return result.stdout.strip()


def parse_connections(text, pids):
    endpoints = set()
    records = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 5 or parts[0] != 'TCP':
            continue
        if not parts[4].isdigit() or int(parts[4]) not in pids:
            continue
        remote, port = parts[2].rsplit(':', 1)
        remote = remote.strip('[]')
        if remote in ('0.0.0.0', '::', '127.0.0.1', '::1') or port == '0':
            continue
        endpoints.add((remote, int(port)))
        records.append(dict(pid=int(parts[4]), local=parts[1], remote=parts[2], state=parts[3]))
    return endpoints, records


def connections():
    tasks = csv.reader(io.StringIO(command('tasklist.exe', '/FI', 'IMAGENAME eq MapleStory.exe', '/FO', 'CSV', '/NH')))
    pids = {int(row[1]) for row in tasks if len(row) >= 2 and row[0].lower() == 'maplestory.exe' and row[1].isdigit()}
    return parse_connections(command('netstat.exe', '-ano', '-p', 'tcp'), pids)


def no_filters(text):
    return bool(re.fullmatch(r'(Packet Filters:\s*None|No filters\.?|\u6ca1\u6709\u7b5b\u9009\u5668[\u3002.]?|\u6ca1\u6709\u8fc7\u6ee4\u5668[\u3002.]?|\u65e0\u7b5b\u9009\u5668[\u3002.]?)', text.strip()))


class Capture:
    def __init__(self, folder, event):
        self.folder, self.event = folder, event
        self.started = False
        self.owns_filters = False
        self.etl = None
        self.index = 0

    def finish(self):
        if self.started:
            self.event('pktmon_stop', output=command('pktmon.exe', 'stop'))
            self.started = False
        if self.owns_filters:
            command('pktmon.exe', 'filter', 'remove')
            self.owns_filters = False
        if self.etl is not None:
            # Multi-file mode can create numbered ETLs; preserve every original.
            for etl in sorted(self.folder.glob(self.etl.stem + '*.etl')):
                target = etl.with_suffix('.pcapng')
                if not target.exists():
                    self.event('converted', file=str(target), output=command(
                        'pktmon.exe', 'etl2pcap', str(etl), '--out', str(target)))
            self.etl = None

    def start(self, endpoints):
        if not no_filters(command('pktmon.exe', 'filter', 'list')):
            raise RuntimeError('Existing PktMon filters found. Not changing another capture.')
        # Check before touching global filters. Unknown/localized status fails closed.
        status = command('pktmon.exe', 'status')
        if not re.search(r'(?i)\b(stopped|not running)\b|\u5df2\u505c\u6b62|\u672a\u8fd0\u884c', status):
            raise RuntimeError('Cannot confirm PktMon is stopped: ' + status)
        for index, (ip, port) in enumerate(sorted(endpoints)):
            command('pktmon.exe', 'filter', 'add', f'MarketMonitor_{index}', '-t', 'TCP', '-i', ip, '-p', str(port))
            self.owns_filters = True
        self.index += 1
        self.etl = self.folder / f'segment_{self.index:04d}.etl'
        command('pktmon.exe', 'start', '--capture', '--comp', 'all', '--pkt-size', '0',
                '--file-size', '16', '--log-mode', 'multi-file', '--file-name', str(self.etl))
        self.started = True
        self.event('capture_started', endpoints=sorted(endpoints), file=str(self.etl))


def main(args):
    if not ctypes.windll.shell32.IsUserAnAdmin():
        raise RuntimeError('Administrator required. Run start_market_monitor.ps1.')
    folder = ROOT / 'network_captures' / ('monitor_' + datetime.now().strftime('%Y%m%d_%H%M%S'))
    folder.mkdir(parents=True)
    def event(kind, **fields):
        with (folder / 'events.jsonl').open('a', encoding='utf-8') as file:
            file.write(json.dumps(dict(time=datetime.now().astimezone().isoformat(), event=kind, **fields)) + '\n')
    labels = queue.Queue()
    def read_labels():
        while True:
            try:
                labels.put(input())
            except EOFError:
                return
    threading.Thread(target=read_labels, daemon=True).start()
    print(f'Output: {folder}', flush=True)
    print('Type an action label + Enter to mark it. Type quit + Enter to stop; Ctrl+C also stops.', flush=True)
    print('Examples: open Equips and Tings / close / change channel', flush=True)
    print('Waiting for MapleStory connections. Capture begins only after CAPTURING appears.', flush=True)
    capture = Capture(folder, event)
    began = time.monotonic()
    rotated = began
    active = set()
    previous = None
    try:
        while time.monotonic() - began < args.minutes*60:
            while not labels.empty():
                label = labels.get_nowait()
                event('user_marker', label=label)
                if label.strip().lower() == 'quit':
                    return
            endpoints, records = connections()
            signature = json.dumps(records, sort_keys=True)
            if signature != previous:
                event('connections', connections=records)
                previous = signature
            size = sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
            if size >= args.max_mb*1024*1024:
                print('Storage budget reached; stopping. Conversion may add more disk usage.', flush=True)
                break
            if endpoints != active or (capture.started and time.monotonic()-rotated >= args.segment_seconds):
                capture.finish()
                if len(endpoints) > 32:
                    raise RuntimeError('More than 32 endpoints; cannot capture all with PktMon filters.')
                if endpoints:
                    capture.start(endpoints)
                    print(f'CAPTURING segment {capture.index}: {len(endpoints)} endpoints', flush=True)
                else:
                    print('Game has no detected TCP connections; waiting.', flush=True)
                active = endpoints
                rotated = time.monotonic()
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        print('Stopping...', flush=True)
    finally:
        capture.finish()
        event('monitor_stopped')
        print(f'Saved: {folder}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--minutes', type=float, default=60)
    parser.add_argument('--max-mb', type=int, default=512)
    parser.add_argument('--segment-seconds', type=float, default=60)
    parser.add_argument('--poll-seconds', type=float, default=1)
    args = parser.parse_args()
    if min(args.minutes, args.max_mb, args.segment_seconds, args.poll_seconds) <= 0:
        parser.error('All limits must be positive')
    try:
        main(args)
    except Exception as error:
        print(f'ERROR: {error}', flush=True)
        raise SystemExit(1)
