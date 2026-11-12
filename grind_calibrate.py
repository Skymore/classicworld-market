"""Learn the grind profile from recorded server frames, without user labels.

The verified decoders (inventory, money, map entry) are the ground truth;
unknown messages are aligned against them:

* stat field sizes: frames that carry a single stat field reveal its size;
  a multi-field frame with one unknown size reveals the rest.
* the experience field: the bit that updates most often, mostly upwards.
* snapshot level/job/stats: the only offset where level, a known job ID, four
  base stats and HP/MP bounds line up in every snapshot.
* snapshot experience: the offset whose value sits just below the first
  experience update that follows the snapshot.
* kills: the fixed-length message that precedes experience gains, whose
  object ID first appeared in an earlier (spawn) message carrying a mob ID.
* pickups: the message that names the item ID right before it enters a bag.

Every decision needs repeated, consistent evidence (MIN_* below). Anything
that does not reach it stays unconfirmed and the tracker shows it as unknown.
Run directly to print a report: python grind_calibrate.py <frames folder>.
"""
import bisect
import collections
import json
import struct
import sys
from pathlib import Path

from character_snapshot import character_shift
from grind_data import JOBS, exp_to_next
from grind_frames import read_frames
from grind_protocol import (MESO_BIT, PRIOR_BITS, STAT, default_profile, is_snapshot, parse_stat,
                            single_bit_size, stat_bits, stat_header)
from market_inventory import Inventory

MIN_SIZE_SAMPLES = 3
MIN_EXP_UPDATES = 12
MIN_KILLS = 12
MIN_PICKUPS = 4
KILL_WINDOW = 0.6
PICKUP_WINDOW = 0.8


def opcode(data):
    return int.from_bytes(data[:2], 'little')


class Timeline:
    """Frames of each connection, sorted by time, for windowed lookups."""
    def __init__(self, frames):
        self.frames = collections.defaultdict(list)
        for t, session, data in frames:
            self.frames[session].append((t, data))
        for rows in self.frames.values():
            rows.sort(key=lambda row: row[0])
        self.times = {s: [row[0] for row in rows] for s, rows in self.frames.items()}

    def window(self, session, start, end):
        rows, times = self.frames.get(session, ()), self.times.get(session, ())
        return rows[bisect.bisect_left(times, start):bisect.bisect_right(times, end)]


def learn_sizes(frames):
    """{bit: size} agreed by single-field frames, then solved multi-field ones."""
    votes = collections.defaultdict(collections.Counter)
    multi = []
    for _, _, data in frames:
        found = single_bit_size(data)
        if found:
            votes[found[0]][found[1]] += 1
        elif stat_header(data):
            multi.append(data)
    sizes = {MESO_BIT: 8}
    for bit, counter in votes.items():
        size, count = counter.most_common(1)[0]
        if count >= MIN_SIZE_SAMPLES and count >= 0.9 * sum(counter.values()):
            sizes[bit] = size
    solved = collections.defaultdict(collections.Counter)
    for _ in range(3):
        for data in multi:
            mask, start = stat_header(data)
            bits = stat_bits(mask)
            unknown = [b for b in bits if b not in sizes]
            if len(unknown) != 1:
                continue
            size = len(data) - start - 2 - sum(sizes[b] for b in bits if b in sizes)
            if size in (1, 2, 4, 8):
                solved[unknown[0]][size] += 1
        for bit, counter in solved.items():
            size, count = counter.most_common(1)[0]
            if bit not in sizes and count >= 2 and count == sum(counter.values()):
                sizes[bit] = size
    return sizes, {str(b): dict(c) for b, c in votes.items()}


def stat_series(frames, sizes):
    """[(time, session, {bit: value})] of fully parsed stat updates."""
    out = []
    for t, session, data in frames:
        if opcode(data) == STAT:
            values = parse_stat(data, sizes)
            if values:
                out.append((t, session, values))
    return out


def pick_exp_bit(series, sizes):
    counts = collections.Counter()
    rises = collections.Counter()
    last = {}
    for _, session, values in series:
        for bit, value in values.items():
            if bit == MESO_BIT:
                continue
            counts[bit] += 1
            key = session, bit
            if key in last and value > last[key]:
                rises[bit] += 1
            last[key] = value
    def good(bit):
        return counts[bit] >= MIN_EXP_UPDATES and rises[bit] >= 0.75 * (counts[bit] - 1) and sizes.get(bit, 0) >= 4
    prior = PRIOR_BITS['exp']
    if good(prior):
        return prior, dict(updates=counts[prior], rises=rises[prior])
    ranked = [b for b in sorted(counts, key=counts.get, reverse=True) if good(b)]
    return (ranked[0], dict(updates=counts[ranked[0]], rises=rises[ranked[0]])) if ranked else (None, dict(updates=dict(counts)))


