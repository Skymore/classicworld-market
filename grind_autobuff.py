"""Recast buffs with the keys the game's own key settings give them.

The key table (server 0x5F5) lists, per keyboard preset, what each key does:
kind 1 is a skill. The current preset comes from the character's record and
the player's own preset switches. Kind 2 is an item, kept as its buff source
(the negative item ID). A buff is recast only while its run is
active and the game window of that very connection is in the foreground;
presses are simulated through market_keyboard (SendInput or the VMware relay).
"""
import ctypes
import json
import queue
import struct
import threading
import time

from grind_skills import PROCS

KEYMAP_OPCODE = 0x5F5
KEYMAP_INDEX = 212            # mapping-table index of the client's key-setting request
PRESET_OPCODES = (0x8B, 0x1A9)
# The pet's automatic HP / MP potion (equipment window, pet tab), sent right after
# the key table: opcode, item ID (0 = none). 2026-11-12 live: 2000001, 2010005.
PET_POTION_OPCODES = {0x5F6: 'hp', 0x5F7: 'mp'}
LEAD = 3.0                    # recast a skill this many seconds before its buff ends
ITEM_LATE = 3.0               # use an item this long after its buff ended: sooner, the game may still say it is on
RETRY = 1.5                   # a skill press the game missed (e.g. mid-attack) is retried this soon
ITEM_RETRY = 3.0              # an item is retried more slowly: its buff confirmation must not race a second one
POTION_GAP = 1.2              # between two HP (or two MP) potions: the first one's HP update arrives first
HOLD = 0.12                   # key down time; shorter presses were missed while attacking
GAP = 1.0                     # at most one press a second; several due ones queue, soonest first


def skill_tables(plain):
    """{buff source: scan code} for each of the three keyboard presets ({} for a default one):
    skills by ID, items by negative item ID like their buffs."""
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
                    elif kind == 2 and action:
                        table.setdefault(-action, scan)
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
    if op in PET_POTION_OPCODES and len(data) == 6:
        item = int.from_bytes(data[2:6], 'little')
        character.pet_potions[PET_POTION_OPCODES[op]] = item or None
    elif op == KEYMAP_OPCODE:
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


