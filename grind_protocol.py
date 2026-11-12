"""Server-stream facts the grind tracker reads, and the learned profile.

Only the money and inventory layouts were verified against live captures
before this module existed (see market_inventory). Everything else is a
*profile*: offsets and sizes learned by grind_calibrate from the player's
own recorded frames. A section is used only once the calibrator marked it
confirmed; until then the tracker leaves that number unknown instead of
guessing.

Stat updates (0x7E): opcode, three flag bytes (each 0 or 1; live captures
show 00 00 01, 00 01 01 for picked-up money and 01 00 01), a 32-bit mask,
one field per set bit in ascending bit order, then a tail: a flag byte, one
more byte when that flag is 1, and a final zero.

Full map entries (2026-11-11 capture, level 68 Hunter): name at 170, level
at 197, job at 201, base stats at 203, HP/MP at 211, the skill-point books at
229, then eight-byte experience and the map ID. The calibrator still learns
these offsets from each player's own frames.
"""
import json
import struct
from pathlib import Path

from character_snapshot import character_shift

STAT = 0x7E
MAP_ENTRY = (0x1A6, 0x1A9)
MESO_BIT = 18
# Classic bit positions. Mesos (bit 18) matches the live capture, so these are
# the starting hypotheses; the calibrator confirms sizes and roles from data.
PRIOR_BITS = dict(level=4, job=5, hp=10, max_hp=11, mp=12, max_mp=13, exp=16)
VERIFIED_SIZES = {MESO_BIT: 8}
# Version 1 profiles could confirm a mob-control message as kills; drop them.
PROFILE_VERSION = 2
MESSAGE = 0x8B      # "you gained" messages: byte 2 is the kind
BUFF = 0x7F         # buffs on the player: flag block, then value, source, milliseconds


def default_profile():
    """Nothing confirmed: what the calibrator starts from."""
    return dict(version=PROFILE_VERSION, stat=dict(sizes={str(k): v for k, v in VERIFIED_SIZES.items()},
                bits={}, confirmed=False), snapshot=dict(confirmed=False), kill=dict(confirmed=False),
                pickup=dict(confirmed=False), buff=dict(confirmed=False), evidence={})


def verified_profile():
    """Layouts checked against a full live session (2026-11-11, level 68 Hunter,
    8 minutes, 84 kills): 84 experience updates = 84 experience messages
    (sum 2311 both ways) = 84 own kills; 29 bag gains = 29 item messages;
    every money pickup message matches the balance change.

    Kills: mob leave (0x3D4, 16 bytes, object at 2) with leave type 1 at 6 is
    a death; it is ours when the mob had a hit message (0x44D, object at 2)
    naming our character ID at 6. Other players' kills (76 in that session)
    and mobs leaving view (type 0) are excluded. Mob control (0x3D5) is not a
    death: it is released for many other reasons.
    Mob type: spawns (0x3C9) and mob-control hand-overs that carry the mob
    (0x3D5, long form) hold the object at 3 and the catalogue mob ID at 8
    (Classic World uses small IDs: 5 Red Snail, 6 Stump, 22 Wild Boar ...,
    matching the site's map pages).
    The player's own messages (attacks, skills, damage taken) are recorded
    but not yet calibrated: profile section `client` stays unconfirmed.
    """
    profile = default_profile()
    profile.update(
        stat=dict(sizes={'10': 4, '12': 4, '16': 8, '18': 8}, bits=dict(exp=16, hp=10, mp=12), confirmed=True),
        snapshot=dict(confirmed=True, character_id=['pre', 158], name=['pre', 170], level=['pre', 197],
                      job=['pre', 201], exp=[['post', 235], 8]),
        kill=dict(confirmed=True, opcode=0x3D4, length=16, offset=2, type_offset=6, type_value=1,
                  owner=dict(opcode=0x44D, offset=2, char_offset=6)),
        pickup=dict(confirmed=True, opcode=MESSAGE, kind_offset=2, kind_value=0, money_offset=4,
                    item_offset=5, quantity_offset=9, meso_offset=6),
        buff=dict(confirmed=True, opcode=BUFF, start=126),
        spawn=dict(confirmed=True, opcodes=[0x3C9, 0x3D5], offset=3, template_offset=8, min_length=40),
        experience=dict(opcode=MESSAGE, kind_value=3, gain_offset=4),
        source='verified live session 2026-11-11')
    return profile


