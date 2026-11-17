"""HTTP in a disposable worker: DNS, TLS and trickle reads have a total deadline.

Only network I/O is isolated here. A timeout kills and joins the worker before
returning, so repeated outages cannot accumulate abandoned request threads.
Credentials travel over a private pipe, never through command lines or logs.
"""
import json
import multiprocessing
import time
import threading
import io
from urllib.error import HTTPError, URLError
from urllib.request import Request


def network_diagnostic(error):
    """Keep native error codes/types, never URLs, headers or exception bodies."""
    cause = error.reason if isinstance(error, URLError) else error
    detail = dict(type=type(error).__name__, cause=type(cause).__name__)
    for key in ('errno', 'winerror'):
        value = getattr(cause, key, None)
        if isinstance(value, int):
            detail[key] = value
    reason = getattr(cause, 'reason', None)
    if isinstance(reason, str) and reason and all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789' for c in reason):
        detail['ssl_reason'] = reason[:80]
    return detail


def worker_exit_error(process, started, stage):
    process.join(.05)
    detail = dict(worker_exitcode=process.exitcode, stage=stage,
                  elapsed_ms=round((time.monotonic() - started) * 1000))
    error = ConnectionError(f'Request worker exited (exit_code={process.exitcode}; stage={stage})')
    error.request_diagnostic = detail
    return error


def scanner_request(config, action, body, *, stop):
    # Stop game input immediately, but let a bounded claim return its lease so
    # teardown can release it. Cleanup itself must survive the closed input gate.
    if action != 'release' and stop.is_set():
        raise InterruptedError('Request cancelled')
    return request_json(config['endpoint'].rstrip('/') + '/api/v1/scanner/' + action, body,
        {'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'},
        stop=None if action in ('claim', 'release') else stop,
        timeout=3 if action == 'release' else 6)


def _request_worker(pipe):
    try:
        _perform(pipe, *pipe.recv())
    finally:
        pipe.close()


def _request_loop(pipe):
    """A reusable worker: one request at a time until the parent sends None."""
    try:
        pipe.send(('ready',))
        while True:
            message = pipe.recv()
            if message is None:
                return
            _perform(pipe, *message)
    except (EOFError, OSError):
        return
    finally:
        pipe.close()


def _perform(pipe, url, payload, headers):
    try:
        from shared_client import upload_opener
        request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), headers=headers)
        with upload_opener().open(request, timeout=3) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError('Oversized service response')
            pipe.send(('ok', json.loads(raw)))
    except HTTPError as error:
        # Preserve bounded diagnostics across the worker boundary. Never pass
        # request headers (credentials) or unbounded gateway error pages.
        try:
            body = error.read(4096)
        except Exception:
            body = b''
        pipe.send(('http', error.code, (error.headers or {}).get('Retry-After', ''),
                   (error.headers or {}).get('Date', ''), body))
    except Exception as error:
        pipe.send(('error', network_diagnostic(error)))


def _result(url, result):
    if result[0] == 'http':
        raise HTTPError(url, result[1], 'Service request rejected',
                        {'Retry-After': result[2], 'Date': result[3] if len(result) > 3 else ''},
                        io.BytesIO(result[4] if len(result) > 4 else b''))
    if result[0] != 'ok':
        error = URLError(result[1])
        error.request_diagnostic = result[1] if isinstance(result[1], dict) else {'type': result[1]}
        raise error
    if not isinstance(result[1], dict):
        raise ValueError('Invalid service response')
    return result[1]


