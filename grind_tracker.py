"""Automatic grind sessions from the passive server stream.

A run starts when experience arrives repeatedly in one map (a single quest
reward does not start one), pauses when the character leaves the map or
stops gaining, resumes on the next repeated gains, and ends after the pause
outlasts `end_after`. Only what happens while a run is active (or arming)
counts: money picked up, items entering the bags (valued by grind_pricing),
consumables used (shop price) and money spent. Trades, shops, storage and
quest rewards happen while paused and are ignored.

Inventory gaps (an update the decoder cannot read) reset the baseline
without counting; the run shows the gap instead of inventing a delta.
"""
import collections
import bisect
import contextlib
import json
import math
import sqlite3
import time
import weakref
import uuid
from pathlib import Path

import grind_protocol as proto
import grind_combat as combat
from grind_data import exp_to_next, job_name
from grind_skills import FOLLOW_UPS, PROCS, skill_name
import grind_autobuff as autobuff
import game_opcodes
import grind_pets

DEFAULTS = dict(enabled=True, record_frames=True, upload=True, idle_seconds=90, end_after_seconds=600,
                start_events=3, start_window=60, price_basis='typical', notable_value=500000,
                count_mesos_spent=True, min_upload_seconds=300, buff_warn_seconds=3, buff_warn_version=2, buff_sound=True, hp_warn=True, auto_buff=False, auto_potion=False,
                hotkeys=dict(overlay='Ctrl+Alt+O', pause='Ctrl+Alt+P', end='Ctrl+Alt+E'),
                overlay=dict(enabled=True, layout='slim', theme='dark', opacity=0.92, scale=1.0,
                             hide_in_capture=False, stream=False, mouse_through=False, x=None, y=None,
                             fields=['time', 'exp_rate', 'profit', 'level', 'buffs', 'potions', 'recent']),
                # 绩效模式: 积分 per 10,000 experience plus per 10,000 收益 (mesos picked up and basic
                # drops' value); the net stays over everything. frontend grind-points.ts does the sum.
                performance=dict(enabled=False, exp_per_10k=0.8, income_per_10k=0.7))
NESTED = ('overlay', 'hotkeys', 'performance')
IDLE_CREDIT = 10
ITEM_WAIT = autobuff.ITEM_WAIT
BLIND_LIMIT = 3600   # a longer gap between two known bag states is not bridged
SLOT = 10                   # seconds per experience slot kept for the chart
CHART_WINDOW = 60           # each chart point is the rate over the minute before it
CHART_POINTS = 360
COMBAT_SECONDS = 10
AUTO_BUFF_OPS = (autobuff.KEYMAP_OPCODE,) + autobuff.PRESET_OPCODES + tuple(autobuff.PET_POTION_OPCODES)
RECENT = 8
HISTORY_LIMIT = 500
# A buff kept on over half the time on a map in the last three days stays on screen there.
PIN_DAYS, PIN_SHARE, PIN_MIN_SECONDS = 3, 0.5, 600
ITEM_MATCH_SECONDS = 2


def basic_drop(item):
    """Counted in 积分 (绩效模式): potions, foods and other recovery or buff consumables
    (200–202xxxx), monsters' own etc drops (4000xxx) and ores (crystal 4004xxx, mineral
    and jewel 401–402xxxx); never scrolls, stars, books, quest items or equipment. Same
    rule as frontend grind-points.ts."""
    item = item or 0
    return 200 <= item // 10000 <= 202 or item // 1000 in (4000, 4004) or 401 <= item // 10000 <= 402


def load_settings(path):
    settings = json.loads(json.dumps(DEFAULTS))
    try:
        saved = json.loads(Path(path).read_text(encoding='utf-8'))
        for key, value in saved.items():
            if key in NESTED and isinstance(value, dict):
                settings[key].update({k: v for k, v in value.items() if k in DEFAULTS[key]})
            elif key in DEFAULTS and type(value) is type(DEFAULTS[key]) or (key in DEFAULTS and isinstance(value, (int, float))
                                                                          and isinstance(DEFAULTS[key], (int, float))):
                settings[key] = value
    except (OSError, ValueError, AttributeError):
        pass
    else:
        # 2026-11-15: buffs are warned 3 s before they end (was 10 s by default); move
        # settings saved before then once. Item buffs are said 3 s after (overlay).
        if not isinstance(saved, dict) or saved.get('buff_warn_version', 1) < 2:
            settings['buff_warn_seconds'] = DEFAULTS['buff_warn_seconds']
    return settings


def bag_totals(inventory):
    """{item: quantity} of use/setup/etc bags, or None while unknown."""
    if inventory.slots is None:
        return None
    totals = collections.Counter()
    for item, quantity in inventory.slots.values():
        totals[item] += quantity
    return totals


def equipment_pieces(inventory):
    """Multiset of (item, attribute key) over bag and worn pieces; moves cancel out."""
    if inventory.equipment is None or inventory.worn is None:
        return None
    from grind_pricing import group_key
    pieces = collections.Counter()
    examples = {}
    for piece in [*inventory.equipment.values(), *inventory.worn.values()]:
        key = (piece['item_id'], group_key(piece))
        pieces[key] += 1
        examples[key] = piece
    return pieces, examples


_VIEWS = weakref.WeakKeyDictionary()


def bag_view(inventory):
    """(bag_totals, equipment_pieces), computed again only when the bags changed. Every
    message used to recount the whole bag and key every piece of equipment (a JSON dump
    each): 57 % of a replay's time (2026-11-15 profile). Inventory replaces its dicts on
    each change, never edits them, so the same objects mean the same contents; the cache
    keeps them referenced, so their identities cannot be reused."""
    from market_inventory import Inventory
    if type(inventory) is not Inventory:   # stand-ins (tests) may edit their dicts in place
        return bag_totals(inventory), equipment_pieces(inventory)
    cached = _VIEWS.get(inventory)
    if (cached and cached[0] is inventory.slots and cached[1] is inventory.equipment
            and cached[2] is inventory.worn):
        return cached[3], cached[4]
    bags, pieces = bag_totals(inventory), equipment_pieces(inventory)
    _VIEWS[inventory] = (inventory.slots, inventory.equipment, inventory.worn, bags, pieces)
    return bags, pieces


class Cumulative:
    """Running total of (time, amount) gains, read at any time with each gain
    spread evenly over the gap since the one before it (at most SPREAD seconds).
    Kills arrive in whole chunks: counting them whole made a sliding minute jump
    by a full kill each time one crossed its edge, a saw-tooth line. Spread out,
    the edge cuts through part of a kill, as an EXP bar read between kills does."""
    SPREAD = 60

    def __init__(self, events):
        events = sorted(events)
        self.at = [t for t, _ in events]
        self.gain = [v for _, v in events]
        self.total = [0.0]
        for v in self.gain:
            self.total.append(self.total[-1] + v)

    def __call__(self, t):
        i = bisect.bisect_left(self.at, t)
        value = self.total[i]
        if 0 < i < len(self.at):   # the first gain has nothing before it to spread over
            begin = max(self.at[i - 1], self.at[i] - self.SPREAD)
            if t > begin:
                value += self.gain[i] * (t - begin) / (self.at[i] - begin)
        return value

    def window(self, t, seconds):
        return self(t) - self(t - seconds)


class ActiveClock:
    """Run time with its pauses left out, for the charts: a manual or idle pause is not a
    stretch of zero rate, so the line goes straight from before the pause to after it
    (2026-11-15: a 10-minute pause drew the experience line down to 0 and back)."""

    def __init__(self, start, pauses):
        self.start = start
        self.pauses = sorted((a, b) for a, b in pauses if b > a)

    def active(self, t):
        """Wall clock -> seconds of the run outside pauses."""
        gone = 0.0
        for a, b in self.pauses:
            if t <= a:
                break
            gone += min(t, b) - a
        return t - self.start - gone

    def wall(self, seconds):
        """Seconds outside pauses -> wall clock (the end of a pause when it falls on one)."""
        t = self.start + seconds
        for a, b in self.pauses:
            if t < a:
                break
            t += b - a
        return t


class Segment:
    def __init__(self, map_id, level, job, now):
        self.map_id, self.level, self.job = map_id, level, job
        self.started_at = now
        self.active_seconds = 0.0
        self.exp = 0
        self.kills = 0
        self.mesos = 0
        self.drops = collections.Counter()
        self.mobs = collections.Counter()
        self.buffs = collections.Counter()   # buff source -> seconds it was on while active here
        self.buff_totals = {}                # buff source -> its last full duration in seconds
        self.max_hit = 0                     # biggest single HP drop here
        self.mp_cost = 0                     # biggest single MP drop (the dearest skill)
        # Drop rates for the map page: every mob this character or its party killed
        # here, and every item that fell from those (picked up or not). None on
        # segments saved before this was counted.
        self.seen_kills = 0
        self.seen_drops = collections.Counter()

    def to_json(self):
        return dict(map_id=self.map_id, level=self.level, job=self.job, started_at=self.started_at,
                    active_seconds=round(self.active_seconds, 1), exp=self.exp, kills=self.kills, mesos=self.mesos,
                    drops={str(k): v for k, v in self.drops.items()}, mobs={str(k): v for k, v in self.mobs.items()},
                    buffs={str(k): round(v, 1) for k, v in self.buffs.items() if v >= 1},
                    buff_totals={str(k): v for k, v in self.buff_totals.items()},
                    max_hit=self.max_hit, mp_cost=self.mp_cost, seen_kills=self.seen_kills,
                    seen_drops={str(k): v for k, v in self.seen_drops.items()})

    @classmethod
    def from_json(cls, data):
        segment = cls(data['map_id'], data.get('level'), data.get('job'), data['started_at'])
        segment.active_seconds = data.get('active_seconds', 0)
        for key in ('exp', 'kills', 'mesos'):
            setattr(segment, key, data.get(key, 0))
        segment.drops = collections.Counter({int(k): v for k, v in (data.get('drops') or {}).items()})
        segment.mobs = collections.Counter({int(k): v for k, v in (data.get('mobs') or {}).items()})
        segment.buffs = collections.Counter({int(k): v for k, v in (data.get('buffs') or {}).items()})
        segment.buff_totals = {int(k): v for k, v in (data.get('buff_totals') or {}).items()}
        segment.max_hit, segment.mp_cost = data.get('max_hit') or 0, data.get('mp_cost') or 0
        segment.seen_kills = data.get('seen_kills')
        segment.seen_drops = collections.Counter({int(k): v for k, v in (data.get('seen_drops') or {}).items()})
        return segment


