"""Official-release updater. No collector credentials are used for downloads."""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

VERSION = '0.7.34'
LATEST = 'https://mxd.ruit.me/web/releases/stable.json'
DOWNLOAD_BASES = ('https://mxd.ruit.me/web/releases/', 'https://download.ruit.me/collector/')
EXE = 'ClassicWorldCollector.exe'
MAX_ZIP = 80 * 1024 * 1024
MAX_EXPANDED = 300 * 1024 * 1024
CHECK_INTERVAL = 60 * 60
PUSH_COOLDOWN = 60
HELPERS = set()  # Plans whose helper already runs (started early for the hand-off).


def update_status(home, state, **fields):
    """Local, non-sensitive progress; failures never interrupt capture."""
    try:
        path = Path(home)/'update-status.json'
        pending = path.with_suffix('.pending')
        pending.write_text(json.dumps(dict(current=VERSION, state=state, at=time.time(), **fields)), encoding='utf-8')
        os.replace(pending, path)
    except OSError:
        pass


def game_active():
    """Do not discard a live channel's decoder state to install an update."""
    import psutil
    try:
        return any((p.info.get('name') or '').lower() == 'maplestory.exe'
                   for p in psutil.process_iter(['name']))
    except psutil.Error:
        return True  # An unreadable process list is not evidence the game closed.


def push_versions(response, stop):
    """Bounded SSE reader. Notices are hints, never executable download metadata."""
    event, data, size = '', [], 0
    while not stop.is_set():
        raw = response.readline(4097)
        if not raw:
            return
        if len(raw) > 4096:
            raise ValueError('Update event line too long')
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if event == 'collector-update':
                notice = json.loads('\n'.join(data))
                tag = notice.get('version')
                if tag is None or version(tag) > version(VERSION):
                    yield tag
            event, data, size = '', [], 0
        elif not line.startswith(':'):
            field, _, value = line.partition(':')
            value = value.removeprefix(' ')
            size += len(line)
            if size > 8192:
                raise ValueError('Update event too large')
            if field == 'event': event = value
            elif field == 'data': data.append(value)


def listen_updates(endpoint, stop, notify):
    from collector_dashboard import safe_endpoint
    from shared_client import upload_opener
    endpoint = safe_endpoint(endpoint)
    retry = 2
    while not stop.is_set():
        try:
            request = urllib.request.Request(endpoint+'/api/v1/collector/updates', headers={
                'Accept':'text/event-stream', 'User-Agent':'ClassicWorldCollector/'+VERSION})
            # No identity or credentials are needed by the public release stream.
            with upload_opener().open(request, timeout=45) as response:
                if response.headers.get_content_type() != 'text/event-stream':
                    raise ValueError('Expected update event stream')
                for tag in push_versions(response, stop):
                    retry = 2
                    notify(tag)
        except Exception:
            pass  # The hourly check remains available when push is offline.
        if stop.wait(retry): return
        retry = min(retry*2, 60)


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'v?\d+\.\d+\.\d+', value):
        raise ValueError('Invalid stable version')
    return tuple(map(int, value.lstrip('v').split('.')))


def release_info(data, current=VERSION):
    if not isinstance(data, dict) or data.get('schema') != 1:
        raise ValueError('Invalid release manifest')
    if data.get('channel') != 'stable':
        return None
    tag = data.get('version')
    if not isinstance(tag, str) or not re.fullmatch(r'v\d{1,6}\.\d{1,6}\.\d{1,6}', tag):
        raise ValueError('Invalid release version')
    if version(tag) <= version(current):
        return None
    name = f'ClassicWorldCollector-windows-x64-{tag}.zip'
    asset = data.get('windows_x64')
    if not isinstance(asset, dict):
        raise ValueError('Missing Windows release')
    expected = asset.get('url')
    digest = asset.get('sha256', '')
    if expected not in [base+tag+'/'+name for base in DOWNLOAD_BASES] or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('Unverified release asset')
    size = asset.get('size')
    if type(size) is not int or not 0 < size <= MAX_ZIP:
        raise ValueError('Invalid release size')
    return dict(version=tag, url=expected, sha256=digest, size=size)


def read_release(opener=None, current=VERSION):
    from shared_client import upload_opener
    # API metadata is read directly. The archive uses a separate redirect policy.
    opener = opener or upload_opener()
    request = urllib.request.Request(LATEST, headers={'Accept': 'application/json', 'Cache-Control': 'no-cache',
        'User-Agent': 'ClassicWorldCollector/' + VERSION})
    with opener.open(request, timeout=15) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Release metadata too large')
    return release_info(json.loads(raw), current)


