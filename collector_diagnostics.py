"""Opt-in, bounded diagnostic upload. Never reads credentials or capture payload files."""
import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from collector_recovery import atomic_json, read_json
from collector_update import VERSION

RETENTION = 7 * 86400
MAX_BATCH = 60 * 1024
MAX_QUEUE = 64 * 1024 * 1024
SENSITIVE = re.compile(r'token|secret|password|authorization|cookie|credential|api_key|account|email|nickname|character|owner|holdings|inventory|payload|raw|prefix|body|items|title|name', re.I)


def redact(value, secrets=()):
    if isinstance(value, dict):
        return {k: redact(v, secrets) for k, v in value.items() if not SENSITIVE.search(k)}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value[:40]]
    if not isinstance(value, str):
        return value
    for secret in secrets:
        if isinstance(secret, str) and len(secret) >= 8:
            value = value.replace(secret, '[redacted]')
    value = re.sub(r'(?i)(bearer\s+)[^\s"\',}]+', r'\1[redacted]', value)
    value = re.sub(r'(?i)(?:token|secret|password|authorization|cookie)\s*[=:]\s*[^\r\n]+', '[redacted]', value)
    value = re.sub(r'(?i)[a-z]:[\\/][^\r\n"\']*', '[local-path]', value)
    value = re.sub(r'https?://[^\s"\']+', '[url]', value)
    value = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '[ip]', value)
    value = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email]', value)
    return value[:4000]


def clean_text(text, secrets):
    result = []
    for line in text.splitlines()[-160:]:
        try:
            result.append(json.dumps(redact(json.loads(line), secrets), ensure_ascii=False))
        except (ValueError, TypeError):
            # Plain tracebacks remain useful; discard lines naming secret fields.
            if not SENSITIVE.search(line):
                result.append(redact(line, secrets))
    return '\n'.join(result)[-8000:]