class Run:
    """One grind session of one character."""
    def __init__(self, character, now):
        self.id = uuid.uuid4().hex
        self.character = dict(character)
        self.started_at = now
        self.status = 'active'
        self.pause_reason = None
        self.paused_at = None
        self.pauses = []            # [paused_at, resumed_at]: the charts leave these out
        self.idle_seconds = 0.0
        self.last_gain = now
        self.credited_until = now
        self.segments = []
        self.ledger = []          # dicts: t, kind, item_id, quantity, mesos, piece
        self.exp_events = []      # (t, exp) for windowed rates
        self.exp_minutes = collections.Counter()   # unix minute -> exp, the whole run
        self.exp_slots = collections.Counter()     # unix 10-second slot -> exp, the whole run (charts)
        self.deaths = 0
        self.exp_lost = 0
        self.hp_lost = 0
        self.hp_drops = 0
        self.attacks = collections.Counter()   # skill ID (0 = plain attack) -> attacks
        self.casts = collections.Counter()     # skill ID -> casts
        self.combat = combat.Meter()
        self.kill_attacks = {}  # mob -> attack count -> observed solo kills
        self.gaps = 0
        self.level_start = character.get('level')
        self.kills_by_exp = None   # last known: kills counted from experience, not kill messages
        self.finds = []            # valuable drops for this character or its party (ground_drop)
        # [time, map, {item: quantity}, mesos, connection]: the bags as last known in this run. After a
        # stretch where they could not be followed (a restart that could not take over the
        # connection, an update we could not read), the next known bags are compared to this.
        self.bags_seen = None
        # [time, level, experience, connection]: the experience as last read in this run (paused
        # or not), and how much was added across stretches nothing could be read (bridge_exp).
        self.exp_seen = None
        self.exp_bridged = 0

    def add_exp(self, event):
        self.exp_events.append(event)
        self.exp_minutes[int(event[0] // 60)] += event[1]
        self.exp_slots[int(event[0] // SLOT)] += event[1]

    @property
    def segment(self):
        return self.segments[-1] if self.segments else None

    def active_seconds(self, now):
        total = sum(s.active_seconds for s in self.segments)
        if self.status == 'active':
            total += max(0.0, now - self.credited_until)
        return total

    def credit(self, until, buffs=None):
        if self.segment and until > self.credited_until:
            for source, (start, milliseconds) in (buffs or {}).items():
                overlap = min(until, start + milliseconds / 1000) - max(self.credited_until, start)
                if overlap > 0:
                    self.segment.buffs[source] += overlap
                    self.segment.buff_totals[source] = milliseconds / 1000
            self.segment.active_seconds += until - self.credited_until
            self.credited_until = until

    def to_json(self):
        return dict(id=self.id, character=self.character, started_at=self.started_at, status=self.status,
                    pause_reason=self.pause_reason, paused_at=self.paused_at, idle_seconds=self.idle_seconds,
                    pauses=self.pauses, last_gain=self.last_gain, credited_until=self.credited_until,
                    segments=[s.to_json() for s in self.segments], ledger=self.ledger,
                    exp_events=[e for e in self.exp_events if e[0] >= self.credited_until - 1260],
                    exp_minutes={str(k): v for k, v in self.exp_minutes.items()},
                    exp_slots={str(k): v for k, v in self.exp_slots.items()}, deaths=self.deaths, exp_lost=self.exp_lost, gaps=self.gaps,
                    hp_lost=self.hp_lost, hp_drops=self.hp_drops,
                    attacks={str(k): v for k, v in self.attacks.items() if v}, casts={str(k): v for k, v in self.casts.items() if v},
                    combat=self.combat.to_json(), kill_attacks=self.kill_attacks,
                    level_start=self.level_start, kills_by_exp=self.kills_by_exp, finds=self.finds,
                    bags_seen=None if self.bags_seen is None else [self.bags_seen[0], self.bags_seen[1],
                                                                   {str(k): v for k, v in self.bags_seen[2].items()},
                                                                   self.bags_seen[3], None],
                    exp_seen=None if self.exp_seen is None else self.exp_seen[:3] + [None],
                    exp_bridged=self.exp_bridged)

    @classmethod
    def from_json(cls, data):
        run = cls(data['character'], data['started_at'])
        for key in ('id', 'status', 'pause_reason', 'paused_at', 'idle_seconds', 'last_gain', 'credited_until',
                    'ledger', 'deaths', 'exp_lost', 'gaps', 'level_start', 'hp_lost', 'hp_drops', 'kills_by_exp', 'finds'):
            setattr(run, key, data.get(key, getattr(run, key)))
        run.exp_events = [tuple(e) for e in data.get('exp_events') or []]
        run.pauses = [[float(a), float(b)] for a, b in data.get('pauses') or []]
        run.exp_minutes = collections.Counter({int(k): v for k, v in (data.get('exp_minutes') or {}).items()})
        run.exp_slots = collections.Counter({int(k): v for k, v in (data.get('exp_slots') or {}).items()})
        run.attacks = collections.Counter({int(k): v for k, v in (data.get('attacks') or {}).items()})
        run.casts = collections.Counter({int(k): v for k, v in (data.get('casts') or {}).items()})
        run.combat = combat.Meter(data.get('combat'))
        run.kill_attacks = data.get('kill_attacks', {})
        run.segments = [Segment.from_json(s) for s in data.get('segments') or []]
        seen = data.get('bags_seen')
        if seen and len(seen) >= 4 and isinstance(seen[2], dict):
            # Saved without its connection: the next process never shares it.
            run.bags_seen = [seen[0], seen[1], {int(k): v for k, v in seen[2].items()}, seen[3], None]
        exp_seen = data.get('exp_seen')
        if exp_seen and len(exp_seen) >= 3:
            run.exp_seen = [exp_seen[0], exp_seen[1], exp_seen[2], None]   # another process: never the same connection
        run.exp_bridged = data.get('exp_bridged') or 0
        return run


class Character:
    """What one connection has told us about its character."""
    def __init__(self, session):
        self.session = session
        self.key = None
        self.name = None
        self.level = None
        self.job = None
        self.exp = None
        self.map_id = None
        self.mesos = None
        self.bags = None
        self.pieces = None
        self.arming = []            # (t, map_id) of recent experience gains while not active
        self.staged = []            # ledger entries seen while arming
        self.staged_exp = []        # (t, exp) gains seen while arming
        self.staged_kills = []      # (t, mob ID) own kills seen while arming
        self.character_id = None
        self.hit = {}               # object id -> time this character last hit it
        self.mobs = {}              # object id -> catalogue mob ID
        self.hp = None
        self.max_hp = None
        self.mp = None
        self.max_mp = None
        self.pet_potions = {}       # 'hp' / 'mp' -> the item the pet was set to use
        self.pets = {}              # pet serial -> grind_pets state (fullness, out or in the bag)
        self.rise_at = {}           # 'hp' / 'mp' -> when it last went up (a potion took)
        self.table = None
        self.exp_messages = 0       # experience announced since the last experience update
        self.buffs = {}             # source -> (start, milliseconds)
        self.buff_masks = {}        # source -> stat flags of its buff message, for cancels
        self.buff_on = {}           # source -> when it last turned on (not a refresh)
        self.buff_ended = {}        # source -> when it last ended (cancel or time)
        self.combat_at = None       # last own attack or kill: buffs are kept up only in combat
        self.party_id = None        # owner of the party's drops
        self.deaths_seen = {}       # mob object -> (time, killer character) for its drops
        self.drops = collections.deque(maxlen=20)   # valuable drops this character can pick up
        self.skill_keys = None      # per keyboard preset: skill -> scan code (grind_autobuff)
        self.key_preset = None
        self.pickups = collections.deque(maxlen=256)   # [t, item id, unmatched quantity]
        self.pending_loot = collections.deque(maxlen=256)
        self.uses = collections.deque(maxlen=256)      # [t, item id, unmatched quantity, slot]
        self.pending_uses = collections.deque(maxlen=256)
        self.bag_slots = None
        self.client_seen = False
        self.client_at = None
        self.party = None
        self.kill_owners = {}
        self.mob_attacks = {}
        self.staged_combat = []
        self.run = None

    def facts(self):
        return dict(key=self.key, name=self.name, level=self.level, job=self.job)


class Tracker:
    # The keyboard preset only feeds the live auto-buff prompt. Reading it scans each
    # full character snapshot for its key table, a third of a replay's time after the
    # bag cache (2026-11-15 profile); replays and rebuilds turn it off.
    read_presets = True
    # Live: the player's messages come from the updated game, whose mapping table moved
    # (market_passive sets it; replays get indexes already in the old numbering).
    renumber_client = False

    def __init__(self, folder, prices, now=time.time):
        self.folder = Path(folder)
        self.data = self.folder / 'grind'
        self.prices = prices
        self.now = now
        self.characters = {}
        self.connections = {}       # session -> captured TCP connection, for the game window
        self.auto_buff = None
        self.finished = []          # summaries of runs ended this process
        self.settings_path = self.data / 'settings.json'
        self.profile_path = self.data / 'protocol.json'
        self.settings_mtime = self.profile_mtime = None
        self.settings = load_settings(self.settings_path)
        self.profile = proto.load_profile(self.profile_path)
        self.last_publish = 0
        self.last_persist = 0
        self.command_mtime = None
        self.command_id = None
        self.health = collections.Counter()
        self.dirty = True
        self.frames = None
        self.reload(force=True)
        self.restore()

    # ----- configuration -------------------------------------------------
    def reload(self, force=False):
        for attr, path, loader in (('settings', self.settings_path, load_settings),
                                   ('profile', self.profile_path, proto.load_profile)):
            try:
                mtime = path.stat().st_mtime
            except OSError:
                mtime = None
            if force or mtime != getattr(self, attr + '_mtime'):
                setattr(self, attr + '_mtime', mtime)
                setattr(self, attr, loader(path))
                self.dirty = True
        # Continuous local recording supports replay after parser upgrades.
        recording = self.settings['record_frames']
        if recording and self.frames is None:
            from grind_frames import FrameLog
            self.frames = FrameLog(self.data / 'frames')
        elif not recording and self.frames is not None:
            self.frames.close()
            self.frames = None

    # ----- stream input --------------------------------------------------
    def observe(self, session, data, inventory):
        """One decrypted server frame, after `inventory` has applied it."""
        if not self.settings['enabled']:
            return
        now = self.now()
        if self.frames is not None:
            self.frames.write(session, data, now)
        character = self.characters.get(session)
        if character is None:
            character = self.characters[session] = Character(session)
            self.adopt(character)
        op = int.from_bytes(data[:2], 'little')
        if op in AUTO_BUFF_OPS and (self.read_presets or op not in autobuff.PRESET_OPCODES):
            autobuff.observe_server(character, op, data)
        if op == 0x32:
            from classicworld_codec import opcode_table
            try:
                character.table = opcode_table(data)
            except ValueError:
                character.table = None
            return
        if op in proto.MAP_ENTRY:
            self.map_entry(character, data, now)
        elif op == proto.STAT:
            self.stat(character, data, now)
        else:
            self.other(character, data, now)
        if op in (0x72, 0x1a6, 0x1a9):
            grind_pets.observe(character.pets, data, proto.is_snapshot(data), now)
        if inventory.session == session:
            self.inventory(character, inventory, now, rebase=proto.is_snapshot(data))

    def observe_client(self, session, data, recorded_index=None):
        """One of the player's own messages (attacks, skills, damage taken).

        Recorded with its mapping-table index until their layouts are
        calibrated; nothing is counted from them yet."""
        if not self.settings['enabled'] or len(data) < 2:
            return
        character = self.characters.get(session)
        table = getattr(character, 'table', None) if character else None
        op = int.from_bytes(data[:2], 'little')
        index = recorded_index if recorded_index is not None else (table.index(op) if table and op in table else None)
        if recorded_index is None and index is not None and self.renumber_client:
            index = game_opcodes.client_index(index)   # the updated game's table (game_opcodes)
        self.health['client_frames'] += 1
        if character is not None:
            character.client_seen = True
            character.client_at = self.now()
            autobuff.observe_client(character, index, data)
        request = proto.consume_request(index, data, (self.profile.get('client') or {}).get('consume') or {})
        if request and character.bag_slots is not None:
            slot, item = request
            held = character.bag_slots.get((2, slot))
            pending = any(e['item'] == item and e['slots'].get(slot, 0) > 0
                          and 0 <= self.now() - e['t'] <= ITEM_MATCH_SECONDS for e in character.pending_uses)
            if (held and held[0] == item and held[1] > 0) or pending:
                character.uses.append([self.now(), item, 1, slot])
                self.match_uses(character, self.now())
        action = proto.client_action(index, data, self.profile.get('client') or {})
        if action and action[0] == 'attack':
            character.combat_at = self.now()
            damage = combat.attack(data, index)
            self.combat_attack(character, character.character_id, damage, self.now(), own=True)
        run = character.run if character else None
        if action and run and run.status == 'active':
            run.attacks[action[1]] += 1 if action[0] == 'attack' else 0
            run.casts[action[1]] += 1 if action[0] == 'cast' else 0
            self.dirty = True
        if self.frames is not None:
            self.frames.write(session, data, self.now(), index=index, client=True)

    def adopt(self, character):
        """A new connection of a character whose run is still open (channel change)."""
        for other in list(self.characters.values()):
            if other is not character and other.run and other.key and other.key == character.key:
                character.run, other.run = other.run, None

    def map_entry(self, character, data, now):
        self.clear_item_matches(character)
        vitals = proto.vitals(data)
        if vitals:
            character.hp, character.max_hp, character.mp, character.max_mp = vitals
        info = proto.read_character(data, self.profile)
        if info:
            key = info.get('name') or info.get('character_id')
            if key and key != character.key:
                character.key = key
                self.adopt_by_key(character)
            for field in ('name', 'level', 'job', 'exp', 'character_id'):
                if info.get(field) is not None:
                    setattr(character, field, info[field])
            if info.get('exp') is not None:
                self.bridge_exp(character, now)   # a new connection's snapshot holds the experience
        new_map = proto.map_id(data)
        if new_map is None:
            return
        if new_map != character.map_id and character.run and character.run.status == 'active':
            self.pause(character.run, 'map', now)
        if character.run and character.map_id is not None and new_map != character.map_id:
            character.run.bags_seen = None   # another map (a town): its purchases are not loot
        character.map_id = new_map
        self.prices.want_map(new_map)
        character.arming.clear()
        character.staged.clear()
        character.hit.clear()
        character.mobs.clear()
        character.mob_attacks.clear()
        character.staged_kills = []
        character.kill_owners.clear()
        character.staged_combat.clear()
        self.dirty = True

    CARRIED = ('buffs', 'buff_masks', 'buff_on', 'buff_ended', 'pet_potions', 'pets')

    def carry_buffs(self, character, source):
        """A channel change opens a new connection, and the server does not send the
        buffs that are still on again. Without them, auto buff took a potion with
        5 minutes left as long gone and pressed it (2026-11-12 19:06), and the game
        kept asking. Copy what the old connection knew; the newest news wins, from
        whichever connection: after several channel changes the oldest connection
        still held a speed potion's first drink, and copied first, it hid the
        refill a later one saw, so the potion showed as running out (2026-11-13)."""
        for name in self.CARRIED:
            known, mine = source.get(name) or {}, getattr(character, name)
            for key, value in known.items():
                if name == 'buffs':
                    start = value[0]
                    if key not in mine or start > mine[key][0]:
                        mine[key] = tuple(value)
                        if 'buff_masks' in source and key in source['buff_masks']:
                            character.buff_masks[key] = source['buff_masks'][key]
                elif name in ('buff_on', 'buff_ended'):
                    mine[key] = max(mine.get(key, value), value)
                elif name != 'buff_masks':
                    mine.setdefault(key, value)
        for key, value in (source.get('buff_masks') or {}).items():
            character.buff_masks.setdefault(key, value)
        character.combat_at = max(character.combat_at or 0, source.get('combat_at') or 0) or None

    @staticmethod
    def buff_state(character):
        state = {name: dict(getattr(character, name)) for name in Tracker.CARRIED}
        state['combat_at'] = character.combat_at
        return state

    def adopt_by_key(self, character):
        carried = self.__dict__.setdefault('carried', {})
        for other in self.characters.values():
            if other is not character and other.key == character.key:
                self.carry_buffs(character, self.buff_state(other))
        if character.key in carried:
            self.carry_buffs(character, carried.pop(character.key))
        for other in self.characters.values():
            if other is not character and other.key == character.key and other.run:
                character.run, other.run = other.run, None
        for run in self.restored:
            if run.character.get('key') == character.key:
                character.run = run
                self.restored.remove(run)
                break

    def stat(self, character, data, now):
        sizes = (self.profile.get('stat') or {}).get('sizes') or {}
        values = proto.parse_stat(data, sizes)
        if values is None:
            header = proto.stat_header(data)
            if header and header[0] >> proto.MESO_BIT & 1:
                character.mesos = None  # changed by a frame we cannot read; rebase later
            return
        bits = (self.profile.get('stat') or {}).get('bits') or {}
        if proto.MESO_BIT in values:
            mesos = values[proto.MESO_BIT]
            if character.mesos is not None and mesos != character.mesos:
                self.money(character, mesos - character.mesos, now)
            character.mesos = mesos
        level_bit, job_bit, exp_bit = bits.get('level'), bits.get('job'), bits.get('exp')
        old_level = character.level
        if job_bit in values:
            character.job = values[job_bit]
        if level_bit in values:
            character.level = values[level_bit]
        hp_bit = bits.get('hp')
        if hp_bit in values:
            hp = values[hp_bit]
            run = character.run
            if character.hp is not None and hp < character.hp and run and run.status == 'active':
                # Includes HP paid for skills; the client messages will split this by mob.
                run.hp_lost += character.hp - hp
                run.hp_drops += 1
                self.dirty = True
            if character.hp is not None and hp < character.hp and run and run.segment:
                run.segment.max_hit = max(run.segment.max_hit, character.hp - hp)
            if character.hp is not None and hp < character.hp:
                character.combat_at = now
            if character.hp is not None and hp > character.hp:
                character.rise_at['hp'] = now
            character.hp = hp
            if character.max_hp is not None and hp > character.max_hp:
                character.max_hp = hp
        mp_bit = bits.get('mp')
        if mp_bit in values:
            mp = values[mp_bit]
            run = character.run
            if character.mp is not None and mp < character.mp and run and run.segment:
                run.segment.mp_cost = max(run.segment.mp_cost, character.mp - mp)
            if character.mp is not None and mp > character.mp:
                character.rise_at['mp'] = now
            character.mp = mp
            if character.max_mp is not None and mp > character.max_mp:
                character.max_mp = mp
        if exp_bit in values and self.profile['stat'].get('confirmed'):
            self.experience(character, values[exp_bit], old_level, now)

    def experience(self, character, value, old_level, now):
        previous = character.exp
        self.counted_experience(character, value, old_level, now)
        if previous is None:
            self.bridge_exp(character, now)       # the first reading of this connection
        elif character.run:
            character.run.exp_seen = [now, character.level, character.exp, character.session]

    def bridge_exp(self, character, now):
        """Experience gained while nothing could be read, added when a new connection first
        reads it (2026-11-21: two collector restarts in a run left 25,000 uncounted; bags and
        mesos were already bridged, experience was not). The run remembers the experience as
        last read, paused or not, so what a manual pause or another map did not count stays
        uncounted; on a channel change nothing was missed and the difference is 0. Marked
        estimated in `exp_bridged`, at most BLIND_LIMIT after the last reading."""
        run = character.run
        if run is None or character.exp is None or character.level is None:
            return
        seen, run.exp_seen = run.exp_seen, [now, character.level, character.exp, character.session]
        if not seen or seen[3] == character.session or now - seen[0] > BLIND_LIMIT:
            return
        gap = exp_between(seen[1], seen[2], character.level, character.exp)
        if not gap or gap <= 0:
            return
        segment = run.segment or (run.segments[-1] if run.segments else None)
        if segment:
            segment.exp += gap
        run.add_exp((now, gap))
        run.exp_bridged += gap
        self.dirty = True

    def counted_experience(self, character, value, old_level, now):
        previous = character.exp
        character.exp = value
        announced, character.exp_messages = character.exp_messages, 0
        self.health['exp_updates'] += 1
        if previous is None:
            return
        levelled = character.level is not None and old_level is not None and character.level > old_level
        if not levelled and value < previous and announced:
            # The gained-EXP message arrives just before the update: a drop
            # right after one is a level-up whose level field we cannot read.
            levelled, old_level = True, character.level
            if character.level is not None:
                character.level += 1
        if levelled:
            need = exp_to_next(old_level) if old_level else None
            gain = (need - previous + value) if need and need >= previous else (announced or value)
        elif value >= previous:
            gain = value - previous
        else:
            run = character.run
            if run and run.status == 'active':
                run.deaths += 1
                run.exp_lost += previous - value
                run.add_exp((now, value - previous))
                self.dirty = True
            return
        if gain <= 0:
            return
        self.gain(character, now, exp=gain)

    def other(self, character, data, now):
        op = proto.opcode(data)
        if op == combat.PARTY:
            self.party_update(character, data)
            return
        if op == proto.DROP:
            self.ground_drop(character, data, now)
            return
        if op == proto.LEAVE:
            self.ground_leave(character, data, now)
            return
        if op in combat.REMOTE_ATTACKS:
            actor = proto.u32(data, 2)
            # Own attacks are counted from the client direction only.
            if actor != character.character_id:
                self.combat_attack(character, actor, combat.attack(data), now)
            return
        mob = proto.spawned(data, self.profile.get('spawn') or {})
        if mob:
            if mob[0] not in character.mobs and op == 0x3C9 and character.run and character.run.status == 'active':
                character.mob_attacks[mob[0]] = dict(run=character.run.id, attacks=0, mixed=False)
            character.mobs[mob[0]] = mob[1]
            if len(character.mobs) > 4000:
                for old in list(character.mobs)[:2000]:
                    del character.mobs[old]
                    character.mob_attacks.pop(old, None)
            return
        kill = self.profile.get('kill') or {}
        owner = kill.get('owner') or {}
        if op == owner.get('opcode'):
            oid, actor = proto.u32(data, owner.get('offset', 2)), proto.u32(data, owner.get('char_offset', 6))
            if oid is not None and actor is not None:
                character.kill_owners[oid] = (now, actor)
                if len(character.kill_owners) > 4000:
                    for old in list(character.kill_owners)[:2000]:
                        del character.kill_owners[old]
                if actor != character.character_id:
                    if oid in character.mob_attacks:
                        character.mob_attacks[oid]['mixed'] = True
                    character.hit.pop(oid, None)
        oid = proto.hit_by(data, kill, character.character_id)
        if oid is not None:
            character.hit[oid] = now
            if len(character.hit) > 4000:
                for old in sorted(character.hit, key=character.hit.get)[:2000]:
                    del character.hit[old]
            return
        oid = proto.death(data, kill)
        if oid is not None:
            # Only mobs this character hit count; other players' kills do not.
            attribution = character.kill_owners.pop(oid, None)
            # Who killed it, for the drops that follow (ground_drop): this
            # character, or the last party member the server credited with a hit.
            killer = character.character_id if oid in character.hit else (attribution[1] if attribution else None)
            run = character.run
            counted = None
            if killer is not None and (killer == character.character_id or killer in (character.party or {}))                     and run and run.status == 'active' and run.segment and run.segment.seen_kills is not None:
                run.segment.seen_kills += 1
                counted = (run.id, len(run.segments) - 1)   # plain data: reconcile snapshots this
            character.deaths_seen[oid] = (now, killer, counted)
            if len(character.deaths_seen) > 200:
                for old in list(character.deaths_seen)[:100]:
                    del character.deaths_seen[old]
            if attribution and 0 <= now - attribution[0] <= 120:
                self.health['attributed_kills'] += 1
                actor = attribution[1]
                member = (character.party or {}).get(actor)
                me = (character.party or {}).get(character.character_id)
                if member and actor != character.character_id and (not me or member['channel'] == me['channel']):
                    self.combat_event(character, dict(t=now, actor=actor, name=member['name'], own=False, kill=True, mob=character.mobs.get(oid)), now)
            mob = character.mobs.pop(oid, None)
            sample = character.mob_attacks.pop(oid, None)
            if character.hit.pop(oid, None) is not None:
                self.health['kills'] += 1
                run = character.run
                if mob:
                    self.prices.want_mob(mob)
                if run and run.status == 'active' and run.segment:
                    run.combat.kill(character.character_id, character.name, True, mob, now)
                    if sample and sample['run'] == run.id and not sample['mixed'] and sample['attacks'] > 0:
                        histogram = run.kill_attacks.setdefault(str(mob), {})
                        count = str(sample['attacks'])
                        histogram[count] = histogram.get(count, 0) + 1
                    run.segment.kills += 1
                    if mob:
                        run.segment.mobs[mob] += 1
                    self.dirty = True
                elif not (run and run.pause_reason == 'manual'):
                    window = self.settings['start_window']
                    character.staged_kills = [k for k in character.staged_kills if now - k[0] <= window] + [(now, mob)]
            return
        gained = proto.experience_message(data, self.profile)
        if gained is not None:
            character.exp_messages += gained
            self.health['exp_messages'] += 1
            return
        found = proto.pickup(data, self.profile.get('pickup') or {})
        if found and found[0] == 'item':
            character.pickups.append([now, found[1], found[2]])
            self.match_loot(character, now)
            return
        cancelled = proto.cancel_mask(data)
        if cancelled:
            for source, mask in list(character.buff_masks.items()):
                if mask and mask & cancelled == mask:
                    del character.buff_masks[source]
                    if character.buffs.pop(source, None) is not None:
                        character.buff_ended[source] = now
                        self.dirty = True
            return
        buff = proto.parse_buff(data, self.profile.get('buff') or {})
        if buff:
            source, milliseconds = buff
            held = character.buffs.get(source)
            if held is None or held[0] + held[1] / 1000 <= now:
                character.buff_on[source] = now
            character.buffs[source] = (now, milliseconds)
            character.buff_masks[source] = proto.buff_mask(data)
            if source < 0:
                self.prices.want([-source])
            self.dirty = True

    def ground_drop(self, character, data, now):
        """Remember a valuable item that just fell for this character or its party
        (a party member's kill included): equipment, scrolls, throwing stars and
        bullets always, anything else worth at least the notable value."""
        drop = proto.drop(data)
        if not drop or not drop['fresh'] or drop['mesos'] or drop['thrown']:
            return
        owner = drop['owner']
        if owner not in (character.character_id, character.party_id) or owner is None:
            return
        item = drop['item']
        self.prices.want([item])
        death = character.deaths_seen.get(drop['source'])
        if death and not 0 <= now - death[0] <= 10:
            death = None
        if death and death[2]:
            run_id, index = death[2]
            if character.run and character.run.id == run_id and index < len(character.run.segments):
                character.run.segments[index].seen_drops[item] += 1
        kind = item // 10000
        unit, _ = self.prices.loot(item)
        valuable = item // 1_000_000 == 1 or kind == 204 or kind in (207, 233)             or (unit or 0) >= self.settings['notable_value']
        if not valuable or any(d['object'] == drop['object'] for d in character.drops):
            return
        killer = death[1] if death else None
        by = 'me' if killer is not None and killer == character.character_id else 'party' if killer is not None else None
        member = (character.party or {}).get(killer) if by == 'party' else None
        found = dict(t=round(now, 2), object=drop['object'], item_id=item, map_id=character.map_id,
                     name=self.name(item), value=unit, by=by, by_name=member['name'] if member else None)
        character.drops.append(found)
        run = character.run
        if run and run.status == 'active' and len(run.finds) < 100:
            run.finds.append(dict(t=found['t'], item_id=item, by=by, by_name=found['by_name']))
        self.dirty = True

    def ground_leave(self, character, data, now):
        """A valuable drop left the ground: who picked it up (or their pet), or nobody
        did and it expired. The overlay lists it until a moment after."""
        left = proto.leave(data)
        if not left:
            return
        for drop in character.drops:
            if drop['object'] == left['object'] and not drop.get('gone'):
                taker = left['taker']
                member = (character.party or {}).get(taker) if taker is not None else None
                drop.update(gone=round(now, 2), how=left['how'], taker='me' if taker == character.character_id
                            else 'party' if member else None if taker is None else 'other',
                            taker_name=character.name if taker == character.character_id else member['name'] if member else None)
                self.dirty = True
                return

    def party_update(self, character, data):
        kind = data[2] if len(data) > 2 else None
        # The party's ID names its drops (proto.drop owner): PartyInfo has it at 4,
        # a join after the joiner's name; leaving the party clears it.
        if kind == 0x0D and len(data) > 8 and data[3] == 1:
            character.party_id = proto.u32(data, 4)
        elif kind == 0x13 and len(data) > 9:
            size = int.from_bytes(data[3:5], 'little')
            if 0 < size <= 13 and len(data) >= 9 + size:
                character.party_id = proto.u32(data, 5 + size)
        elif kind == 0x10 and proto.u32(data, 3) == character.character_id:
            character.party_id = None
        if kind in (0x0D, 0x10, 0x13):
            character.party = combat.party(data, character.character_id)
        elif kind == 0x2A and len(data) == 16 and data[3] == 1:
            actor, field = proto.u32(data, 4), proto.u32(data, 8)
            if field == 3 and actor in (character.party or {}):
                character.party[actor]['channel'] = int.from_bytes(data[12:16], 'little', signed=True)
            else:
                character.party = None
        elif kind not in (0x03, 0x22):  # invitation / leader change do not change the roster
            character.party = None
        if character.run and character.party:
            for actor, member in character.party.items():
                character.run.combat.player(actor, member['name'], actor == character.character_id)
        self.dirty = True

    def combat_attack(self, character, actor, damage, now, own=False):
        if actor is None:
            return
        if damage is None:
            character.mob_attacks.clear()
        else:
            dealt = collections.Counter()
            for oid, hits in damage['targets']:
                dealt[oid] += sum(hits) if isinstance(hits, (list, tuple)) else (hits or 0)
            for oid, total in dealt.items():
                sample = character.mob_attacks.get(oid)
                if sample:
                    if own and character.run and character.run.status == 'active':
                        # Hits to kill: every own attack message that did damage to it is one
                        # hit, whatever the skill (Final Attack and the explosion included)
                        # and however many damage lines it carries (Final Attack shows three).
                        # Misses (0) widened the spread to 7-10 on mobs most kills took 3-4.
                        sample['attacks'] += total > 0
                    else:
                        sample['mixed'] = True
        member = (character.party or {}).get(actor)
        if not own and member is None:
            return
        me = (character.party or {}).get(character.character_id)
        if not own and me and member['channel'] != me['channel']:
            return
        name = character.name if own else member['name']
        self.combat_event(character, dict(t=now, actor=actor, name=name, own=own,
                                         targets=damage['targets'] if damage is not None else None), now)

    def combat_event(self, character, event, now):
        run = character.run
        if run and run.status == 'active':
            self.apply_combat(run, event)
            self.dirty = True
        elif not (run and run.pause_reason == 'manual'):
            window = self.settings['start_window']
            character.staged_combat = [e for e in character.staged_combat if now - e['t'] <= window][-1999:] + [event]

    @staticmethod
    def apply_combat(run, event):
        actor, name, own = event['actor'], event['name'], event['own']
        if event.get('kill'):
            run.combat.kill(actor, name, own, event.get('mob'), event['t'])
        elif event['targets'] is None:
            run.combat.player(actor, name, own)['partial'] = True
        else:
            run.combat.damage(actor, name, own, event['targets'], event['t'], run.active_seconds(event['t']))

    def inventory(self, character, inventory, now, rebase=False):
        bags, pieces = bag_view(inventory)
        self.bridge_blind(character, bags, inventory.mesos, now, rebase or character.bags is None)
        previous_slots = character.bag_slots
        character.bag_slots = None if inventory.slots is None else dict(inventory.slots)
        if character.mesos is None and inventory.mesos is not None:
            character.mesos = inventory.mesos
        if rebase:
            self.clear_item_matches(character)
            # A full snapshot replaces the bags; differences across it are
            # changes we did not see, never pickups.
            if inventory.mesos is not None:
                character.mesos = inventory.mesos
            character.bags, character.pieces = bags, pieces
            return
        if bags is None or character.bags is None:
            if (bags is None) != (character.bags is None):
                self.clear_item_matches(character)
            if character.bags is not None and bags is None and character.run:
                character.run.gaps += 1
            character.bags = bags
        else:
            for item in set(bags) | set(character.bags):
                delta = bags.get(item, 0) - character.bags.get(item, 0)
                if delta > 0:
                    self.loot(character, item, delta, None, now)
                elif delta < 0 and item // 1000000 == 2:
                    losses = {}
                    for (category, slot), (held, count) in (previous_slots or {}).items():
                        if category == 2 and held == item:
                            current = character.bag_slots.get((category, slot))
                            lost = count - (current[1] if current and current[0] == item else 0)
                            if lost > 0:
                                losses[slot] = lost
                    self.used(character, item, -delta, now, losses)
            character.bags = bags
        if pieces is None or character.pieces is None:
            character.pieces = pieces
        else:
            counts, examples = pieces
            for key, count in counts.items():
                extra = count - character.pieces[0].get(key, 0)
                for _ in range(max(0, extra)):
                    self.loot(character, key[0], 1, examples[key], now)
            character.pieces = pieces

    def bridge_blind(self, character, bags, mesos, now, blind):
        """Bags known again after a stretch we could not follow: what changed in between
        is the difference between the two (2026-11-15: a restart that could not take over
        the connection left 4.6 min unseen). Less is used, more is picked up; both marked
        estimated. Only on the same map: leaving it (a town trip) or a manual pause
        forgets the old contents; an idle or disconnect pause (no data at all) does not."""
        run = character.run
        if run is None:
            return
        if run.status != 'active' and run.pause_reason in ('map', 'manual'):
            run.bags_seen = None   # left the map, or paused by the player: purchases are not loot
            return
        seen = run.bags_seen
        if bags is None:
            # Mesos still read while the bags are not are already counted live (stat frames).
            if seen and mesos is not None:
                seen[3] = mesos
            return
        # Last known through another connection (a reconnect, or a new process): what
        # happened between the two was not seen either.
        blind = blind or (seen is not None and seen[4] != character.session)
        if not blind and seen and seen[2] == bags and seen[3] == mesos:
            seen[0], seen[1] = now, character.map_id
            return
        if (blind and seen and now - seen[0] <= BLIND_LIMIT
                and (seen[1] is None or character.map_id is None or seen[1] == character.map_id)):
            before = seen[2]
            for item in set(before) | set(bags):
                delta = bags.get(item, 0) - before.get(item, 0)
                if delta < 0 and item // 1000000 == 2 and item // 10000 not in (207, 233):
                    self.prices.want([item])
                    self.record_blind(run, dict(t=now, kind='used', item_id=item, quantity=-delta, estimated=True))
                elif delta > 0:
                    self.prices.want([item])
                    self.record_blind(run, dict(t=now, kind='loot', item_id=item, quantity=delta, estimated=True))
            if seen[3] is not None and mesos is not None and mesos != seen[3]:
                if mesos > seen[3]:
                    self.record_blind(run, dict(t=now, kind='mesos', mesos=mesos - seen[3], estimated=True))
                elif self.settings['count_mesos_spent']:
                    self.record_blind(run, dict(t=now, kind='spent', mesos=seen[3] - mesos, estimated=True))
        run.bags_seen = [now, character.map_id, dict(bags), mesos if mesos is not None else (seen[3] if seen else None), character.session]

    def record_blind(self, run, entry):
        """A bridged change belongs to this run even if it is paused right now (an idle
        pause while nothing could be read): record it directly."""
        entry['seg'] = len(run.segments) - 1
        run.ledger.append(entry)
        self.apply(run, entry)
        self.dirty = True

    # ----- ledger --------------------------------------------------------
    def record(self, character, entry, now):
        run = character.run
        if run and run.status == 'active':
            entry['seg'] = len(run.segments) - 1
            run.ledger.append(entry)
            self.apply(run, entry)
            self.dirty = True
        elif character.arming:
            character.staged.append(entry)

    def apply(self, run, entry):
        segment = run.segment
        if segment is None:
            return
        if entry['kind'] == 'loot':
            segment.drops[entry['item_id']] += entry['quantity']
        elif entry['kind'] == 'mesos':
            segment.mesos += entry['mesos']

    def money(self, character, delta, now):
        if delta > 0:
            self.record(character, dict(t=now, kind='mesos', mesos=delta), now)
        elif self.settings['count_mesos_spent']:
            self.record(character, dict(t=now, kind='spent', mesos=-delta), now)

    def loot(self, character, item, quantity, piece, now):
        rule = self.profile.get('pickup') or {}
        if rule.get('confirmed'):
            character.pending_loot.append(dict(t=now, item=item, quantity=quantity, piece=piece,
                                               eligible=self.item_eligible(character)))
            self.match_loot(character, now)
            return
        self.record_loot(character, item, quantity, piece, now)

    @staticmethod
    def clear_item_matches(character):
        character.pickups.clear()
        character.pending_loot.clear()
        character.uses.clear()
        character.pending_uses.clear()

    @staticmethod
    def item_eligible(character):
        return bool((character.run and character.run.status == 'active') or character.arming)

    @staticmethod
    def take_matches(events, item, quantity, now):
        while events and now - events[0][0] > ITEM_MATCH_SECONDS:
            events.popleft()
        matched = 0
        for event in events:
            if event[1] == item and 0 <= now - event[0] <= ITEM_MATCH_SECONDS:
                take = min(quantity - matched, event[2])
                event[2] -= take
                matched += take
                if matched == quantity:
                    break
        return matched

    def match_loot(self, character, now):
        pending = character.pending_loot
        while pending and now - pending[0]['t'] > ITEM_MATCH_SECONDS:
            pending.popleft()
        for entry in pending:
            quantity = self.take_matches(character.pickups, entry['item'], entry['quantity'], now)
            if quantity:
                if entry['eligible']:
                    self.record_loot(character, entry['item'], quantity, entry['piece'], entry['t'])
                entry['quantity'] -= quantity
        character.pending_loot = collections.deque((e for e in pending if e['quantity']), maxlen=256)

    def record_loot(self, character, item, quantity, piece, now):
        entry = dict(t=now, kind='loot', item_id=item, quantity=quantity)
        if piece is not None:
            entry['piece'] = dict(stats=piece.get('stats') or [], remaining_upgrades=piece.get('remaining_upgrades'),
                                  unknown_fields=piece.get('unknown_fields') or 0, enhancements=piece.get('enhancements'))
            # The ground drop it came from (party drops list) is priced by these stats too.
            run = character.run
            for find in reversed(run.finds if run else []):
                if find['item_id'] == item and 'piece' not in find and 0 <= now - find['t'] <= 180:
                    find['piece'] = entry['piece']
                    break
        self.prices.want([item])
        self.record(character, entry, now)

    def used(self, character, item, quantity, now, slots=None):
        # With a decoded client stream, manual and pet requests distinguish
        # actual potion use from dropping, selling or transferring a stack.
        # Capture without a mapping table or client frames retains the bag-delta
        # estimate until the next channel entry establishes both directions.
        rule = (self.profile.get('client') or {}).get('consume') or {}
        if (item // 10000 in (200, 201, 202) and character.table is not None
                and character.client_seen and (character.client_at is None or now - character.client_at <= 10)
                and rule.get('confirmed')):
            character.pending_uses.append(dict(t=now, item=item, quantity=quantity, slots=slots or {},
                                               eligible=self.item_eligible(character)))
            self.match_uses(character, now)
            return
        self.record_used(character, item, quantity, now)

    def match_uses(self, character, now):
        # The two TCP directions can be delivered to the capture worker in
        # either order, even though the request logically precedes the reply.
        while character.uses and now - character.uses[0][0] > ITEM_MATCH_SECONDS:
            character.uses.popleft()
        pending = character.pending_uses
        while pending and now - pending[0]['t'] > ITEM_MATCH_SECONDS:
            pending.popleft()
        for entry in pending:
            for event in character.uses:
                if event[1] != entry['item'] or not 0 <= now - event[0] <= ITEM_MATCH_SECONDS:
                    continue
                quantity = min(entry['quantity'], event[2], entry['slots'].get(event[3], 0))
                if quantity:
                    entry['quantity'] -= quantity
                    entry['slots'][event[3]] -= quantity
                    event[2] -= quantity
                    if entry['eligible']:
                        self.record_used(character, entry['item'], quantity, entry['t'])
        character.pending_uses = collections.deque((e for e in pending if e['quantity']), maxlen=256)

    def record_used(self, character, item, quantity, now):
        if not quantity or item // 10000 in (207, 233):
            return
        self.prices.want([item])
        self.record(character, dict(t=now, kind='used', item_id=item, quantity=quantity), now)

    # ----- run state machine --------------------------------------------
    def gain(self, character, now, exp=0):
        run = character.run
        if run and run.status == 'active':
            run.credit(now, character.buffs)
            run.last_gain = now
            if run.segment:
                run.segment.exp += exp
                if self.kills_estimated(run, character):
                    run.segment.kills += 1
            run.add_exp((now, exp))
            self.dirty = True
            return
        if run and run.status == 'paused' and run.pause_reason == 'manual':
            return  # paused by the player: only "resume" continues
        if (self.prices.map(character.map_id) or {}).get('is_town'):
            return  # quest rewards and NPC exchanges in towns never start a run
        window = self.settings['start_window']
        character.arming = [(t, m) for t, m in character.arming if now - t <= window and m == character.map_id]
        character.arming.append((now, character.map_id))
        character.staged = [e for e in character.staged if now - e['t'] <= window]
        if len(character.arming) < self.settings['start_events']:
            character.staged_exp = [(t, x) for t, x in character.staged_exp if now - t <= window] + [(now, exp)]
            return
        first = character.arming[0][0]
        if run is None or run.status == 'ended':
            run = character.run = Run(character.facts(), first)
        else:
            self.resume(run, first)
        if not run.segment or run.segment.map_id != character.map_id:
            run.segments.append(Segment(character.map_id, character.level, character.job, first))
        run.status = 'active'
        run.credited_until = first
        run.last_gain = now
        earlier = [(t, x) for t, x in character.staged_exp if t >= first] + [(now, exp)]
        for t, x in earlier:
            run.segment.exp += x
            if self.kills_by_exp(character):
                run.segment.kills += 1
            run.add_exp((t, x))
        for entry in character.staged:
            if entry['t'] >= first - 2:
                entry['seg'] = len(run.segments) - 1
                run.ledger.append(entry)
                self.apply(run, entry)
        for t, mob in character.staged_kills:
            if t >= first - 2:
                run.combat.kill(character.character_id, character.name, True, mob, t)
                run.segment.kills += 1
                if mob:
                    run.segment.mobs[mob] += 1
        for event in character.staged_combat:
            if event['t'] >= first - 2:
                self.apply_combat(run, event)
        run.credit(now, character.buffs)
        character.arming.clear()
        character.staged.clear()
        character.staged_exp = []
        character.staged_kills = []
        character.staged_combat = []
        self.dirty = True

    def pause(self, run, reason, now):
        if run.status != 'active':
            return
        buffs = None
        for character in self.characters.values():
            if character.run is run:
                character.mob_attacks.clear()
                buffs = character.buffs
        end = min(now, run.last_gain + IDLE_CREDIT) if reason == 'idle' else now
        run.credit(end, buffs)
        run.status = 'paused'
        run.pause_reason = reason
        run.paused_at = end
        self.dirty = True

    def resume(self, run, now):
        if run.status == 'paused' and run.paused_at is not None:
            run.idle_seconds += max(0.0, now - run.paused_at)
            if now > run.paused_at:
                run.pauses.append([run.paused_at, now])
        run.pause_reason = None
        run.paused_at = None

    def command(self, now):
        """Pause / resume / end from the collector window or its hotkeys."""
        path = self.data / 'command.json'
        try:
            stamp = path.stat().st_mtime
        except OSError:
            return
        if stamp == self.command_mtime:
            return
        self.command_mtime = stamp
        try:
            order = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return
        if order.get('id') == self.command_id or not 0 <= now - order.get('at', 0) <= 30:
            self.command_id = order.get('id')
            return
        self.command_id = order.get('id')
        action = order.get('action')
        if self.frames is not None and action in ('pause', 'resume', 'toggle', 'end'):
            self.frames.control(action, now)
        for character in self.characters.values():
            run = character.run
            if not run:
                continue
            self.clear_item_matches(character)
            if action == 'pause' and run.status == 'active':
                self.pause(run, 'manual', now)
            elif action == 'resume' and run.status == 'paused':
                self.resume(run, now)
                run.status = 'active'
                run.last_gain = run.credited_until = now
            elif action == 'toggle':
                if run.status == 'active':
                    self.pause(run, 'manual', now)
                elif run.status == 'paused':
                    self.resume(run, now)
                    run.status = 'active'
                    run.last_gain = run.credited_until = now
            elif action == 'end':
                self.end(character, now)
        self.dirty = True

    def suspect(self):
        """The built-in layouts stopped matching (a game update): record again."""
        h = self.health
        return (h['exp_messages'] >= 30 and h['exp_updates'] < h['exp_messages'] * 0.5) or \
            ((self.profile.get('kill') or {}).get('confirmed') and h['exp_messages'] >= 30
             and h['kills'] == 0 and h['attributed_kills'] == 0)

    def tick(self):
        now = self.now()
        self.reload()
        self.command(now)
        for character in self.characters.values():
            run = character.run
            if not run:
                continue
            if run.status == 'active' and now - run.last_gain > self.settings['idle_seconds']:
                self.clear_item_matches(character)
                self.pause(run, 'idle', now)
            if run.status == 'paused' and now - run.paused_at > self.settings['end_after_seconds']:
                self.end(character, now)
        # Auto buff and auto potions are switched off (2026-11-12): no key is ever
        # pressed. grind_autobuff still reads the key table for the prompts.
        for run in list(self.restored):
            if run.paused_at is None or now - run.paused_at > self.settings['end_after_seconds']:
                self.finish(run, now)
                self.restored.remove(run)
        if self.frames is not None:
            self.frames.flush()
            try:
                from grind_reconcile import apply_pending
                apply_pending(self)
            except (OSError, ValueError, KeyError, sqlite3.Error):
                pass  # Keep the live counters and proposal for a later retry.
        if now - self.last_persist >= 10 and self.dirty:
            self.persist()
        if now - self.last_publish >= 1 and (self.dirty or now - self.last_publish >= 5):
            self.publish(now)

    def connection(self, session, connection):
        """The captured TCP connection of a session: finds its game window for auto buffs."""
        self.connections[session] = tuple(connection)

    def disconnect(self, session):
        """The connection closed or failed; its run waits for the same character."""
        character = self.characters.pop(session, None)
        self.connections.pop(session, None)
        if character and character.key:
            self.__dict__.setdefault('carried', {})[character.key] = self.buff_state(character)
        if character and character.run:
            self.pause(character.run, 'disconnect', self.now())
            self.restored.append(character.run)
            self.dirty = True

    def end(self, character, now):
        self.clear_item_matches(character)
        run = character.run
        character.run = None
        self.kills_estimated(run, character)
        self.finish(run, now)

    def end_all(self, now):
        """The collector is closing for good (not restarting for an update): end every open
        run, so it is saved and uploaded now. Kept open, it stayed in current.json until the
        next launch and never reached the site if the player did not come back (2026-11-16)."""
        for character in self.characters.values():
            if character.run:
                self.end(character, now)
        for run in list(self.restored):
            self.finish(run, run.paused_at or now)
            self.restored.remove(run)
        self.persist()

    def finish(self, run, now):
        if run.status == 'active':
            self.pause(run, 'end', now)
        run.status = 'ended'
        summary = self.summarize(run, now)
        self.finished.insert(0, summary)
        del self.finished[20:]
        self.save_history(summary)
        # Parsed results always go to the site (the recorded frames never do).
        if summary['active_seconds'] >= self.settings['min_upload_seconds']:
            self.queue_upload(run, summary)
        self.dirty = True

    # ----- valuation and summaries --------------------------------------
    def value(self, run):
        # Items already in the ledger are asked again once their price is stale.
        self.prices.want({e['item_id'] for e in run.ledger if e['kind'] in ('loot', 'used')})
        basis = self.settings['price_basis']
        loot = cost = 0
        pending = 0
        spent = cash = 0
        rows = []
        for entry in run.ledger:
            kind = entry['kind']
            if kind == 'mesos':
                cash += entry['mesos']
                continue
            if kind == 'spent':
                spent += entry['mesos']
                continue
            if kind == 'loot':
                unit, label = self.prices.loot(entry['item_id'], entry.get('piece'), basis)
            else:
                unit, label = self.prices.consumable(entry['item_id'])
            if unit is None:
                pending += 1
                unit = 0
            amount = unit * entry['quantity']
            if kind == 'loot':
                loot += amount
            else:
                cost += amount
            rows.append((entry, unit, label, amount))
        return dict(cash=cash, loot=loot, cost=cost, spent=spent, pending=pending,
                    net=cash + loot - cost - spent), rows

    def summarize(self, run, now, character=None):
        active = run.active_seconds(now)
        hours = active / 3600 if active > 0 else None
        exp = sum(s.exp for s in run.segments) - run.exp_lost
        kills = sum(s.kills for s in run.segments)
        money, rows = self.value(run)
        facts = character.facts() if character else run.character
        level = facts.get('level')
        need = exp_to_next(level)
        current = character.exp if character else None

        def rate(window):
            if run.status != 'active' or not run.exp_events:
                return None
            start = now - window
            span = min(window, active)
            if span < min(window, 60) * 0.5:
                return None
            return sum(x for t, x in run.exp_events if t >= start) * 3600 / span
        avg = exp * 3600 / active if active >= 30 else None
        recent = rate(300)
        drops = collections.Counter()
        mobs = collections.Counter()
        for s in run.segments:
            drops.update(s.drops)
            mobs.update(s.mobs)
        used = collections.Counter()
        for entry in run.ledger:
            if entry['kind'] == 'used':
                used[entry['item_id']] += entry['quantity']
        bags = character.bags if character else None
        consumables = []
        for item in sorted(set(used) | {i for i in drops if i // 1000000 == 2}, key=lambda i: (-used[i], i)):
            count = used[item]
            remaining = bags.get(item, 0) if bags is not None else None
            per_hour = count / hours if hours else None
            item_cost = sum(amount for entry, _, _, amount in rows if entry['kind'] == 'used' and entry['item_id'] == item)
            consumables.append(dict(item_id=item, name=self.name(item), used=count, cost=item_cost, acquired=drops[item], remaining=remaining,
                                    per_hour=per_hour, minutes_left=(remaining / per_hour * 60) if remaining is not None and per_hour else None))
        consumables.sort(key=lambda row: (-(row['cost'] or 0), -row['used'], row['item_id']))
        notable = self.settings['notable_value']
        if character and character.character_id is not None:
            run.combat.player(character.character_id, character.name, True)
            for actor, member in (character.party or {}).items():
                run.combat.player(actor, member['name'], actor == character.character_id)
        combat_rows = run.combat.rows(now, active, run.started_at, run.status == 'active',
                                     character.character_id if character else None, kills,
                                     character.party if character else None)
        from grind_mob_exp import MOB_EXP
        for row in combat_rows:
            recent_kills = [(t, m) for t, m in run.combat.players[row['character_id']].get('kill_events', []) if now-t <= 300]
            row['kill_exp_5m'] = sum(MOB_EXP[m] for _, m in recent_kills) if all(m in MOB_EXP for _, m in recent_kills) else None
            row['exp_received_5m'] = sum(max(0, x) for t, x in run.exp_events if now-t <= 300) if row['self'] else None
            counts = dict(run.combat.players[row['character_id']].get('mobs', {}))
            if row['self']:
                counts = collections.Counter()
                for segment in run.segments:
                    counts.update(segment.mobs)
            complete = sum(counts.values()) == row['kills'] and all(int(m) in MOB_EXP for m in counts)
            row['kill_exp'] = sum(MOB_EXP.get(int(m), 0) * n for m, n in counts.items()) if complete else None
            row['exp_received'] = sum(s.exp for s in run.segments) if row['self'] else None
            row['exp_yield'] = row['exp_received'] / row['kill_exp'] * 100 if row['exp_received'] is not None and row['kill_exp'] else None
        team_exp = sum(r['kill_exp'] or 0 for r in combat_rows)
        complete_team = all(r['kill_exp'] is not None for r in combat_rows)
        for row in combat_rows:
            row['exp_contribution'] = row['kill_exp'] / team_exp * 100 if complete_team and team_exp else None
        recent_team_exp = sum(r['kill_exp_5m'] or 0 for r in combat_rows)
        for row in combat_rows:
            row['exp_contribution_5m'] = row['kill_exp_5m'] / recent_team_exp * 100 if recent_team_exp and all(r['kill_exp_5m'] is not None for r in combat_rows) else None
            row['exp_yield_5m'] = row['exp_received_5m'] / row['kill_exp_5m'] * 100 if row['kill_exp_5m'] and row['exp_received_5m'] is not None else None
        own_combat = next((r for r in combat_rows if r['self']), {})
        if character and own_combat and (not character.client_seen or
                (character.client_at is not None and now - character.client_at > 60)):
            # Missing outgoing capture is unknown damage, not an idle zero.
            own_combat.update(dps=None, dps_5m=None, average_dps=None, partial=True)
        loot_events = [dict(t=e['t'], kind=e['kind'], item_id=e.get('item_id'), name=self.name(e.get('item_id')),
                            quantity=e.get('quantity'), unit=unit, basis=label, value=amount,
                            priced=label not in (None, '无价格'),
                            stats=(e.get('piece') or {}).get('stats'),
                            # With the stats, prices the row again when history is repriced.
                            remaining_upgrades=(e.get('piece') or {}).get('remaining_upgrades'), notable=e['kind'] == 'loot' and amount >= notable,
                            # Picked up and worth showing with its price on the overlay.
                            alert=e['kind'] == 'loot' and (amount >= notable or (e.get('item_id') or 0) // 1_000_000 == 1
                                                           or (e.get('item_id') or 0) // 10000 in (204, 207, 233)))
                       for e, unit, label, amount in rows if e['kind'] == 'loot']
        recent_rows = loot_events[-RECENT:][::-1]
        loot_rows, stack_rows = [], {}
        for event in loot_events:
            item = event['item_id']
            # Equipment retains individual attributes; stackables combine across
            # slots, pickups and map segments for the entire run.
            if item // 1000000 != 1 and item in stack_rows:
                row = stack_rows[item]
                row['quantity'] += event['quantity']
                row['value'] += event['value']
                row['t'] = max(row['t'], event['t'])
                row['notable'] = row['notable'] or event['notable']
            else:
                row = dict(event)
                loot_rows.append(row)
                if item // 1000000 != 1:
                    stack_rows[item] = row
        # Biggest amount first everywhere (overlay, live page, history); newest breaks ties.
        loot_rows.sort(key=lambda row: (-(row['value'] or 0), -row['t']))
        cash_events = [(e['t'], e['mesos'] * (1 if e['kind'] == 'mesos' else -1))
                       for e in run.ledger if e['kind'] in ('mesos', 'spent')]
        cash_events += [(e['t'], amount * (1 if e['kind'] == 'loot' else -1)) for e, _, _, amount in rows]
        chart_end = now if run.status == 'active' else (run.paused_at or run.credited_until)
        clock = ActiveClock(run.started_at, run.pauses)
        exp_index = Cumulative([(clock.active(t), v) for t, v in run.exp_events])
        cash_index = Cumulative([(clock.active(t), v) for t, v in cash_events])
        rate_history = []
        length = clock.active(chart_end)
        for offset in [length - n * 10 for n in range(30, -1, -1)]:
            span = min(60, offset)
            if span < 30:
                continue
            def window(index):
                return index.window(offset, 60) * 3600 / span
            # t is on the pause-free axis (the chart's x); clock is the wall time.
            rate_history.append(dict(t=run.started_at + offset, clock=clock.wall(offset),
                                     exp=window(exp_index), net=window(cash_index)))
        net_1m = rate_history[-1]['net'] if rate_history and run.status == 'active' else None
        return dict(
            id=run.id, status=run.status, pause_reason=run.pause_reason, character=facts,
            job_name=job_name(facts.get('job')), level=level, level_start=run.level_start,
            exp_now=current, exp_percent=(current / need * 100) if need and current is not None else None,
            map_id=run.segment.map_id if run.segment else None,
            map_name=(self.prices.map(run.segment.map_id) or {}).get('name') if run.segment else None, started_at=run.started_at, ended_at=now if run.status == 'ended' else None,
            active_seconds=round(active), idle_seconds=round(run.idle_seconds + (now - run.paused_at if run.status == 'paused' and run.paused_at else 0)),
            exp=exp, exp_per_hour=avg, exp_per_hour_5m=recent,
            exp_per_hour_1m=rate_history[-1]['exp'] if rate_history and run.status == 'active' else None,
            percent_per_hour=(avg / need * 100) if avg and need else None,
            eta_seconds=((need - current) / (recent or avg) * 3600) if need and current is not None and (recent or avg) else None,
            kills=kills, kills_per_hour=kills / hours if hours else None, kills_estimated=self.kills_estimated(run, character),
            deaths=run.deaths, exp_lost=run.exp_lost, exp_bridged=run.exp_bridged, gaps=run.gaps,
            mesos=money['cash'], item_value=money['loot'], consume_cost=money['cost'], mesos_spent=money['spent'],
            basic_value=sum(amount for e, _, _, amount in rows if e['kind'] == 'loot' and basic_drop(e.get('item_id'))),
            net=money['net'], net_per_hour=money['net'] / hours if hours else None,
            net_per_hour_1m=net_1m, rate_history=rate_history, timeline=self.timeline(run, rows, now),
            cash_per_hour=money['cash'] / hours if hours else None, pending_prices=money['pending'],
            recent=recent_rows, loot=loot_rows, consumables=consumables, finds=self.finds(run),
            drops=[dict(item_id=i, name=self.name(i), quantity=q) for i, q in drops.most_common()],
            mobs=[dict(mob_id=m, kills=k, name=(self.prices.mob(m) or {}).get('name') or f'#{m}',
                       attack_samples=sum(run.kill_attacks.get(str(m), {}).values()),
                       attack_distribution=[dict(attacks=int(a), kills=n) for a, n in sorted(run.kill_attacks.get(str(m), {}).items(), key=lambda p: int(p[0]))]) for m, k in mobs.most_common()],
            hp_lost=run.hp_lost, hp_drops=run.hp_drops,
            attack_count=sum(v for k, v in run.attacks.items() if k not in FOLLOW_UPS),
            damage=own_combat.get('damage'), dps=own_combat.get('dps'),
            average_dps=own_combat.get('average_dps'), combat=combat_rows,
            party_known=character.party is not None if character else None,
            attacks=[dict(skill=k, name=skill_name(k) if k else '普通攻击', count=v, follow_up=k in FOLLOW_UPS) for k, v in run.attacks.most_common() if v],
            casts=[dict(skill=k, name=skill_name(k), count=v) for k, v in run.casts.most_common() if v],
            buffs=self.buffs(character, now),
            pets=grind_pets.view(character.pets, now) if character and run.status != 'ended' else [],
            in_combat=self.in_combat(character, now),
            channel_change=self.channel_change(run, character, now),
            vitals=self.vitals(character, now),
            segments=[s.to_json() for s in run.segments])

    def timeline(self, run, rows, now, points=48):
        """Chart data for the whole run: a point every 10 seconds (wider for long
        runs, at most CHART_POINTS), each the experience and net of the minute
        before it, so the line shows the rate of the last minute like the live
        figure. Runs saved before 10-second slots existed use per-minute buckets."""
        start = run.started_at
        end = now if run.status == 'active' else max(run.credited_until, start + 60)
        if not run.exp_slots and run.exp_minutes:
            return self.minute_timeline(run, rows, start, end, points)
        clock = ActiveClock(start, run.pauses)
        length = clock.active(end)
        step = max(SLOT, math.ceil(length / CHART_POINTS / SLOT) * SLOT)
        first = min(length, CHART_WINDOW)
        offsets = []
        a = first
        while a < length:
            offsets.append(a)
            a += step
        offsets.append(length)
        window = min(CHART_WINDOW, max(SLOT, length))
        slots = sorted(run.exp_slots.items())
        money = []
        for entry in run.ledger:
            if entry['kind'] == 'mesos':
                money.append((entry['t'], entry['mesos']))
            elif entry['kind'] == 'spent':
                money.append((entry['t'], -entry['mesos']))
        money += [(entry['t'], amount if entry['kind'] == 'loot' else -amount) for entry, _, _, amount in rows]
        money.sort()
        # Prefix sums (Cumulative): each point is a few binary searches, not a pass over the run.
        # Points are spaced in run time without pauses; each is the active minute before it.
        def windowed(events):
            total = Cumulative([(clock.active(t), v) for t, v in events])
            return [round(total.window(a, window)) for a in offsets]
        exp = windowed([(slot * SLOT + SLOT / 2, v) for slot, v in slots])
        net = windowed(money)
        # 积分 (绩效模式) is drawn from mesos picked up and basic drops' value, weighted on the page.
        mesos = windowed([(e['t'], e['mesos']) for e in run.ledger if e['kind'] == 'mesos'])
        basic = windowed([(e['t'], amount) for e, _, _, amount in rows if e['kind'] == 'loot' and basic_drop(e.get('item_id'))])
        line = dict(start=start, first=start + first, step=step, window=window, exp=exp, net=net, bucket=step,
                    mesos=mesos, basic=basic)
        if clock.pauses:
            line['times'] = [round(clock.wall(a), 1) for a in offsets]   # wall clock, for labels
        return line

    def minute_timeline(self, run, rows, start, end, points):
        size = math.ceil(max(60.0, (end - start) / points) / 60) * 60
        count = max(1, min(points, int((end - start) // size) + 1))
        exp = [0.0] * count
        net = [0.0] * count
        slot = lambda t: min(count - 1, max(0, int((t - start) // size)))
        for minute, value in run.exp_minutes.items():
            exp[slot(minute * 60 + 30)] += value
        for entry in run.ledger:
            if entry['kind'] == 'mesos':
                net[slot(entry['t'])] += entry['mesos']
            elif entry['kind'] == 'spent':
                net[slot(entry['t'])] -= entry['mesos']
        for entry, _, _, amount in rows:
            net[slot(entry['t'])] += amount if entry['kind'] == 'loot' else -amount
        last = min(size, max(60.0, end - (start + (count - 1) * size)))
        return dict(start=start, bucket=round(size, 1), last=round(last, 1),
                    exp=[round(v) for v in exp], net=[round(v) for v in net])

    def kills_estimated(self, run, character):
        """Live runs ask the character; ended runs keep what was last seen."""
        if character is not None:
            run.kills_by_exp = self.kills_by_exp(character)
        return run.kills_by_exp if run.kills_by_exp is not None else True

    def kills_by_exp(self, character):
        """Kills come from experience gains until the death rule and this
        character's ID (from a full map entry) are both known."""
        return not (self.profile.get('kill') or {}).get('confirmed') or character is None             or getattr(character, 'character_id', None) is None

    def buffs(self, character, now):
        """Active buffs, soonest to expire first, plus pinned buffs that ran out
        (seconds 0) so the player sees what to recast."""
        if character is None:
            return []
        out, shown = [], set()
        pinned = self.pinned_buffs(character, now)
        for source, (start, milliseconds) in list(character.buffs.items()):
            left = milliseconds / 1000 - (now - start)
            if left < -2 * IDLE_CREDIT:   # kept a while so idle credit still counts it
                del character.buffs[source]
                character.buff_ended[source] = start + milliseconds / 1000
                continue
            if left <= 0:
                if source < 0 and left > -(ITEM_WAIT - autobuff.ITEM_LATE):
                    # Nominally over, but the server has not ended it yet: still on in the game.
                    # Without a cancel it leaves the list so the overlay says it at ITEM_WAIT.
                    shown.add(source)
                    out.append(dict(self.buff_row(source, 0, milliseconds / 1000, source in pinned), ending=True))
                continue
            shown.add(source)
            # `on`: when it last turned on, so a Final Attack cancelled and given again
            # between two state writes is still announced.
            out.append(dict(self.buff_row(source, round(left, 1), milliseconds / 1000, source in pinned),
                            on=character.buff_on.get(source)))
        out += [self.buff_row(source, 0, total, True) for source, total in pinned.items() if source not in shown]
        return sorted(out, key=lambda b: b['seconds'])

    def vitals(self, character, now):
        """HP and MP for the low-HP warning. Warned when HP is under 1.5 of this map's
        biggest single hit and under 40 % of max HP, or under one biggest hit whatever
        the share (2026-11-16, was two hits: a map hitting ~480 against 2000 HP warned
        after every potion). As one line: max(hit, min(1.5 hit, 40 %)); 40 % until a hit
        on this map is known."""
        if character is None or character.hp is None or not character.max_hp:
            return None
        worst, _ = self.combat_limits(character, now)
        share = 0.4 * character.max_hp
        danger = min(character.max_hp, max(worst, min(1.5 * worst, share))) if worst else share
        return dict(hp=character.hp, max_hp=character.max_hp, mp=character.mp, max_mp=character.max_mp,
                    danger=round(danger))

    def channel_change(self, run, character, now):
        """Why a channel change would help, as codes the pages turn into a clear
        prompt: only a new connection brings the key table, the character ID and
        an undamaged stream back.
        - capture: the game connection was lost (the run waits as disconnected);
        - keys: no key table, so auto buff and auto potions are off;
        - identity: no character ID yet, kills are estimated from experience;
        - attacks: none of the player's own messages, so no DPS or skills;
        - bags: the bags are unknown (no inventory snapshot yet, or an update we could
          not read), so loot and consumables are not counted until the snapshot a
          new connection sends (2026-11-15: a cape swap left a run blind for 47 min)."""
        if run.status == 'paused' and run.pause_reason == 'disconnect':
            return ['capture']
        if character is None or run.status != 'active':
            return []
        reasons = []
        if character.character_id is None:
            reasons.append('identity')
        if now - run.started_at > 60 and (not character.client_seen
                                          or (character.client_at is not None and now - character.client_at > 60)):
            reasons.append('attacks')
        if now - run.started_at > 30 and character.bags is None:
            reasons.append('bags')
        return reasons

    def in_combat(self, character, now):
        """Own attack, kill or hit taken in the last COMBAT_SECONDS: buffs are recast and
        announced then. The game's own combat state is not in its messages (2026-11-12:
        no server message starts or ends with combat), so it is approximated here."""
        if character is None:
            return False
        last = max(character.combat_at or 0, character.run.last_gain if character.run else 0)
        return now - last <= COMBAT_SECONDS

    def buff_row(self, source, seconds, total, pinned):
        name = skill_name(source) if source > 0 else self.name(-source)
        return dict(source=source, name=name, seconds=seconds, total=total,
                    item_id=-source if source < 0 else None, pinned=pinned, proc=source in PROCS)

    def pinned_buffs(self, character, now):
        """Buffs this character kept on for over half of its active time on
        this map in the last three days: source -> full duration in seconds."""
        key, map_id = character.key, character.map_id
        if key is None or map_id is None:
            return {}
        cache = self.__dict__.setdefault('pin_cache', {})
        hit = cache.get((key, map_id))
        if hit and abs(time.monotonic() - hit[0]) < 60:
            return hit[1]
        segments = []
        try:
            with contextlib.closing(sqlite3.connect(self.data / 'history.sqlite')) as db:
                for (text,) in db.execute('SELECT summary FROM runs WHERE ended_at >= ?', (now - PIN_DAYS * 86400,)):
                    summary = json.loads(text)
                    if (summary.get('character') or {}).get('key') == key:
                        segments += summary.get('segments') or []
        except (sqlite3.Error, ValueError):
            pass
        if character.run:
            segments += [s.to_json() for s in character.run.segments]
        active, on, totals = 0.0, collections.Counter(), {}
        for s in segments:
            if s.get('map_id') != map_id:
                continue
            active += s.get('active_seconds') or 0
            for source, seconds in (s.get('buffs') or {}).items():
                on[int(source)] += seconds
            totals.update({int(k): v for k, v in (s.get('buff_totals') or {}).items()})
        result = {} if active < PIN_MIN_SECONDS else \
            {source: totals.get(source) or 0 for source, seconds in on.items() if seconds > active * PIN_SHARE}
        cache[(key, map_id)] = (time.monotonic(), result)
        return result

    def combat_limits(self, character, now):
        """(biggest single hit on this map, dearest MP drop) over the last three
        days and the open run, for the auto potion rules; 0 while unknown."""
        key, map_id = character.key, character.map_id
        cache = self.__dict__.setdefault('limit_cache', {})
        hit = cache.get((key, map_id))
        if not hit or abs(time.monotonic() - hit[0]) >= 60:
            worst = cost = 0
            if key is not None:
                try:
                    with contextlib.closing(sqlite3.connect(self.data / 'history.sqlite')) as db:
                        for (text,) in db.execute('SELECT summary FROM runs WHERE ended_at >= ?', (now - PIN_DAYS * 86400,)):
                            summary = json.loads(text)
                            if (summary.get('character') or {}).get('key') != key:
                                continue
                            for s in summary.get('segments') or []:
                                cost = max(cost, s.get('mp_cost') or 0)
                                if s.get('map_id') == map_id:
                                    worst = max(worst, s.get('max_hit') or 0)
                except (sqlite3.Error, ValueError):
                    pass
            hit = cache[(key, map_id)] = (time.monotonic(), worst, cost)
        worst, cost = hit[1], hit[2]
        for s in (character.run.segments if character.run else []):
            cost = max(cost, s.mp_cost)
            if s.map_id == map_id:
                worst = max(worst, s.max_hit)
        return worst, cost

    def finds(self, run):
        """The run's valuable drops (its party's included), dearest first, at today's prices."""
        rows = [dict({k: v for k, v in f.items() if k != 'piece'}, name=self.name(f['item_id']),
                     value=self.prices.loot(f['item_id'], f.get('piece'))[0]) for f in run.finds]
        return sorted(rows, key=lambda r: -(r['value'] or 0))

    @staticmethod
    def drop_shown(character, drop, now):
        """Listed on the overlay while on the ground in this map (drops expire after
        about 120 s) and 15 s after it left; the newest minute always (the alert)."""
        if drop.get('gone'):
            return now - drop['gone'] <= 15 or now - drop['t'] <= 60
        return now - drop['t'] <= 60 or (now - drop['t'] <= 130 and drop.get('map_id') == character.map_id)

    def drop_view(self, drop):
        """A ground drop as shown: the first drop of an item comes before its name and
        price arrive (prices.want is asynchronous), so look them up again each time."""
        unit, _ = self.prices.loot(drop['item_id'])
        return dict(drop, name=self.name(drop['item_id']), value=unit if unit is not None else drop['value'])

    def name(self, item_id):
        row = self.prices.row(item_id) if item_id else None
        return {4000156: '肋骨', 4000157: '骨盆'}.get(item_id) or (row or {}).get('name') or (f'#{item_id}' if item_id else None)

    # ----- persistence, state file and upload ---------------------------
    def publish(self, now):
        runs = []
        for character in self.characters.values():
            if character.run:
                runs.append(self.summarize(character.run, now, character))
        for run in self.restored:
            runs.append(self.summarize(run, now))
        # A recent anonymous stream must never hide the identified character.
        runs.sort(key=lambda r: (not bool(r['character'].get('key')), r['status'] != 'active', -(r['started_at'] or 0)))
        from grind_calibrate import summary as calibration_summary
        state = dict(alive_at=now, runs=runs, finished=self.finished[:5],
                     calibration=[dict(label=a, state=b) for a, b in calibration_summary(self.profile)],
                     recording=self.frames is not None and not self.frames.failed,
                     characters=[dict(c.facts(), map_id=c.map_id, buffs=self.buffs(c, now), pets=grind_pets.view(c.pets, now),
                                      drops=[self.drop_view(d) for d in c.drops if self.drop_shown(c, d, now)]) for c in self.characters.values()],
                     protocol_warning=bool(self.suspect()),
                     auto_buff=self.auto_buff.status() if self.auto_buff else None)
        write_json(self.folder / 'grind_state.json', state)
        self.last_publish = now
        self.dirty = False

    def persist(self):
        runs = [c.run.to_json() for c in self.characters.values() if c.run] + [r.to_json() for r in self.restored]
        write_json(self.data / 'current.json', dict(saved_at=self.now(), runs=runs))
        self.last_persist = self.now()

    def restore(self):
        """Open runs from before a collector restart (updates keep connections)."""
        self.restored = []
        try:
            saved = json.loads((self.data / 'current.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return
        now = self.now()
        for data in saved.get('runs') or []:
            try:
                run = Run.from_json(data)
            except (KeyError, TypeError, ValueError):
                continue
            if run.status == 'active':
                self.pause(run, 'disconnect', saved.get('saved_at', now))
            self.restored.append(run)

    def save_history(self, summary):
        try:
            self.data.mkdir(parents=True, exist_ok=True)
            with contextlib.closing(sqlite3.connect(self.data / 'history.sqlite')) as db, db:
                db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at REAL, ended_at REAL, summary TEXT)')
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reconciled_runs'").fetchone():
                    if db.execute('SELECT 1 FROM reconciled_runs WHERE fragment_id=?', (summary['id'],)).fetchone():
                        return  # An old restored fragment cannot reappear after reconciliation.
                db.execute('INSERT OR REPLACE INTO runs VALUES (?,?,?,?)',
                           (summary['id'], summary['started_at'], summary['ended_at'], json.dumps(summary, ensure_ascii=False)))
                db.execute('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT ?)', (HISTORY_LIMIT,))
        except sqlite3.Error:
            pass

    def queue_upload(self, run, summary):
        segments = []
        _, rows = self.value(run)
        for index, s in enumerate(run.segments):
            if s.active_seconds < 60 or s.map_id is None:
                continue
            item_value = sum(a for e, _, _, a in rows if e['kind'] == 'loot' and e.get('seg') == index)
            cost = sum(a for e, _, _, a in rows if e['kind'] == 'used' and e.get('seg') == index)
            segments.append(dict(map_id=s.map_id, job=s.job, level=s.level, active_seconds=round(s.active_seconds),
                                 exp=s.exp, kills=s.kills, kills_estimated=summary['kills_estimated'], mesos=s.mesos,
                                 item_value=round(item_value), consume_cost=round(cost),
                                 drops=[dict(item_id=i, quantity=q) for i, q in s.drops.most_common(200)],
                                 mobs=[dict(mob_id=m, kills=k) for m, k in s.mobs.most_common(50)]))
            if s.seen_kills is not None:
                segments[-1].update(seen_kills=s.seen_kills,
                                    seen_drops=[dict(item_id=i, quantity=q) for i, q in s.seen_drops.most_common(200)])
        if not segments:
            return
        payload = dict(event_id=run.id, started_at=run.started_at, ended_at=summary['ended_at'], segments=segments)
        write_json(self.folder / f'grind_{run.id}.json', payload)


def exp_between(level, exp, now_level, now_exp):
    """Experience from (level, exp) to (now_level, now_exp), over level-ups; None when unknown."""
    if None in (level, exp, now_level, now_exp) or now_level < level:
        return None
    if now_level == level:
        return now_exp - exp
    need = exp_to_next(level)
    if need is None:
        return None
    total = need - exp
    for between in range(level + 1, now_level):
        step = exp_to_next(between)
        if step is None:
            return None
        total += step
    return total + now_exp


def write_json(path, data):
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex[:8] + '.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        for attempt in range(4):
            try:
                temporary.replace(path)
                return True
            except PermissionError:
                if attempt == 3:
                    raise
                time.sleep(.01)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except (OSError, UnboundLocalError):
            pass
    return False