def official_download_url(value):
    return isinstance(value, str) and any(re.fullmatch(re.escape(base)+
        r'(v\d{1,6}\.\d{1,6}\.\d{1,6})/ClassicWorldCollector-windows-x64-\1\.zip', value)
        for base in DOWNLOAD_BASES)


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not official_download_url(newurl):
            raise ValueError('Unexpected update destination')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(info, path, opener=None):
    if not official_download_url(info.get('url')):
        raise ValueError('Unexpected update destination')
    if opener is None:
        import ssl
        import truststore
        opener = urllib.request.build_opener(ReleaseRedirect(), urllib.request.HTTPSHandler(
            context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)))
    digest = hashlib.sha256()
    size = 0
    request = urllib.request.Request(info['url'], headers={'User-Agent': 'ClassicWorldCollector/' + VERSION})
    try:
        with opener.open(request, timeout=30) as response, Path(path).open('xb') as out:
            while True:
                chunk = response.read(128 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > info['size'] or size > MAX_ZIP:
                    raise ValueError('Update download too large')
                digest.update(chunk)
                out.write(chunk)
        if size != info['size'] or digest.hexdigest() != info['sha256']:
            raise ValueError('Update checksum mismatch')
    except Exception:
        Path(path).unlink(missing_ok=True)
        raise


def unpack(archive, destination):
    destination = Path(destination)
    names = set()
    total = 0
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) > 5000:
            raise ValueError('Too many update files')
        for entry in entries:
            raw = entry.orig_filename
            p = PurePosixPath(raw)
            if ('\\' in raw or '\x00' in raw or p.is_absolute() or len(p.parts) < 1 or p.parts[0] != 'ClassicWorldCollector'
                or any(part in ('.','..') or ':' in part or part.endswith((' ','.'))
                    or re.fullmatch(r'(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?',part) for part in p.parts)
                or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError('Unsafe update path')
            key = raw.rstrip('/').casefold()
            if key in names:
                raise ValueError('Duplicate update path')
            names.add(key)
            total += entry.file_size
            if total > MAX_EXPANDED:
                raise ValueError('Expanded update too large')
        z.extractall(destination)
    bundle = destination / 'ClassicWorldCollector'
    if not (bundle / EXE).is_file() or not (bundle / '_internal').is_dir():
        raise ValueError('Incomplete update')
    return bundle


def check_bundle(bundle, expected):
    checks = [(['--version'], expected.lstrip('v')), (['--self-test'], 'Codec self-test passed')]
    manifest = Path(bundle)/'install-manifest.json'
    if manifest.is_file() and json.loads(manifest.read_text(encoding='utf-8-sig')).get('scanner_commit'):
        checks.append((['--scanner-self-test'], 'Scanner self-test passed'))
    for args, marker in checks:
        result = subprocess.run([str(Path(bundle)/EXE), *args], capture_output=True, timeout=45,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode or marker.encode() not in result.stdout:
            raise ValueError('New collector self-check failed')


def write_plan(home, info, install, argv, handoff=None):
    updates = Path(home)/'updates'
    updates.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='release-', dir=updates)).resolve()
    archive = stage/'update.zip'
    print('正在下载更新 / Downloading update…', flush=True)
    download(info, archive)
    bundle = unpack(archive, stage/'unpacked')
    check_bundle(bundle, info['version'])
    import psutil
    parent = psutil.Process()
    plan = dict(version=info['version'], install=str(Path(install).resolve()), bundle=str(bundle),
        silent=True, home=str(Path(home).resolve()),
        # Capture folder whose game connections the helper keeps alive (market_handoff).
        handoff=str(Path(handoff).resolve()) if handoff else None,
        parent_pid=parent.pid, parent_created=parent.create_time(), argv=argv,
        hashes={str(p.relative_to(bundle)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in bundle.rglob('*') if p.is_file()})
    path = stage/'plan.json'
    path.write_text(json.dumps(plan), encoding='utf-8')
    return path, bundle


def install_bundle(bundle, install, backup):
    """Swap the program directory; retain non-package files and a full rollback."""
    bundle, install, backup = map(Path, (bundle, install, backup))
    if backup.exists() or not install.is_dir() or install.resolve() in bundle.resolve().parents:
        raise ValueError('Invalid update directories')
    managed = json.loads((install/'install-manifest.json').read_text(encoding='utf-8-sig'))['files']
    managed = {p.casefold() for p in managed}
    # Inherit the install parent's ACL. Python's private 0700 temp directories
    # make an elevated update unreadable to Explorer/the normal desktop user.
    import uuid
    candidate = install.parent / ('.collector-new-' + uuid.uuid4().hex)
    candidate.mkdir(mode=0o777)
    shutil.copytree(bundle, candidate, dirs_exist_ok=True)
    # Configuration/captures normally live in LOCALAPPDATA; custom files placed
    # beside the EXE are retained too. New package files take precedence.
    for p in install.rglob('*'):
        relative = p.relative_to(install)
        if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0) & 0x400:
            raise ValueError('Symlink in install directory')
        if p.is_file() and relative.as_posix().casefold() not in managed and not (candidate/relative).exists():
            (candidate/relative).parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(p,candidate/relative)
    # The PyInstaller bootloader may hold the old EXE briefly after its child exits.
    deadline = time.monotonic()+30
    while True:
        try:
            install.rename(backup)
            break
        except PermissionError:
            if time.monotonic() >= deadline:
                shutil.rmtree(candidate, ignore_errors=True)
                raise
            time.sleep(.2)
    try:
        candidate.rename(install)
    except Exception:
        backup.rename(install)
        shutil.rmtree(candidate, ignore_errors=True)
        raise


