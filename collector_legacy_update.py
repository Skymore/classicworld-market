"""One-time handoff for 0.5.10/0.5.11, invoked by their staged self-test.

Those releases download and verify a bundle but fail at the final Popen. Their
existing self-test entry can start a narrowly scoped helper before that failure.
Ordinary self-tests, current releases and unrelated processes do nothing here.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

BROKEN = {'0.5.10', '0.5.11'}
GRACE_SECONDS = 100  # Old cleanup joins can take up to 90 seconds in total.
MAX_WAIT = 7 * 24 * 3600


def read_json(path):
    path = Path(path)
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('Update metadata too large')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def option(argv, name, default):
    for i, arg in enumerate(argv):
        if arg == name:
            return argv[i+1]
        if arg.startswith(name+'='):
            return arg.split('=', 1)[1]
    return default


def validate_context(context, executable):
    from collector_update import EXE
    bundle = Path(executable).resolve().parent
    stage = bundle.parent.parent
    home = Path(context['home']).resolve()
    install = Path(context['install']).resolve()
    if (bundle.name != 'ClassicWorldCollector' or bundle.parent.name != 'unpacked'
            or not re.fullmatch(r'release-[A-Za-z0-9_-]+', stage.name)
            or stage.parent != home/'updates' or bundle == install
            or bundle in install.parents or install in bundle.parents
            or Path(context['bundle']).resolve() != bundle
            or Path(executable).resolve().name != EXE
            or context['version'] not in BROKEN
            or read_json(install/'install-manifest.json')['version'] != context['version']):
        raise ValueError('Not a legacy staged update')
    if any(arg in context['argv'] for arg in
           ('--self-test', '--version', '--apply-update', '--legacy-update-bridge',
            '--dashboard-only', '--capture-only', '--once', '--no-update', '--proxy')):
        raise ValueError('Not an updating collector')
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home())))/'ClassicWorldMarket'
    if Path(option(context['argv'], '--home', str(default))).resolve() != home:
        raise ValueError('Unexpected collector home')
    return stage, bundle, install, home


def same_process(context):
    import psutil
    from collector_update import EXE
    try:
        process = psutil.Process(context['parent_pid'])
        if (abs(process.create_time()-context['parent_created']) > .01
                or Path(process.exe()).resolve() != Path(context['install'])/EXE
                or process.cmdline()[1:] != context['argv']):
            raise ValueError('Collector process identity changed')
        return process
    except psutil.NoSuchProcess:
        return None


def maybe_start_bridge():
    if os.name != 'nt' or not getattr(sys, 'frozen', False):
        return False
    import psutil
    from collector_update import EXE
    try:
        executable = Path(sys.executable).resolve()
        # Skip this frozen executable's bootloader, then require a direct
        # collector ancestor. A shell or another application cannot opt in.
        parent = psutil.Process().parent()
        for _ in range(3):
            if parent is None:
                return False
            if Path(parent.exe()).resolve() != executable:
                break
            parent = parent.parent()
        else:
            return False
        install = Path(parent.exe()).resolve().parent
        if Path(parent.exe()).name != EXE:
            return False
        old_version = read_json(install/'install-manifest.json')['version']
        if old_version not in BROKEN:
            return False
        argv = parent.cmdline()[1:]
        default = Path(os.environ.get('LOCALAPPDATA', str(Path.home())))/'ClassicWorldMarket'
        context = dict(home=str(Path(option(argv, '--home', str(default))).resolve()),
                       install=str(install), bundle=str(executable.parent), version=old_version,
                       parent_pid=parent.pid, parent_created=parent.create_time(), argv=argv)
        stage, _, _, _ = validate_context(context, executable)
        path = stage/'legacy-bridge.json'
        path.write_text(json.dumps(context), encoding='utf-8')
        subprocess.Popen([str(executable), '--legacy-update-bridge', str(path)],
                         cwd=stage,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                         close_fds=True)
        return True
    except (OSError, ValueError, KeyError, IndexError, psutil.Error):
        return False  # Self-test remains usable even if recovery is unavailable.


def validate_plan(context, path, executable):
    from collector_update import VERSION
    stage, bundle, install, home = validate_context(context, executable)
    if Path(path).resolve() != stage/'plan.json':
        raise ValueError('Unexpected plan path')
    plan = read_json(path)
    expected = dict(bundle=str(bundle), install=str(install), home=str(home),
                    parent_pid=context['parent_pid'], parent_created=context['parent_created'],
                    argv=context['argv'], version='v'+VERSION, silent=True)
    for key, value in expected.items():
        if plan.get(key) != value:
            raise ValueError('Legacy update plan changed: '+key)
    actual = {}
    for p in bundle.rglob('*'):
        if p.is_symlink() or getattr(p.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Reparse point in staged update')
        if p.is_file():
            actual[p.relative_to(bundle).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    if not actual or actual != plan.get('hashes'):
        raise ValueError('Legacy staged update changed')
    return plan


def restart_requested(status, context, version):
    return (status.get('state') == 'restarting' and status.get('available') == version
            and status.get('current') == context['version']
            and isinstance(status.get('at'), (int, float))
            and context['parent_created'] <= status['at'] <= time.time()+5)


def acquire_lock(lock, timeout=15):
    import msvcrt
    deadline = time.monotonic()+timeout
    while True:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            if time.monotonic() >= deadline:
                return False
            # A helper for the superseded release checks status every 2 seconds
            # and exits. Give it time to release the home lock before giving up.
            time.sleep(.2)


def run_bridge(path):
    import msvcrt
    import psutil
    from collector_update import VERSION, game_active, apply_plan
    context = read_json(path)
    stage, bundle, install, home = validate_context(context, sys.executable)
    if Path(path).resolve() != stage/'legacy-bridge.json':
        raise ValueError('Unexpected bridge path')
    # One recovery helper per home, even when an old client retries a download.
    with (home/'legacy-update.lock').open('a+b') as lock:
        # Windows byte locks also cover reads. Do not read the byte before
        # acquiring it: a previous helper may still hold it. Locking past EOF
        # is supported, so an empty newly-created file is valid as well.
        if not acquire_lock(lock):
            return
        log = home/'legacy-update.log'
        def record(message):
            with log.open('a', encoding='utf-8') as stream:
                stream.write(time.strftime('%Y-%m-%d %H:%M:%S')+' '+message+'\n')
        record('Legacy update recovery ready; waiting for collector handoff.')
        started = time.monotonic()
        requested_at = None
        plan_path = stage/'plan.json'
        while time.monotonic()-started < MAX_WAIT:
            process = same_process(context)
            try:
                status = read_json(home/'update-status.json')
            except (OSError, ValueError):
                status = {}
            if status.get('available') and status['available'] != 'v'+VERSION:
                record('A different release was selected; recovery cancelled.')
                return
            requested = restart_requested(status, context, 'v'+VERSION)
            if not requested:
                if process is None:
                    return
                time.sleep(2)
                continue
            if requested_at is None:
                requested_at = time.monotonic()
            if game_active() or time.monotonic()-requested_at < GRACE_SECONDS:
                time.sleep(2)
                continue
            validate_plan(context, plan_path, sys.executable)
            process = same_process(context)
            if process:
                # The old version already requested shutdown. Allow its capture,
                # dashboard and upload cleanup to finish; only the failed main
                # process (possibly waiting at 'Press Enter') may be terminated.
                # Windows can retain the old console host at the error prompt.
                # It is not a capture/upload worker and exits with that console.
                console_host = Path(os.environ['SystemRoot'])/'System32'/'conhost.exe'
                allowed_children = {bundle/'ClassicWorldCollector.exe', console_host.resolve()}
                other_children = [child for child in process.children(recursive=True)
                                  if Path(child.exe()).resolve() not in allowed_children]
                if other_children:
                    time.sleep(2)
                    continue
                if game_active():
                    continue
                process.terminate()
                process.wait(timeout=15)
                record('Closed the stalled legacy update handoff.')
            # apply_plan repeats identity/hash validation and keeps full rollback.
            record('Installing verified update and preserving local settings.')
            apply_plan(plan_path)
            record('Legacy update recovery complete.')
            return
