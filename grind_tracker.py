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
import sqlite3
import time
import uuid
from pathlib import Path

import grind_protocol as proto
import grind_combat as combat
from grind_data import exp_to_next, job_name
from grind_skills import FOLLOW_UPS, SKILLS, skill_name

DEFAULTS = dict(enabled=True, record_frames=True, upload=True, idle_seconds=90, end_after_seconds=600,
                start_events=3, start_window=60, price_basis='typical', notable_value=500000,
                count_mesos_spent=True, min_upload_seconds=300, buff_warn_seconds=10, buff_sound=True,
                hotkeys=dict(overlay='Ctrl+Alt+O', pause='Ctrl+Alt+P', end='Ctrl+Alt+E'),
                overlay=dict(enabled=True, layout='slim', theme='dark', opacity=0.92, scale=1.0,
                             hide_in_capture=False, x=None, y=None,
                             fields=['time', 'exp_rate', 'profit', 'level', 'buffs', 'potions', 'recent']))
IDLE_CREDIT = 10
# Final Attack re-applies a 60 s marker on nearly every hit; it is not a buff to watch.
PASSIVE_BUFFS = {k for k, (_, en) in SKILLS.items() if en.startswith('Final Attack')}
RECENT = 8
HISTORY_LIMIT = 500
# A buff kept on over half the time on a map in the last three days stays on screen there.
PIN_DAYS, PIN_SHARE, PIN_MIN_SECONDS = 3, 0.5, 600
ITEM_MATCH_SECONDS = 2