def helper_log(home, step, **fields):
    """One line per update step in update-helper.log: what the helper did and how long it took."""
    try:
        with (Path(home)/'update-helper.log').open('a', encoding='utf-8') as log:
            log.write(json.dumps(dict(time=time.time(), step=step, **fields))+'\n')
    except OSError:
        pass


def old_processes(install):
    """Processes still running from, or working inside, the install folder."""
    import psutil
    install, found = Path(install).resolve(), []
    for process in psutil.process_iter(['pid', 'exe', 'name']):
        try:
            if process.pid == os.getpid():
                continue
            exe = process.info['exe']
            if exe and install in Path(exe).resolve().parents:
                found.append(process)
            elif (process.info['name'] or '').lower() == 'msedgewebview2.exe':
                # The window's embedded browser inherits the install folder as its
                # working directory and can outlive the window by several seconds.
                cwd = Path(process.cwd()).resolve()
                if cwd == install or install in cwd.parents:
                    found.append(process)
        except (psutil.Error, OSError):
            pass
    return found


def release_install(install, timeout=45):
    """Wait for the old collector's own processes to leave the install folder; end stragglers.

    Only processes found by `old_processes` are touched, never the game.
    """
    import psutil
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline and old_processes(install):
        time.sleep(.25)
    left = old_processes(install)
    for process in left:
        try: process.terminate()
        except psutil.Error: pass
    _, alive = psutil.wait_procs(left, timeout=5)
    for process in alive:
        try: process.kill()
        except psutil.Error: pass
    psutil.wait_procs(alive, timeout=3)


BACKUP = r'\.(backup|failed)-(\d+)'
STAGING = r'\.collector-new-[0-9a-f]{32}'


def prune(install, keep=1):
    """Delete this updater's old backups (each a full copy) and abandoned staging folders."""
    install = Path(install).resolve()
    pattern = re.compile(re.escape(install.name)+BACKUP)
    old = sorted((p for p in install.parent.iterdir() if p.is_dir() and pattern.fullmatch(p.name)),
                 key=lambda p: int(pattern.fullmatch(p.name).group(2)))
    stale = [p for p in install.parent.iterdir()
             if p.is_dir() and p != install and re.fullmatch(STAGING, p.name)
             and time.time()-p.stat().st_mtime > 86400]
    for folder in [*old[:len(old)-keep], *stale]:
        if not old_processes(folder):
            shutil.rmtree(folder, ignore_errors=True)