class Diagnostics:
    def __init__(self, runtime):
        self.runtime = runtime
        self.root = runtime.home / 'diagnostics'
        self.prefs = runtime.home / 'diagnostic-settings.json'
        self.enabled = read_json(self.prefs).get('enabled') is True
        self.snapshot = lambda: {}
        self.status = {'enabled': self.enabled, 'message': '', 'report_id': ''}
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.manual = False
        self.cancel_upload = threading.Event()
        self.thread = threading.Thread(target=self.run, name='diagnostic-upload', daemon=True)
        self.thread.start()

    def configure(self, enabled):
        if type(enabled) is not bool:
            raise ValueError('无效日志设置')
        with self.lock:
            atomic_json(self.prefs, {'enabled': enabled})
            self.enabled = enabled
            self.status.update(enabled=enabled, message='持续上传已开启' if enabled else '持续上传已关闭')
            if not enabled:
                self.cancel_upload.set()
            self.wake.set()

    def report(self):
        with self.lock:
            self.manual = True
            self.status['message'] = '正在收集诊断…'
            self.status['report_id'] = ''
            self.wake.set()

    def view(self):
        with self.lock:
            return dict(self.status)

    def paths(self):
        home, captures = self.runtime.home, self.runtime.folder
        base = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ClassworldFMBot'
        for name in ('scan-recovery.jsonl', 'scan-watchdog.jsonl', 'unified-client.log', 'scan-health.json'):
            yield name, home / name
        for name in ('player_position.json', 'channel_state.json'):
            yield name, base / name
        for name in ('passive_status.json', 'native_health.json'):
            yield name, captures / name
        runs = base / 'screen_scanner/supervised'
        if runs.exists():
            folders = sorted((p for p in runs.iterdir() if p.is_dir() and not p.is_symlink()), reverse=True)[:2]
            for index, folder in enumerate(folders):
                for name in ('full_scan.jsonl', 'channels.jsonl'):
                    yield f'run{index}-{name}', folder / name

    def collect(self, manual=False):
        config = self.runtime.configuration()
        secrets = [config.get('token', '')]
        cursors = read_json(self.root / 'cursors.json')
        updated, files, labels = dict(cursors), {}, {}
        for label, path in self.paths():
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                stat = path.stat()
                key = hashlib.sha256(str(path).encode()).hexdigest()
                labels[label] = key
                prior = cursors.get(key, {})
                with path.open('rb') as stream:
                    if path.suffix == '.json':
                        data = stream.read(16384)
                        digest = hashlib.sha256(data).hexdigest()
                        if not manual and prior.get('digest') == digest:
                            continue
                        content = json.dumps(redact(json.loads(data), secrets), ensure_ascii=False)
                        cursor = {'digest': digest}
                    else:
                        start = prior.get('offset', 0) if prior.get('inode') == stat.st_ino else 0
                        if manual or start > stat.st_size:
                            start = 0
                        stream.seek(max(start, stat.st_size - 16384))
                        content = clean_text(stream.read(16384).decode('utf-8', errors='replace'), secrets)
                        cursor = {'inode': stat.st_ino, 'offset': stream.tell()}
                if content:
                    files[label] = content[:8000]
                updated[key] = cursor
            except (OSError, ValueError, TypeError):
                continue
        snapshot = self.snapshot()
        state = {k: redact(snapshot[k], secrets) for k in ('phase', 'message', 'room', 'channel', 'capture', 'failure', 'last_progress_at', 'retries') if k in snapshot}
        report = dict(schema=1, id=uuid.uuid4().hex, version=VERSION, created_at=time.time(),
                      kind='manual' if manual else 'continuous', state=state, files=files)
        while len(json.dumps(report, ensure_ascii=False).encode()) > MAX_BATCH and files:
            label = next(reversed(files))
            files.pop(label)
            key = labels[label]
            if key in cursors:
                updated[key] = cursors[key]
            else:
                updated.pop(key, None)
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_json(self.root / (report['id'] + '.json'), report)
        # A cursor is advanced only after durable local queuing.
        atomic_json(self.root / 'cursors.json', dict(list(updated.items())[-100:]))
        return report

    def prune(self):
        now, size = time.time(), 0
        files = sorted(self.root.glob('????????????????????????????????.json'), key=lambda p:p.stat().st_mtime, reverse=True)
        for path in files:
            size += path.stat().st_size
            if now - path.stat().st_mtime > RETENTION or size > MAX_QUEUE:
                path.unlink(missing_ok=True)

    def cycle(self, manual=False):
        from collector_http import request_json
        report = self.collect(manual)
        self.prune()
        config = self.runtime.configuration()
        if config['endpoint'].rstrip('/') != 'https://mxd.ruit.me':
            raise ValueError('诊断服务地址无效')
        current = self.root / (report['id'] + '.json')
        paths = [current] + sorted((p for p in self.root.glob('????????????????????????????????.json') if p != current), key=lambda p:p.stat().st_mtime)[:3]
        for path in paths:
            with self.lock:
                if not self.enabled and not manual:
                    break
            item = read_json(path)
            if not self.enabled and item.get('kind') != 'manual':
                continue
            result = request_json(config['endpoint'].rstrip('/') + '/api/v1/collector/diagnostics', item,
                {'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'},
                stop=self.cancel_upload, timeout=15)
            if result.get('report_id') != item.get('id'):
                raise ValueError('诊断上传未确认')
            path.unlink(missing_ok=True)
            if path == current:
                with self.lock:
                    self.status['message'] = '已上传' if manual else '持续上传中'
                    if manual:
                        self.status['report_id'] = item['id']

    def run(self):
        while not self.runtime.stop_event.is_set():
            with self.lock:
                manual, self.manual = self.manual, False
                enabled = self.enabled
                self.cancel_upload.clear()
            try:
                self.prune()
                if enabled or manual:
                    self.cycle(manual)
            except Exception:
                with self.lock:
                    self.status['message'] = '上传暂不可用，将自动重试' if self.enabled else '上传失败，可再次报 Bug'
            self.wake.wait(60)
            self.wake.clear()
