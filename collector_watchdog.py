"""Independent launcher supervision. Normal close and Stop never auto-restart."""
import os
from pathlib import Path
import subprocess
import sys
import time
import math
import uuid

from collector_recovery import ScanIntent, RecoveryLog, atomic_json, read_json

CRASH_LIMIT, CRASH_WINDOW = 3, 180  # Non-zero exits within this many seconds.
STOP_NOTICE = 'scan-watchdog-stop.json'  # Shown once by the next desktop launch.


def should_restart(code, requested, intent):
    return bool(intent.get('enabled') and (requested or code != 0))


class HealthMonitor:
    """A failed read is missing evidence, never proof of a dead process."""
    def __init__(self, launch_id, startup_grace=45, timeout=20, confirm=2):
        self.launch_id = launch_id
        self.startup_grace, self.timeout, self.confirm = startup_grace, timeout, confirm
        self.session = None
        self.started = self.last_seen = self.last_beat = self.suspect = None
        self.update_started = None

    def check(self, health, intent, now):
        if not intent.get('enabled'):
            self.session = None
            self.started = None
            self.update_started = None
            return None
        session = intent.get('session')
        if self.started is None or session != self.session:
            self.session, self.started = session, now
            self.last_seen = self.last_beat = self.suspect = None
            self.update_started = None
        beat = health.get('monotonic')
        valid = (health.get('launch_id') == self.launch_id and health.get('session') == session
                 and type(beat) in (int, float) and math.isfinite(beat) and 0 <= now-beat <= self.timeout)
        if valid and health.get('updating') is True and self.update_started is None:
            self.update_started = now
        # Allow the intentional shutdown to drain uploads without killing its
        # update helper. A stuck handoff still recovers after a bounded grace.
        if self.update_started is not None and now-self.update_started < 120:
            return None
        if valid:
            if self.last_beat is None or beat > self.last_beat:
                self.last_beat, self.last_seen = beat, now
            if health.get('restart') is True:
                return 'blocked_step'
        # Use local monotonic receipt time, not wall clocks or a single {} read.
        reference = self.last_seen if self.last_seen is not None else self.started
        limit = self.timeout if self.last_seen is not None else self.startup_grace
        if now-reference <= limit:
            self.suspect = None
            return None
        if self.suspect is None:
            self.suspect = now
        return 'stale' if now-self.suspect >= self.confirm else None


def terminate_tree(pid):
    import psutil
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
    except psutil.NoSuchProcess:
        return
    # This tree is exclusively our launched collector, never the game.
    processes = []
    for process in [parent, *children]:
        try:
            if process.name().lower() != 'maplestory.exe':
                processes.append(process)
        except psutil.NoSuchProcess:
            pass
    for process in processes:
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(processes, timeout=2)
    for process in alive:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(alive, timeout=2)


def run(home, argv, *, command=None, emergency=None, release=None, startup_grace=45):
    if emergency is None or release is None:
        from scanner_desktop import emergency_stop, release_keys
        emergency = emergency or emergency_stop
        release = release or release_keys
    import psutil
    intent = ScanIntent(home)
    journal = RecoveryLog(home, 'scan-watchdog')
    restarts = 0
    crashes = []
    base = command or ([sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__).with_name('unified_client.py'))])
    try:
        while True:
            args = argv if restarts == 0 else [a for a in argv if a != '--auto-start']
            launch_id = uuid.uuid4().hex
            process = subprocess.Popen([*base, *args, '--supervised'],
                env={**os.environ, 'CW_SCANNER_LAUNCH_ID': launch_id},
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            monitor = HealthMonitor(launch_id, startup_grace=startup_grace)
            requested = False
            emergency_restart = False
            last_sample = 0
            journal.event('process_start', pid=process.pid, restart_count=restarts)
            while process.poll() is None:
                desired = intent.load()
                if desired.get('enabled') and emergency():
                    intent.stop()
                    release()
                    journal.event('emergency_stop')
                    # Also cover a wedged child/GIL. Kill our input process,
                    # then reopen the collector in stopped/manual mode only.
                    emergency_restart = True
                    terminate_tree(process.pid)
                    break
                health = read_json(Path(home)/'scan-health.json')
                now = time.time()
                reason = monitor.check(health, desired, time.monotonic())
                if reason:
                    requested = True
                    journal.event('process_recovery_begin', reason=reason, pid=process.pid,
                                  health_pid=health.get('pid'), health_at=health.get('at'),
                                  last_good_age=None if monitor.last_seen is None else time.monotonic()-monitor.last_seen)
                    terminate_tree(process.pid)
                    release()
                    break
                if now - last_sample >= 30:
                    last_sample = now
                    try:
                        current = psutil.Process(process.pid)
                        sample = dict(at=now, pid=process.pid, memory_bytes=current.memory_info().rss,
                                      threads=current.num_threads(), handles=current.num_handles() if os.name == 'nt' else None,
                                      free_disk_bytes=psutil.disk_usage(str(home)).free, restarts=restarts,
                                      phase=health.get('phase'), pending_uploads=health.get('pending_uploads'),
                                      last_progress_at=health.get('last_progress_at'))
                        atomic_json(Path(home)/'scan-resources.json', sample)
                        journal.event('resources', **sample)
                    except (OSError, psutil.Error):
                        pass
                time.sleep(.1)
            code = process.wait(timeout=5)
            if code != 0 and not emergency_restart:
                release()  # A crashed child cannot release the keys it held.
                now = time.monotonic()
                crashes = [at for at in crashes if now-at < CRASH_WINDOW] + [now]
                if len(crashes) >= CRASH_LIMIT and intent.load().get('enabled'):
                    # Each restart would resume input in the game; stop the loop
                    # and let the player decide after seeing the reason.
                    intent.stop()
                    journal.event('crash_loop_stop', exit_code=code, exits=len(crashes))
                    try:
                        atomic_json(Path(home)/STOP_NOTICE, dict(at=time.time(), reason='crash_loop',
                                                                 exit_code=code, exits=len(crashes)))
                    except OSError:
                        pass
                    return code
            if not emergency_restart and not should_restart(code, requested, intent.load()):
                return code
            restarts += 1
            journal.event('process_recovery_end', exit_code=code, restart_count=restarts)
            # The next child gets only persisted intent. A command-line auto
            # start must never override an emergency stop during this delay.
            time.sleep(min(5, restarts))
            if not emergency_restart and not intent.load().get('enabled'):
                return code
    finally:
        journal.close()