def start_helper(path, bundle, ready=None, wait=15):
    """Run the staged release's update helper; optionally wait until it records packets."""
    path = Path(path)
    subprocess.Popen([str(Path(bundle)/EXE), '--apply-update', str(path)], cwd=path.parent,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    HELPERS.add(str(path))
    deadline = time.monotonic()+wait
    while ready and not Path(ready).exists() and time.monotonic() < deadline:
        time.sleep(.1)


def apply_plan(path, executable=None):
    import psutil
    path = Path(path).resolve()
    plan = json.loads(path.read_text(encoding='utf-8'))
    bundle, install = Path(plan['bundle']).resolve(), Path(plan['install']).resolve()
    if Path(executable or sys.executable).resolve() != bundle/EXE or path.parent not in bundle.parents:
        raise ValueError('Invalid update helper')
    if bundle == install or bundle in install.parents or install in bundle.parents or not (install/EXE).is_file():
        raise ValueError('Invalid installation target')
    for relative, digest in plan['hashes'].items():
        p = (bundle/relative).resolve()
        if bundle not in p.parents or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            raise ValueError('Staged update changed')
    # An old launcher inherits the install directory as its working directory.
    # On Windows both the frozen Python child AND its PyInstaller bootloader
    # then lock that directory. chdir() alone only releases the child's handle.
    # Relaunch the verified helper outside the install tree, then let this
    # bootloader exit before the replacement helper performs the swap.
    current = Path.cwd().resolve()
    if current == install or install in current.parents:
        subprocess.Popen([str(bundle/EXE),'--apply-update',str(path)],
            cwd=path.parent,stdin=subprocess.DEVNULL,stdout=sys.stdout,stderr=sys.stderr,close_fds=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        return
    # Record the game's packets from now until the new collector captures them itself,
    # so its connections survive the restart (market_handoff). Never blocks the update.
    spool = None
    if plan.get('handoff'):
        try:
            from market_handoff import record
            spool = record(plan['handoff'])
        except Exception:
            spool = None
    log_home = plan.get('home', path.parent)
    helper_log(log_home, 'started', version=plan['version'], recording=spool is not None)
    parent = None
    try:
        parent = psutil.Process(plan['parent_pid'])
        if abs(parent.create_time()-plan['parent_created']) > .01 or Path(parent.exe()).resolve() != install/EXE:
            raise ValueError('Unexpected collector process')
    except psutil.NoSuchProcess:
        pass
    if parent:
        try: parent.wait(timeout=150)
        except psutil.TimeoutExpired: raise RuntimeError('Collector is still busy; update postponed') from None
    # Never terminate unrelated processes (including a game or second instance).
    backup = install.with_name(install.name+'.backup-'+str(time.time_ns()))
    silent = plan.get('silent', False)
    home = Path(plan.get('home', path.parent))
    if plan.get('home'):
        # The updated collector always opens stopped; the player presses Start.
        # This helper is the new release's code, so it also covers a hand-off
        # made by an older collector that kept the scan running.
        try:
            from collector_recovery import ScanIntent
            ScanIntent(home).stop()
        except OSError:
            pass
    argv = list(plan['argv'])
    if silent and '--no-browser' not in argv:
        argv.append('--no-browser')
    def launch(arguments):
        if silent:
            home.mkdir(parents=True, exist_ok=True)
            with (home/'collector-restart.log').open('ab') as log:
                subprocess.Popen([str(install/EXE), *arguments], cwd=install,
                    stdout=log, stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        else:
            subprocess.Popen([str(install/EXE), *arguments], cwd=install,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    installed = False
    try:
        update_status(home, 'installing', available=plan['version'])
        # The launcher, the window's browser and other children must be gone, or
        # Windows refuses to rename the folder they run in.
        began = time.monotonic()
        release_install(install)
        helper_log(home, 'released', seconds=round(time.monotonic()-began, 1))
        install_bundle(bundle, install, backup)
        installed = True
        helper_log(home, 'installed', seconds=round(time.monotonic()-began, 1))
        check_bundle(install, plan['version'])
        launch(argv)
        helper_log(home, 'launched', seconds=round(time.monotonic()-began, 1))
        update_status(home, 'updated', available=plan['version'])
        try: prune(install)
        except OSError: pass
    except Exception as error:
        helper_log(home, 'failed', installed=installed, reason=type(error).__name__)
        if backup.exists():
            if install.exists():
                failed = install.with_name(install.name+'.failed-'+str(time.time_ns()))
                install.rename(failed)
            backup.rename(install)
        if silent and installed:
            # Do not loop on a broken release; later versions still auto-update.
            # A swap that never happened (files in use) is retried by the next check.
            try:
                (home/'update-blocked.json').write_text(json.dumps({'version':plan['version']}), encoding='utf-8')
            except OSError:
                argv.append('--no-update')
        update_status(home, 'rolled_back' if installed else 'retry_later', available=plan['version'], reason=type(error).__name__)
        if (install/EXE).is_file():
            launch(argv if silent else [*argv, '--no-update'])
        if not silent:
            show_error('更新未完成，已尝试恢复旧版。请继续使用旧版，稍后再试。\nUpdate failed; restarting the previous collector.')
        if spool: spool.join(timeout=30)
        raise
    # Stay until the new collector has taken over the recording.
    if spool:
        spool.join()
        helper_log(home, 'recording_closed')
    print('更新完成 / Update complete.', flush=True)


def ask_update(tag):
    import ctypes
    return ctypes.windll.user32.MessageBoxW(None,
        f'发现新版本 {tag}。现在更新并重启客户端吗？\n配置与采集记录会保留。更新后游戏连接和背包会保留。\n\nUpdate and restart? Your settings and records will be kept.',
        '枫叶市集 · 客户端更新 / Collector update', 0x4 | 0x20 | 0x10000) == 6


def show_error(message):
    if os.name=='nt':
        import ctypes
        ctypes.windll.user32.MessageBoxW(None,message,'客户端更新 / Collector update',0x10)


def start_checker(home, stop, ready, argv, wakeup=None, endpoint=None, *, interval=CHECK_INTERVAL,
                  cooldown=PUSH_COOLDOWN, game_running=game_active, prepare_restart=None, handoff=None):
    """Only the packaged top-level collector checks; child processes never do."""
    changed = threading.Event()
    hint_lock = threading.Lock()
    last_hint = object()
    def notify(tag):
        nonlocal last_hint
        with hint_lock:
            if tag != last_hint:
                last_hint = tag
                changed.set()
    if endpoint:
        threading.Thread(target=listen_updates, args=(endpoint, stop, notify), daemon=True).start()
    def work():
        next_check = 0
        last_check = -float('inf')
        pending = None
        next_idle_check = 0
        waiting_state = 'ready_to_update' if prepare_restart else 'waiting_for_game_exit'
        def status(state, **fields):
            # A staged package stays installable while later checks run or fail.
            if pending:
                update_status(home, waiting_state, **{**fields, 'available': pending[0]['version']})
            else:
                update_status(home, state, **fields)
        while not stop.is_set():
            now = time.monotonic()
            if pending and now >= next_idle_check:
                # The desktop gate opens only after the player clicks Update;
                # poll it often enough that the click feels immediate.
                next_idle_check = now+(1 if prepare_restart else 5)
                try:
                    can_restart = prepare_restart() if prepare_restart else not game_running()
                except Exception as error:
                    status(waiting_state, reason=type(error).__name__)
                    can_restart = False
                if can_restart and not stop.is_set():
                    info, path, bundle = pending
                    ready.append((path, bundle))
                    update_status(home, 'restarting', available=info['version'])
                    if handoff:
                        # The helper starts recording before this capture stops.
                        try:
                            from market_handoff import READY
                            start_helper(path, bundle, Path(handoff)/READY)
                        except Exception:
                            pass
                    stop.set()
                    if wakeup: wakeup.set()
                    return
            pushed = changed.is_set() and now-last_check >= cooldown
            if now < next_check and not pushed:
                stop.wait(min(1, next_check-now))
                continue
            changed.clear()
            last_check = now
            next_check = now+interval
            try:
                status('checking')
                info = read_release()
                blocked = None
                try: blocked = json.loads((Path(home)/'update-blocked.json').read_text())['version']
                except (OSError, ValueError, KeyError): pass
                if info and info['version'] == blocked:
                    status('rolled_back', available=blocked)
                    continue
                if info and not stop.is_set():
                    if pending and version(info['version']) <= version(pending[0]['version']):
                        update_status(home, waiting_state, available=pending[0]['version'])
                        continue
                    update_status(home, 'downloading', available=info['version'])
                    path, bundle = write_plan(home, info, Path(sys.executable).parent, argv, handoff)
                    update_status(home, waiting_state, available=info['version'])
                    if stop.is_set(): return
                    # Continue hourly checks and push handling while gaming;
                    # a newer release can replace this staged package.
                    pending = (info, path, bundle)
                    next_idle_check = 0
                    continue
                status('up_to_date')
            except Exception as error:
                status('retry_later', reason=type(error).__name__)
                try:
                    print(f'暂时无法更新，继续采集 / Update unavailable ({type(error).__name__}).', flush=True)
                except (OSError, UnicodeError):
                    pass
    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    return thread