def load_settings(path):
    settings = json.loads(json.dumps(DEFAULTS))
    try:
        saved = json.loads(Path(path).read_text(encoding='utf-8'))
        for key, value in saved.items():
            if key in ('overlay', 'hotkeys') and isinstance(value, dict):
                settings[key].update({k: v for k, v in value.items() if k in DEFAULTS[key]})
            elif key in DEFAULTS and type(value) is type(DEFAULTS[key]) or (key in DEFAULTS and isinstance(value, (int, float))
                                                                          and isinstance(DEFAULTS[key], (int, float))):
                settings[key] = value
    except (OSError, ValueError, AttributeError):
        pass
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

    def to_json(self):
        return dict(map_id=self.map_id, level=self.level, job=self.job, started_at=self.started_at,
                    active_seconds=round(self.active_seconds, 1), exp=self.exp, kills=self.kills, mesos=self.mesos,
                    drops={str(k): v for k, v in self.drops.items()}, mobs={str(k): v for k, v in self.mobs.items()},
                    buffs={str(k): round(v, 1) for k, v in self.buffs.items() if v >= 1},
                    buff_totals={str(k): v for k, v in self.buff_totals.items()})

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
        self.idle_seconds = 0.0
        self.last_gain = now
        self.credited_until = now
        self.segments = []
        self.ledger = []          # dicts: t, kind, item_id, quantity, mesos, piece
        self.exp_events = []      # (t, exp) for windowed rates
        self.exp_minutes = collections.Counter()   # unix minute -> exp, the whole run
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

    def add_exp(self, event):
        self.exp_events.append(event)
        self.exp_minutes[int(event[0] // 60)] += event[1]

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
                if source in PASSIVE_BUFFS:
                    continue
                overlap = min(until, start + milliseconds / 1000) - max(self.credited_until, start)
                if overlap > 0:
                    self.segment.buffs[source] += overlap
                    self.segment.buff_totals[source] = milliseconds / 1000
            self.segment.active_seconds += until - self.credited_until
            self.credited_until = until

    def to_json(self):
        return dict(id=self.id, character=self.character, started_at=self.started_at, status=self.status,
                    pause_reason=self.pause_reason, paused_at=self.paused_at, idle_seconds=self.idle_seconds,
                    last_gain=self.last_gain, credited_until=self.credited_until,
                    segments=[s.to_json() for s in self.segments], ledger=self.ledger,
                    exp_events=[e for e in self.exp_events if e[0] >= self.credited_until - 1260],
                    exp_minutes={str(k): v for k, v in self.exp_minutes.items()}, deaths=self.deaths, exp_lost=self.exp_lost, gaps=self.gaps,
                    hp_lost=self.hp_lost, hp_drops=self.hp_drops,
                    attacks={str(k): v for k, v in self.attacks.items() if v}, casts={str(k): v for k, v in self.casts.items() if v},
                    combat=self.combat.to_json(), kill_attacks=self.kill_attacks,
                    level_start=self.level_start)

    @classmethod
    def from_json(cls, data):
        run = cls(data['character'], data['started_at'])
        for key in ('id', 'status', 'pause_reason', 'paused_at', 'idle_seconds', 'last_gain', 'credited_until',
                    'ledger', 'deaths', 'exp_lost', 'gaps', 'level_start', 'hp_lost', 'hp_drops'):
            setattr(run, key, data.get(key, getattr(run, key)))
        run.exp_events = [tuple(e) for e in data.get('exp_events') or []]
        run.exp_minutes = collections.Counter({int(k): v for k, v in (data.get('exp_minutes') or {}).items()})
        run.attacks = collections.Counter({int(k): v for k, v in (data.get('attacks') or {}).items()})
        run.casts = collections.Counter({int(k): v for k, v in (data.get('casts') or {}).items()})
        run.combat = combat.Meter(data.get('combat'))
        run.kill_attacks = data.get('kill_attacks', {})
        run.segments = [Segment.from_json(s) for s in data.get('segments') or []]
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
        self.table = None
        self.exp_messages = 0       # experience announced since the last experience update
        self.buffs = {}             # source -> (start, milliseconds)
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
    def __init__(self, folder, prices, now=time.time):
        self.folder = Path(folder)
        self.data = self.folder / 'grind'
        self.prices = prices
        self.now = now
        self.characters = {}
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
        self.health['client_frames'] += 1
        if character is not None:
            character.client_seen = True
            character.client_at = self.now()
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
        info = proto.read_character(data, self.profile)
        if info:
            key = info.get('name') or info.get('character_id')
            if key and key != character.key:
                character.key = key
                self.adopt_by_key(character)
            for field in ('name', 'level', 'job', 'exp', 'character_id'):
                if info.get(field) is not None:
                    setattr(character, field, info[field])
        new_map = proto.map_id(data)
        if new_map is None:
            return
        if new_map != character.map_id and character.run and character.run.status == 'active':
            self.pause(character.run, 'map', now)
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

    def adopt_by_key(self, character):
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
            character.hp = hp
        if exp_bit in values and self.profile['stat'].get('confirmed'):
            self.experience(character, values[exp_bit], old_level, now)

    def experience(self, character, value, old_level, now):
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
        buff = proto.parse_buff(data, self.profile.get('buff') or {})
        if buff:
            source, milliseconds = buff
            character.buffs[source] = (now, milliseconds)
            if source < 0:
                self.prices.want([-source])
            self.dirty = True

    def party_update(self, character, data):
        kind = data[2] if len(data) > 2 else None
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
            for oid in {oid for oid, _ in damage['targets']}:
                sample = character.mob_attacks.get(oid)
                if sample:
                    if own and character.run and character.run.status == 'active':
                        sample['attacks'] += damage['skill'] not in FOLLOW_UPS
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
        bags = bag_totals(inventory)
        previous_slots = character.bag_slots
        character.bag_slots = None if inventory.slots is None else dict(inventory.slots)
        pieces = equipment_pieces(inventory)
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
                if self.kills_by_exp(character):
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

    def disconnect(self, session):
        """The connection closed or failed; its run waits for the same character."""
        character = self.characters.pop(session, None)
        if character and character.run:
            self.pause(character.run, 'disconnect', self.now())
            self.restored.append(character.run)
            self.dirty = True

    def end(self, character, now):
        self.clear_item_matches(character)
        run = character.run
        character.run = None
        self.finish(run, now)

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
                            stats=(e.get('piece') or {}).get('stats'), notable=e['kind'] == 'loot' and amount >= notable)
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
        loot_rows.sort(key=lambda row: row['t'], reverse=True)
        cash_events = [(e['t'], e['mesos'] * (1 if e['kind'] == 'mesos' else -1))
                       for e in run.ledger if e['kind'] in ('mesos', 'spent')]
        cash_events += [(e['t'], amount * (1 if e['kind'] == 'loot' else -1)) for e, _, _, amount in rows]
        chart_end = now if run.status == 'active' else (run.paused_at or run.credited_until)
        def indexed(events):
            events = sorted(events)
            stamps, totals = [], [0]
            for stamp, value in events:
                stamps.append(stamp)
                totals.append(totals[-1] + value)
            return stamps, totals
        exp_index, cash_index = indexed(run.exp_events), indexed(cash_events)
        rate_history = []
        for stamp in [chart_end - n * 10 for n in range(30, -1, -1)]:
            span = min(60, stamp - run.started_at)
            if span < 30:
                continue
            def window(index):
                stamps, totals = index
                return (totals[bisect.bisect_right(stamps, stamp)] - totals[bisect.bisect_right(stamps, stamp - 60)]) * 3600 / span
            rate_history.append(dict(t=stamp, exp=window(exp_index), net=window(cash_index)))
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
            kills=kills, kills_per_hour=kills / hours if hours else None, kills_estimated=self.kills_by_exp(character),
            deaths=run.deaths, exp_lost=run.exp_lost, gaps=run.gaps,
            mesos=money['cash'], item_value=money['loot'], consume_cost=money['cost'], mesos_spent=money['spent'],
            net=money['net'], net_per_hour=money['net'] / hours if hours else None,
            net_per_hour_1m=net_1m, rate_history=rate_history, timeline=self.timeline(run, rows, now),
            cash_per_hour=money['cash'] / hours if hours else None, pending_prices=money['pending'],
            recent=recent_rows, loot=loot_rows, consumables=consumables,
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
            segments=[s.to_json() for s in run.segments])

    def timeline(self, run, rows, now, points=48):
        """The whole run in at most `points` equal buckets: exp and net per bucket.

        Exp comes from per-minute totals kept for the whole run; net from the
        ledger (money in and out, valued loot and consumables)."""
        start = run.started_at
        end = now if run.status == 'active' else max(run.credited_until, start + 60)
        size = max(60.0, (end - start) / points)
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
        return dict(start=start, bucket=round(size, 1), exp=[round(v) for v in exp], net=[round(v) for v in net])

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
                continue
            if left <= 0 or source in PASSIVE_BUFFS:
                continue
            shown.add(source)
            out.append(self.buff_row(source, round(left, 1), milliseconds / 1000, source in pinned))
        out += [self.buff_row(source, 0, total, True) for source, total in pinned.items() if source not in shown]
        return sorted(out, key=lambda b: b['seconds'])

    def buff_row(self, source, seconds, total, pinned):
        name = skill_name(source) if source > 0 else self.name(-source)
        return dict(source=source, name=name, seconds=seconds, total=total,
                    item_id=-source if source < 0 else None, pinned=pinned)

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
                     characters=[dict(c.facts(), map_id=c.map_id, buffs=self.buffs(c, now)) for c in self.characters.values()],
                     protocol_warning=bool(self.suspect()))
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
        if not segments:
            return
        payload = dict(event_id=run.id, started_at=run.started_at, ended_at=summary['ended_at'], segments=segments)
        write_json(self.folder / f'grind_{run.id}.json', payload)


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
