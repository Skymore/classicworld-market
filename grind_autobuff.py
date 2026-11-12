"""Recast buffs with the keys the game's own key settings give them.

The key table (server 0x5F5) lists, per keyboard preset, what each key does:
kind 1 is a skill. The current preset comes from the character's record and
the player's own preset switches. A buff is recast only while its run is
active and the game window of that very connection is in the foreground;
presses are simulated through market_keyboard (SendInput or the VMware relay).
"""
import ctypes
import queue
import struct
import threading
import time

KEYMAP_OPCODE = 0x5F5
KEYMAP_INDEX = 212            # mapping-table index of the client's key-setting request
PRESET_OPCODES = (0x8B, 0x1A9)
LEAD = 2.0                    # recast this many seconds before a buff ends
RETRY = 8.0                   # a recast that did not take is retried after this long
GAP = 1.5                     # between two recasts (cast animations)


def skill_tables(plain):
    """{skill: scan code} for each of the three keyboard presets ({} for a default one)."""
    if plain[:2] != struct.pack('<H', KEYMAP_OPCODE):
        raise ValueError('Not a key table')
    offset, tables = 2, []
    try:
        for _ in range(3):
            flag = plain[offset]
            offset += 1
            if flag == 0:
                table = {}
                for scan in range(89):
                    kind, action = struct.unpack_from('<BI', plain, offset + 5 * scan)
                    if kind == 1:
                        table.setdefault(action, scan)
                tables.append(table)
                offset += 445
            elif flag == 1:
                tables.append({})
            else:
                raise ValueError('Unknown key table flag')
    except (IndexError, struct.error):
        raise ValueError('Truncated key table') from None
    return tables


def observe_server(character, op, data):
    if op == KEYMAP_OPCODE:
        try:
            character.skill_keys = skill_tables(data)
        except ValueError:
            character.skill_keys = None
    elif op in PRESET_OPCODES:
        from server_keybinding_preset import read_active_preset
        try:
            preset = read_active_preset(data)
        except ValueError:
            character.key_preset = None
        else:
            if preset is not None:
                character.key_preset = preset


def observe_client(character, index, data):
    if index != KEYMAP_INDEX:
        return
    if len(data) == 4 and data[2] == 3 and data[3] < 3:
        character.key_preset = data[3]
    else:
        character.skill_keys = None   # edited; wait for the next full table


def skill_key(character, skill):
    tables, preset = character.skill_keys, character.key_preset
    if not tables:
        return None
    if preset is None:
        if any(t != tables[0] for t in tables):
            return None
        preset = 0
    return tables[preset].get(skill)


def key_name(scan):
    from market_keyboard import SCANS
    for name, (code, _) in SCANS.items():
        if code == scan:
            return name
    return None


def connection_pid(connection):
    """The game process that owns a captured connection (remote, rport, local, lport)."""
    import psutil
    try:
        for c in psutil.net_connections(kind='tcp'):
            if c.laddr and c.raddr and c.laddr.port == connection[3] and c.raddr.port == connection[1]:
                return c.pid
    except (OSError, psutil.Error):
        pass
    return None


def foreground_pid():
    user = ctypes.windll.user32
    user.GetForegroundWindow.restype = ctypes.c_void_p
    user.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    hwnd = user.GetForegroundWindow()
    if not hwnd:
        return None
    pid = ctypes.c_ulong()
    user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


class AutoBuff:
    """Decides on the tracker's tick; presses on its own thread so capture never waits."""
    def __init__(self, press=None, foreground=foreground_pid, pid_of=connection_pid, threaded=True):
        self.press = press or self.send
        self.threaded = threaded
        self.foreground = foreground
        self.pid_of = pid_of
        self.pids = {}            # connection -> (pid, checked at)
        self.tried = {}           # (session, skill) -> time of the last press
        self.last = 0.0
        self.pressed = 0
        self.jobs = queue.Queue(maxsize=4)
        self.thread = None

    def pid(self, connection, now):
        hit = self.pids.get(connection)
        if hit is None or now - hit[1] > 30:
            hit = self.pids[connection] = (self.pid_of(connection), now)
        return hit[0]

    def tick(self, tracker, now):
        if now - self.last < GAP:
            return
        for character in tracker.characters.values():
            run = character.run
            connection = tracker.connections.get(character.session)
            if not run or run.status != 'active' or connection is None or not character.skill_keys:
                continue
            if character.hp is not None and character.hp <= 0:
                continue
            # Own buffs ending soon or just ended (the tracker keeps those a little
            # while), and pinned ones that ran out: the player keeps them on here.
            due = {source: start + milliseconds / 1000 - now
                   for source, (start, milliseconds) in character.buffs.items()}
            due.update({source: 0 for source in tracker.pinned_buffs(character, now) if source not in due})
            for source, left in sorted(due.items(), key=lambda item: item[1]):
                if source <= 0 or left > LEAD:
                    continue
                if now - self.tried.get((character.session, source), -RETRY) < RETRY:
                    continue
                scan = skill_key(character, source)
                name = key_name(scan) if scan is not None else None
                if name is None:
                    continue
                pid = self.pid(connection, now)
                if pid is None or self.foreground() != pid:
                    return
                self.tried[(character.session, source)] = now
                self.last = now
                self.queue(pid, name)
                return

    def queue(self, pid, name):
        if not self.threaded:
            self.jobs.put_nowait((pid, name))
            return self.run_one()
        if self.thread is None:
            self.thread = threading.Thread(target=self.work, name='grind-auto-buff', daemon=True)
            self.thread.start()
        try:
            self.jobs.put_nowait((pid, name))
        except queue.Full:
            pass

    def work(self):
        while True:
            self.run_one()

    def run_one(self):
        pid, name = self.jobs.get()
        try:
            if self.foreground() == pid:
                self.press(name)
                self.pressed += 1
        except Exception as error:   # noqa: BLE001 - input must never stop tracking
            print(f'Auto buff key not sent ({type(error).__name__}).', flush=True)

    @staticmethod
    def send(name):
        from market_keyboard import send_key
        send_key(name, True)
        try:
            time.sleep(0.06)
        finally:
            send_key(name, False)