def load_profile(path):
    profile = verified_profile()
    try:
        saved = json.loads(Path(path).read_text(encoding='utf-8'))
        if saved.get('version') == PROFILE_VERSION:
            for key, value in saved.items():
                if isinstance(value, dict) and isinstance(profile.get(key), dict):
                    profile[key].update(value)
                else:
                    profile[key] = value
    except (OSError, ValueError, AttributeError):
        pass
    return profile


def save_profile(path, profile):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(profile, ensure_ascii=False, indent=1), encoding='utf-8')
    temporary.replace(path)


def stat_header(data):
    """(mask, payload start) of a stat update, else None."""
    if len(data) < 11 or data[:2] != b'\x7e\x00' or any(b not in (0, 1) for b in data[2:5]):
        return None
    return struct.unpack_from('<I', data, 5)[0], 9


def tail_ok(data, pos):
    """The stat tail: 00 00, or 01 <byte> 00."""
    rest = data[pos:]
    return rest == b'\x00\x00' or (len(rest) == 3 and rest[0] == 1 and rest[2] == 0)


def stat_bits(mask):
    return [bit for bit in range(32) if mask >> bit & 1]


def parse_stat(data, sizes):
    """{bit: value} for a stat update whose every field size is known.

    Exactly the tail must remain; anything else means the sizes are wrong
    for this frame, and nothing is returned.
    """
    header = stat_header(data)
    if header is None:
        return None
    mask, pos = header
    values = {}
    for bit in stat_bits(mask):
        size = sizes.get(bit, sizes.get(str(bit)))
        if size not in (1, 2, 4, 8) or pos + size > len(data):
            return None
        values[bit] = int.from_bytes(data[pos:pos+size], 'little')
        pos += size
    return values if tail_ok(data, pos) else None


def single_bit_size(data):
    """(bit, size) when a stat update carries exactly one field."""
    header = stat_header(data)
    if header is None:
        return None
    bits = stat_bits(header[0])
    if len(bits) != 1:
        return None
    for size in (len(data) - 11, len(data) - 12):
        if size in (1, 2, 4, 8) and tail_ok(data, 9 + size):
            return bits[0], size
    return None


def is_snapshot(data):
    return (len(data) >= 512 and int.from_bytes(data[:2], 'little') in MAP_ENTRY
            and data[14:24] == bytes.fromhex('00000000000100000000'))


def snapshot_offset(data, place):
    """Absolute offset of a learned snapshot field.

    `place` is ['pre', n] for fields before the variable skill-point books
    (fixed position) or ['post', n] for fields after them (n plus the books'
    length, as character_shift reports).
    """
    kind, offset = place
    return offset if kind == 'pre' else offset + character_shift(data)


def read_character(data, profile):
    """Character facts from a full map-entry snapshot, using confirmed offsets."""
    section = profile.get('snapshot') or {}
    if not section.get('confirmed') or not is_snapshot(data):
        return None
    try:
        out = {}
        for key, size in (('character_id', 4), ('level', 1), ('job', 2)):
            if key in section:
                at = snapshot_offset(data, section[key])
                out[key] = int.from_bytes(data[at:at+size], 'little')
        if 'exp' in section:
            place, size = section['exp']
            at = snapshot_offset(data, place)
            out['exp'] = int.from_bytes(data[at:at+size], 'little')
        if 'name' in section:
            at = snapshot_offset(data, section['name'])
            raw = data[at:at+13].split(b'\0', 1)[0]
            out['name'] = raw.decode('utf-8', 'replace') if raw else None
        return out
    except (ValueError, IndexError):
        return None