def pick_potion(character, kind, top):
    """(item, amount restored, key) of the potion to use for 'hp' or 'mp'."""
    from grind_potions import POTIONS
    flat_at, rate_at = (0, 2) if kind == 'hp' else (1, 3)
    choices = {}
    for item, row in POTIONS.items():
        gain = row[flat_at] + row[rate_at] * top / 100
        if gain <= 0 or (character.bags is not None and character.bags.get(item, 0) <= 0):
            continue
        scan = skill_key(character, -item)
        name = key_name(scan) if scan is not None else None
        if name:
            choices[item] = (item, gain, name)
    pet = (character.pet_potions or {}).get(kind)
    if pet in choices:
        return choices[pet]
    return min(choices.values(), key=lambda c: c[1]) if choices else None


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
        self.waiting = None       # why the last due buff was not pressed (state file and log)
        self.last_press = None
        self.potion_at = {}       # (session, 'hp' / 'mp') -> time of the last potion
        self.item_tried = {}      # (character, item buff) -> the ending it was pressed for
        self.jobs = queue.Queue(maxsize=4)
        self.thread = None

    def pid(self, connection, now):
        hit = self.pids.get(connection)
        if hit is None or now - hit[1] > 30:
            hit = self.pids[connection] = (self.pid_of(connection), now)
        return hit[0]

    def tick(self, tracker, now):
        settings = tracker.settings
        for character in tracker.characters.values():
            run = character.run
            connection = tracker.connections.get(character.session)
            if not run or connection is None or not character.skill_keys:
                continue
            if character.hp is not None and character.hp <= 0:
                continue
            # HP / MP first, also while the run waits (standing still is no safer), and
            # not held back by the gap between buffs.
            if settings.get('auto_potion'):
                due = self.potion_due(tracker, character, now)
                if due:
                    kind, item, name = due
                    pid = self.pid(connection, now)
                    if pid is None or self.foreground() != pid:
                        return self.wait('game_not_found' if pid is None else 'game_not_in_front', -item)
                    self.potion_at[(character.session, kind)] = now
                    self.waiting = None
                    self.last_press = dict(at=round(now), source=-item, key=name)
                    print(json.dumps(dict(time=now, event='auto_potion', kind=kind, item=item, key=name,
                                          hp=character.hp, max_hp=character.max_hp, mp=character.mp, max_mp=character.max_mp)), flush=True)
                    self.queue(pid, name)
                    return
            if (not settings.get('auto_buff') or run.status != 'active' or now - self.last < GAP
                    or not tracker.in_combat(character, now)):
                continue
            # Skill buffs the player cast in this run, item buffs the player used
            # in this run, and pinned buffs (the player keeps them on here).
            # Skills from 3 s before they end, items a second after; however long
            # ago they ended. A buff the player renewed has its new time here.
            pinned = tracker.pinned_buffs(character, now)
            cast = {source for segment in run.segments for source in segment.buff_totals
                    if (source > 0 and run.casts.get(source)) or source < 0}
            due = {source: start + milliseconds / 1000 - now
                   for source, (start, milliseconds) in character.buffs.items()}
            due.update({source: character.buff_ended.get(source, now - 3600) - now
                        for source in set(pinned) | cast if source not in due})
            for source, left in sorted(due.items(), key=lambda item: item[1]):
                if source in PROCS:
                    continue      # triggered by hits (Final Attack); a key press does nothing
                if source > 0 and (left > LEAD or (source not in cast and source not in pinned)):
                    continue
                if source < 0 and ((source not in pinned and source not in cast) or left > -ITEM_LATE
                                   or (character.bags is not None and character.bags.get(-source, 0) <= 0)):
                    continue
                wait = RETRY if source > 0 else ITEM_RETRY
                if now - self.tried.get((character.session, source), -wait) < wait:
                    continue
                # An item is pressed once per ending: if the game refuses (its effect
                # is still on), it asks with a dialog, and pressing again only asks
                # again. The next try waits for this buff to come and go once more.
                if source < 0 and source not in character.buffs and source not in character.buff_ended:
                    continue      # never seen on or ending here: it may well still be on
                ending = round(now + left, 1)
                if source < 0 and self.item_tried.get((character.key, source)) == ending:
                    continue
                scan = skill_key(character, source)
                name = key_name(scan) if scan is not None else None
                if name is None:
                    continue
                pid = self.pid(connection, now)
                if pid is None or self.foreground() != pid:
                    return self.wait('game_not_found' if pid is None else 'game_not_in_front', source)
                self.tried[(character.session, source)] = now
                if source < 0:
                    self.item_tried[(character.key, source)] = ending
                self.last = now
                self.waiting = None
                self.last_press = dict(at=round(now), source=source, key=name)
                print(json.dumps(dict(time=now, event='auto_buff', source=source, key=name)), flush=True)
                self.queue(pid, name)
                return

    def potion_due(self, tracker, character, now):
        """(kind, item, key) of the HP or MP potion to drink now, or None.

        Potion: the pet's setting when it has a key and some are left, else the
        one that restores least. HP: when it would not be wasted (missing HP at
        least what it restores) and HP is under four of this map's biggest hits,
        or HP is under two of them whatever the waste. MP: under five of the
        dearest MP drop. Until a hit (or MP cost) is known: under 60 % (30 %)."""
        worst, cost = tracker.combat_limits(character, now)
        for kind in ('hp', 'mp'):
            if now - self.potion_at.get((character.session, kind), -POTION_GAP) < POTION_GAP:
                continue
            current, top = (character.hp, character.max_hp) if kind == 'hp' else (character.mp, character.max_mp)
            if current is None or not top:
                continue
            choice = pick_potion(character, kind, top)
            if choice is None:
                continue
            item, gain, name = choice
            if kind == 'hp':
                want = (top - current >= gain and (current < 4 * worst if worst else current < 0.6 * top))                     or bool(worst and current < 2 * worst)
            else:
                want = current < 5 * cost if cost else current < 0.3 * top
            if want:
                return kind, item, name
        return None

    def wait(self, reason, source):
        if self.waiting != reason:
            print(json.dumps(dict(time=time.time(), event='auto_buff_waiting', reason=reason, source=source)), flush=True)
        self.waiting = reason

    def status(self):
        return dict(pressed=self.pressed, last=self.last_press, waiting=self.waiting)

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
            time.sleep(HOLD)
        finally:
            send_key(name, False)