def character_candidates(data):
    """{('pre', level offset): hp width} where the base-stat block fits."""
    found = {}
    limit = min(len(data) - 40, 229)
    for at in range(24, limit):
        level = data[at]
        if not 1 <= level <= 200:
            continue
        job = struct.unpack_from('<H', data, at+1)[0]
        if job not in JOBS:
            continue
        base = struct.unpack_from('<4H', data, at+3)
        if not all(4 <= v <= 2000 for v in base):
            continue
        for width, code in ((4, 'I'), (2, 'H')):
            hp, max_hp, mp, max_mp = struct.unpack_from('<4' + code, data, at+11)
            if 1 <= hp <= max_hp <= 500000 and 0 <= mp <= max_mp <= 500000 and max_hp >= 10:
                found[at] = width
                break
    return found


def name_offset(data, level_at):
    """Offset of a printable 13-byte name field shortly before the level byte."""
    best = None
    for at in range(max(16, level_at - 64), level_at - 13):
        field = data[at:at+13]
        text = field.split(b'\0', 1)[0]
        if not 2 <= len(text) <= 12 or field[len(text):] != bytes(13 - len(text)):
            continue
        try:
            decoded = text.decode('utf-8')
        except UnicodeDecodeError:
            continue
        # A name starts the field: the byte before it belongs to the ID.
        starts = not (0x20 <= data[at-1] < 0x7f) or data[at-1] == 0
        if decoded.isprintable() and starts and at >= 4 and data[at-4:at] != bytes(4):
            best = at
    return best