def map_id(data):
    """Map entered by a 0x1A6 / 0x1A9 frame, using market_location's parser."""
    from market_location import inspect_map_context
    try:
        location, _ = inspect_map_context(data)
    except ValueError:
        return None
    return location['map_id'] if location else None


def opcode(data):
    return int.from_bytes(data[:2], 'little')


def u32(data, at):
    return int.from_bytes(data[at:at+4], 'little') if 0 <= at and at + 4 <= len(data) else None


def death(data, rule):
    """Object ID of a mob that died, when this frame is the learned death message."""
    if not rule.get('confirmed') or opcode(data) != rule.get('opcode'):
        return None
    if rule.get('length') is not None and len(data) != rule['length']:
        return None
    at = rule.get('type_offset')
    if at is not None and (at >= len(data) or data[at] != rule.get('type_value')):
        return None
    return u32(data, rule.get('offset', 2))


def spawned(data, rule):
    """(object ID, mob ID) when a mob with its type enters or changes controller."""
    if not rule.get('confirmed') or opcode(data) not in rule.get('opcodes', ()) or len(data) < rule.get('min_length', 0):
        return None
    oid, mob = u32(data, rule.get('offset', 3)), u32(data, rule.get('template_offset', 8))
    return (oid, mob) if oid is not None and mob is not None and 0 < mob < 100_000_000 else None


def hit_by(data, rule, character_id):
    """Object ID of a mob this character hit, when this frame is the owner message."""
    owner = rule.get('owner') or {}
    if not owner or character_id is None or opcode(data) != owner.get('opcode'):
        return None
    if u32(data, owner.get('char_offset', 6)) != character_id:
        return None
    return u32(data, owner.get('offset', 2))


def pickup(data, rule):
    """('item', id, quantity) or ('mesos', amount) from a gained-something message."""
    if not rule.get('confirmed') or opcode(data) != rule.get('opcode'):
        return None
    kind = rule.get('kind_offset', 2)
    if len(data) <= kind or data[kind] != rule.get('kind_value', 0):
        return None
    money = rule.get('money_offset')
    if money is not None and money < len(data) and data[money] == 1:
        amount = u32(data, rule.get('meso_offset', 6))
        return ('mesos', amount) if amount is not None else None
    item = u32(data, rule.get('item_offset', 5))
    if item is None or not 1000000 <= item < 6000000:
        return None
    at = rule.get('quantity_offset')
    quantity = int.from_bytes(data[at:at+2], 'little') if at is not None and at + 2 <= len(data) else 1
    return 'item', item, quantity or 1


def experience_message(data, profile):
    """Experience gained, from a "you gained N EXP" message."""
    rule = profile.get('experience') or {}
    if not rule or opcode(data) != rule.get('opcode') or len(data) < 8 or data[2] != rule.get('kind_value'):
        return None
    return u32(data, rule.get('gain_offset', 4))


def valid_source(source):
    """A buff source: a skill ID, or a consumable item ID stored negated."""
    return 1000 <= source <= 99_999_999 or -2_999_999 <= source <= -2_000_000


def parse_buff(data, rule):
    """(source, milliseconds) of a buff given to the player.

    After the flag block each stat carries value, source, duration; values
    are two or four bytes depending on the stat, so the first
    (source, duration) pair is taken where the duration is not the source
    repeated (some stats use the skill ID as their value).
    """
    if not rule.get('confirmed') or opcode(data) != rule.get('opcode'):
        return None
    for at in range(rule.get('start', 2), len(data) - 7):
        source = int.from_bytes(data[at:at+4], 'little', signed=True)
        duration = int.from_bytes(data[at+4:at+8], 'little')
        if valid_source(source) and 1000 <= duration <= 7_200_000 and duration != abs(source):
            return source, duration
    return None