class RequestSession:
    """Reuses one disposable worker for a run of requests (an upload pass).

    Starting a worker of the frozen collector took most of each upload's
    six-second deadline (2026-11-16: the service answered in ~0.1 s while the
    collector still timed out). Startup now has its own budget; any timeout,
    cancellation or failure kills the worker and the next request starts a new
    one, so the deadline still bounds DNS, TLS and trickle reads.
    """
    STARTUP = 30

    def __init__(self, worker=_request_loop):
        self.worker = worker
        self.process = self.parent = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _start(self, stop):
        context = multiprocessing.get_context('spawn')
        parent, child = context.Pipe()
        process = context.Process(target=self.worker, args=(child,), daemon=True)
        self.process, self.parent = process, parent
        process.start()
        child.close()
        started = time.monotonic()
        while not parent.poll(.05):
            if stop is not None and stop.is_set():
                raise InterruptedError('Request cancelled')
            if not process.is_alive() and not parent.poll():
                raise worker_exit_error(process, started, 'startup')
            if time.monotonic() >= started + self.STARTUP:
                raise TimeoutError('Request worker did not start')
        if parent.recv() != ('ready',):
            raise ConnectionError('Request worker did not start')

    def request(self, url, payload, headers, *, stop=None, timeout=6):
        if stop is not None and stop.is_set():
            raise InterruptedError('Request cancelled')
        ok = False
        sender = None
        try:
            if self.process is None or not self.process.is_alive():
                self._discard()
                self._start(stop)
            process, parent = self.process, self.parent
            started = time.monotonic()
            deadline = started + timeout
            send_error = []
            def send():
                try:
                    parent.send((url, payload, headers))
                except (OSError, EOFError) as error:
                    send_error.append(error)
            sender = threading.Thread(target=send, daemon=True, name='request-body')
            sender.start()
            while not parent.poll(.05):
                if stop is not None and stop.is_set():
                    raise InterruptedError('Request cancelled')
                if time.monotonic() >= deadline:
                    raise TimeoutError('Service request exceeded total deadline')
                if not process.is_alive():
                    if parent.poll():
                        break
                    raise worker_exit_error(process, started, 'await_response')
                if send_error:
                    raise ConnectionError('Request body could not be delivered')
            try:
                result = parent.recv()
            except EOFError as error:
                raise worker_exit_error(process, started, 'pipe_eof') from error
            ok = True
            if stop is not None and stop.is_set():
                raise InterruptedError('Request cancelled')
            return _result(url, result)
        finally:
            if not ok:
                self._discard()
            if sender is not None:
                sender.join(1)

    def _discard(self):
        process, parent = self.process, self.parent
        self.process = self.parent = None
        if process is not None and process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join(1)
            process.close()
        if parent is not None:
            parent.close()

    def close(self):
        if self.process is not None and self.process.is_alive():
            try:
                self.parent.send(None)
                self.process.join(2)
            except (OSError, EOFError, ValueError):
                pass
        self._discard()


def request_json(url, payload, headers, *, stop=None, timeout=6, worker=_request_worker, session=None):
    if session is not None:
        return session.request(url, payload, headers, stop=stop, timeout=timeout)
    context = multiprocessing.get_context('spawn')
    parent, child = context.Pipe()
    process = context.Process(target=worker, args=(child,), daemon=True)
    started = time.monotonic()
    deadline = started + timeout
    sender = None
    send_error = []
    try:
        if stop is not None and stop.is_set():
            raise InterruptedError('Request cancelled')
        process.start()
        child.close()
        def send():
            try:
                parent.send((url, payload, headers))
            except (OSError, EOFError) as error:
                send_error.append(error)
        # A worker that wedges before recv must not wedge a large body write
        # on the parent pipe. Killing it below releases this one writer.
        sender = threading.Thread(target=send, daemon=True, name='request-body')
        sender.start()
        while not parent.poll(.05):
            if stop is not None and stop.is_set():
                raise InterruptedError('Request cancelled')
            if time.monotonic() >= deadline:
                raise TimeoutError('Service request exceeded total deadline')
            if not process.is_alive():
                # The reply can arrive between poll() and the exit check.
                # Drain it before interpreting normal worker exit as failure.
                if parent.poll():
                    break
                raise worker_exit_error(process, started, 'await_response')
            if send_error:
                raise ConnectionError('Request body could not be delivered')
        result = parent.recv()
        if stop is not None and stop.is_set():
            raise InterruptedError('Request cancelled')
        return _result(url, result)
    except EOFError as error:
        raise worker_exit_error(process, started, 'pipe_eof') from error
    finally:
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join(1)
            process.close()
        if sender is not None:
            sender.join(1)
        parent.close()
        child.close()