def learn_snapshot(frames, timeline, exp_bit, sizes):
    snapshots = [(t, s, d) for t, s, d in frames if is_snapshot(d)]
    report = dict(snapshots=len(snapshots))
    if not snapshots:
        return dict(confirmed=False), report
    common = None
    for _, _, data in snapshots:
        offsets = set(character_candidates(data))
        common = offsets if common is None else common & offsets
    report['level_offsets'] = sorted(common or [])
    if not common or len(common) != 1:
        return dict(confirmed=False), report
    level_at = common.pop()
    section = dict(level=['pre', level_at], job=['pre', level_at + 1])
    names = {name_offset(d, level_at) for _, _, d in snapshots}
    if len(names) == 1 and None not in names:
        name_at = names.pop()
        section.update(name=['pre', name_at], character_id=['pre', name_at - 4])
    # Experience: the first update after a snapshot of the same connection
    # is slightly above the stored value.
    if exp_bit is not None:
        size = sizes[exp_bit]
        votes = collections.Counter()
        tried = 0
        for t, session, data in snapshots:
            first = next((v for ft, fd in timeline.window(session, t, float('inf')) if opcode(fd) == STAT
                          for v in [(parse_stat(fd, sizes) or {}).get(exp_bit)] if v is not None), None)
            if first is None:
                continue
            tried += 1
            level = data[level_at]
            room = max(2000, (exp_to_next(level) or first) // 5)
            shift = character_shift(data)
            for at in range(level_at + 20, min(len(data) - size, 300 + shift)):
                value = int.from_bytes(data[at:at+size], 'little')
                if 0 < value <= first and first - value <= room:
                    place = ('pre', at) if at < 229 else ('post', at - shift)
                    votes[place] += 1
        report['exp_votes'] = {f'{k[0]}:{k[1]}': v for k, v in votes.items()}
        winners = [p for p, n in votes.items() if n == tried]
        if tried and len(winners) == 1:
            section['exp'] = [list(winners[0]), size]
    section['confirmed'] = True
    return section, report


def replay_inventory(frames):
    """[(time, session, item_id, gained quantity)] from the verified decoder."""
    inventories = {}
    gains = []
    for t, session, data in frames:
        inventory = inventories.setdefault(session, Inventory())
        before = dict(_totals(inventory))
        inventory.observe(data, session)
        if opcode(data) != 0x72 or inventory.slots is None or not before:
            continue
        for item, quantity in _totals(inventory).items():
            if quantity > before.get(item, 0):
                gains.append((t, session, item, quantity - before.get(item, 0)))
    return gains


def _totals(inventory):
    totals = collections.Counter()
    for item, quantity in (inventory.slots or {}).values():
        totals[item] += quantity
    for piece in (inventory.equipment or {}).values():
        totals[piece['item_id']] += 1
    return totals


def learn_pickup(timeline, gains):
    report = dict(gains=len(gains))
    if len(gains) < MIN_PICKUPS:
        return dict(confirmed=False), report
    votes = collections.Counter()
    for t, session, item, _ in gains:
        seen = set()
        for ft, data in timeline.window(session, t - PICKUP_WINDOW, t + 0.05):
            if opcode(data) in (0x72, STAT):
                continue
            for at in range(2, len(data) - 3):
                if int.from_bytes(data[at:at+4], 'little') == item:
                    seen.add((opcode(data), at))
        votes.update(seen)
    report['votes'] = {f'0x{op:x}@{at}': n for (op, at), n in votes.most_common(5)}
    if votes:
        (op, at), count = votes.most_common(1)[0]
        if count >= MIN_PICKUPS and count >= 0.7 * len(gains):
            return dict(confirmed=True, opcode=op, item_offset=at, matched=count), report
    return dict(confirmed=False), report


def learn_kill(frames, timeline, series, exp_bit):
    report = {}
    if exp_bit is None:
        return dict(confirmed=False), dict(spawn=dict(confirmed=False)), report
    rises = []
    last = {}
    for t, session, values in series:
        value = values.get(exp_bit)
        if value is None:
            continue
        if session in last and value > last[session]:
            rises.append((t, session))
        last[session] = value
    report['exp_rises'] = len(rises)
    if len(rises) < MIN_KILLS:
        return dict(confirmed=False), dict(confirmed=False), report
    # Candidate death messages: (opcode, length) seen shortly before rises.
    votes = collections.Counter()
    for t, session in rises:
        seen = {(opcode(d), len(d)) for ft, d in timeline.window(session, t - KILL_WINDOW, t)
                if opcode(d) not in (STAT, 0x72) and len(d) <= 16}
        votes.update(seen)
    report['death_votes'] = {f'0x{op:x}/{n}': c for (op, n), c in votes.most_common(5)}
    for (op, length), count in votes.most_common(5):
        if count < 0.7 * len(rises):
            break
        deaths = [(t, s, int.from_bytes(d[2:6], 'little')) for t, s, d in frames if opcode(d) == op and len(d) == length]
        if not deaths:
            continue
        # The object ID at offset 2 must have appeared earlier in one message type.
        first_seen = {}
        for t, s, d in frames:
            if len(d) >= 10 and opcode(d) != op:
                key = s, int.from_bytes(d[2:6], 'little')
                first_seen.setdefault(key, (t, opcode(d), d))
        spawn_ops = collections.Counter(first_seen[(s, oid)][1] for t, s, oid in deaths if (s, oid) in first_seen)
        if not spawn_ops:
            continue
        spawn_op, matched = spawn_ops.most_common(1)[0]
        kill = dict(confirmed=True, opcode=op, length=length, offset=2, matched=count)
        if matched < 0.8 * len(deaths):
            return kill, dict(confirmed=False), report
        samples = [first_seen[(s, oid)][2] for t, s, oid in deaths
                   if (s, oid) in first_seen and first_seen[(s, oid)][1] == spawn_op]
        mob_at = None
        for at in range(6, min(len(d) for d in samples) - 3):
            values = [int.from_bytes(d[at:at+4], 'little') for d in samples]
            if all(100000 <= v <= 9999999 for v in values):
                mob_at = at
                break
        spawn = dict(confirmed=mob_at is not None, opcode=spawn_op, offset=2, mob_offset=mob_at, matched=matched)
        return kill, spawn, report
    return dict(confirmed=False), dict(confirmed=False), report


def calibrate(frames):
    frames = sorted(frames, key=lambda row: row[0])
    timeline = Timeline(frames)
    sizes, size_votes = learn_sizes(frames)
    series = stat_series(frames, sizes)
    exp_bit, exp_report = pick_exp_bit(series, sizes)
    profile = default_profile()
    bits = {}
    if exp_bit is not None:
        bits['exp'] = exp_bit
    level_bit = PRIOR_BITS['level']
    if level_bit in sizes:
        bits['level'] = level_bit
    for role in ('hp', 'mp', 'max_hp', 'max_mp', 'job'):
        if PRIOR_BITS[role] in sizes:
            bits[role] = PRIOR_BITS[role]
    profile['stat'] = dict(sizes={str(b): s for b, s in sorted(sizes.items())}, bits=bits,
                           confirmed=exp_bit is not None)
    profile['snapshot'], snapshot_report = learn_snapshot(frames, timeline, exp_bit, sizes)
    gains = replay_inventory(frames)
    profile['pickup'], pickup_report = learn_pickup(timeline, gains)
    profile['kill'], profile['spawn'], kill_report = learn_kill(frames, timeline, series, exp_bit)
    profile['evidence'] = dict(frames=len(frames), size_votes=size_votes, exp=exp_report,
                               snapshot=snapshot_report, pickup=pickup_report, kill=kill_report)
    return profile


def summary(profile):
    """Chinese one-line state per section, for the settings page."""
    lines = []
    stat = profile.get('stat', {})
    lines.append(('经验字段', '已确认' if stat.get('confirmed') else '等待更多击杀经验'))
    snap = profile.get('snapshot', {})
    lines.append(('等级与职业', '已确认' if snap.get('confirmed') else '等待换频道或重新登录'))
    lines.append(('当前经验', '已确认' if snap.get('exp') else '等待换频道后打怪'))
    lines.append(('击杀与怪物', '已确认' if profile.get('kill', {}).get('confirmed') else '按经验次数估算'))
    lines.append(('拾取归属', '已确认' if profile.get('pickup', {}).get('confirmed') else '刷图时背包增加均计为拾取'))
    return lines


def complete(profile):
    return all(profile.get(k, {}).get('confirmed') for k in ('stat', 'snapshot', 'kill', 'pickup')) \
        and bool(profile.get('snapshot', {}).get('exp'))


if __name__ == '__main__':
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    files = sorted(folder.glob('frames_*.jsonl')) if folder.is_dir() else [folder]
    result = calibrate(read_frames(files))
    print(json.dumps(result, ensure_ascii=False, indent=1))
    for label, state in summary(result):
        print(f'{label}: {state}')
