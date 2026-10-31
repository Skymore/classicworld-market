"""Durable scan intent and bounded recovery; no game input in this module."""
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows readers/AV can briefly deny replacement of an open file.
        # Keep the complete old document until replacement succeeds.
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(.02 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def prune_diagnostics(root, budget=256*1024*1024):
    """Only our dedicated diagnostic tree; never the upload/capture queue."""
    root = Path(root).resolve()
    if not root.is_dir():
        return
    candidates = []
    for path in root.rglob('*'):
        if path.is_symlink() or path.suffix.lower() not in ('.png', '.jpg', '.jsonl', '.json'):
            continue
        resolved = path.resolve()
        if not resolved.is_relative_to(root) or not path.is_file() or path.name.startswith(('shop_', 'presence_', 'roster_')):
            continue
        stat = path.stat()
        candidates.append((stat.st_mtime, stat.st_size, path))
    size = sum(row[1] for row in candidates)
    for _, length, path in sorted(candidates):
        if size <= budget:
            break
        try:
            path.unlink()
            size -= length
        except OSError:
            pass  # A current diagnostic write can be trimmed on the next pass.


def retry_after(error, now=None):
    value = (getattr(error, 'headers', None) or {}).get('Retry-After', '')
    try:
        seconds = float(value)
    except (ValueError, TypeError):
        try:
            seconds = parsedate_to_datetime(value).timestamp() - (time.time() if now is None else now)
        except (TypeError, ValueError, OverflowError):
            return 0
    return max(0, seconds) if math.isfinite(seconds) else 0


def retry_delay(attempt, error=None):
    # A server embargo is a lower bound, including HTTP-date Retry-After.
    delay = min(30, 2 ** min(max(0, attempt - 1), 5)) * random.uniform(.8, 1)
    if isinstance(error, HTTPError) and error.code == 409 and getattr(error, 'scanner_action', None) in ('claim', 'heartbeat', 'complete'):
        # The service is reachable. Recheck ownership promptly after expiry;
        # network outages still use exponential backoff.
        delay = min(delay, 2)
    return max(delay, retry_after(error))


def failure_state(error):
    from free_market_route import MapResourceError
    if isinstance(error, MapResourceError):
        return 'needs_attention', '地图导航数据读取失败，请检查地图路径配置或更新扫描器，修复后停止并重新开始。'
    if isinstance(error, HTTPError):
        if error.code in (408, 429) or error.code >= 500:
            return 'recovering_network', f'任务服务暂时不可用（HTTP {error.code}），正在重试。'
        if error.code == 409:
            if getattr(error, 'scanner_action', None) == 'claim':
                return 'rebuilding', '已有扫描占用任务，正在等待释放。'
            if getattr(error, 'scanner_action', None) in ('heartbeat', 'complete'):
                return 'rebuilding', '任务已过期，正在重新领取。'
            return 'rebuilding', '任务状态已变化，正在重新确认。'
        return 'needs_attention', f'任务请求被拒绝（HTTP {error.code}），请检查登录及权限。'
    if isinstance(error, (TimeoutError, ConnectionError, URLError)):
        return 'recovering_network', '任务连接中断，正在等待网络恢复。'
    if isinstance(error, OSError):
        return 'needs_attention', '本地读写失败，请检查磁盘空间和文件权限。'
    return 'waiting_game', '游戏尚未就绪，确认登录并将游戏切换到前台后自动继续。'


class ScanIntent:
    """A stop tombstone wins even if writing the intent file is interrupted."""
    def __init__(self, home):
        self.home = Path(home)
        self.path = self.home / 'scan-intent.json'
        self.tombstone = self.home / 'scan-stopped'
        self.permit = self.home / 'scan-running'
        self.lock = threading.RLock()

    def load(self):
        value = read_json(self.path)
        if self.tombstone.exists() or not self.permit.exists():
            value['enabled'] = False
        return value

    def start(self, hwnd, session=None):
        with self.lock:
            value = dict(enabled=True, window=hwnd, session=session or uuid.uuid4().hex,
                         updated_at=time.time())
            atomic_json(self.path, value)
            with self.permit.open('wb') as stream:
                stream.write(b'1')
                stream.flush()
                os.fsync(stream.fileno())
            self.tombstone.unlink(missing_ok=True)
            return value

    def stop(self):
        with self.lock:
            # Removing an existing permit needs no allocation, even when the
            # volume cannot create a new tombstone or replace a JSON document.
            self.permit.unlink(missing_ok=True)
            self.home.mkdir(parents=True, exist_ok=True)
            with self.tombstone.open('w', encoding='utf-8') as stream:
                stream.write('user stopped\n')
                stream.flush()
                os.fsync(stream.fileno())
            atomic_json(self.path, dict(enabled=False, updated_at=time.time()))


class RecoveryLog:
    def __init__(self, home, name='scan-recovery'):
        home = Path(home)
        home.mkdir(parents=True, exist_ok=True)
        self.logger = logging.Logger('scanner-recovery')
        handler = RotatingFileHandler(home / (name + '.jsonl'), maxBytes=2*1024*1024,
                                      backupCount=4, encoding='utf-8', delay=True)
        handler.setFormatter(logging.Formatter('%(message)s'))
        self.logger.addHandler(handler)

    def event(self, event, **fields):
        handler = self.logger.handlers[0]
        with handler.lock:
            self.logger.info(json.dumps(dict(time=datetime.now(timezone.utc).isoformat(),
                                            component='scanner', event=event, **fields), ensure_ascii=False))
            handler.close()

    def close(self):
        for handler in self.logger.handlers:
            handler.close()


class RotatingOutput:
    """Bound the existing print/traceback log without changing diagnostic pipes."""
    def __init__(self, path):
        self.handler = RotatingFileHandler(path, maxBytes=4*1024*1024, backupCount=3, encoding='utf-8')
        self.handler.setFormatter(logging.Formatter('%(message)s'))

    def write(self, value):
        if value.strip():
            self.handler.handle(logging.LogRecord('collector', logging.INFO, '', 0, value.rstrip(), (), None))
        return len(value)

    def flush(self):
        self.handler.flush()

    def close(self):
        self.handler.close()

    def isatty(self):
        return False
