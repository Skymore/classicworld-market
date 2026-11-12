"""Server-stream facts the grind tracker reads, and the learned profile.

Only the money and inventory layouts were verified against live captures
before this module existed (see market_inventory). Everything else is a
*profile*: offsets and sizes learned by grind_calibrate from the player's
own recorded frames. A section is used only once the calibrator marked it
confirmed; until then the tracker leaves that number unknown instead of
guessing.

Stat updates (0x7E): opcode, two zero bytes, an "exclusive" byte, a 32-bit
mask, one field per set bit in ascending bit order, then two trailing bytes.
The money-only form (mask 0x40000, eight-byte value) is the verified case.
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
PROFILE_VERSION = 1


def default_profile():
    return dict(version=PROFILE_VERSION, stat=dict(sizes={str(k): v for k, v in VERIFIED_SIZES.items()},
                bits={}, confirmed=False), snapshot=dict(confirmed=False), kill=dict(confirmed=False),
                pickup=dict(confirmed=False), evidence={})


def load_profile(path):
    profile = default_profile()
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
    if len(data) < 11 or data[:4] != b'\x7e\x00\x00\x00' or data[4] not in (0, 1):
        return None
    return struct.unpack_from('<I', data, 5)[0], 9


def stat_bits(mask):
    return [bit for bit in range(32) if mask >> bit & 1]


def parse_stat(data, sizes):
    """{bit: value} for a stat update whose every field size is known.

    The two trailing bytes must remain exactly; anything else means the
    sizes are wrong for this frame, and nothing is returned.
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
    return values if len(data) - pos == 2 else None


def single_bit_size(data):
    """(bit, size) when a stat update carries exactly one field."""
    header = stat_header(data)
    if header is None:
        return None
    bits = stat_bits(header[0])
    if len(bits) != 1:
        return None
    size = len(data) - 11
    return (bits[0], size) if size in (1, 2, 4, 8) else None


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


def object_id(data, rule):
    """The 32-bit field a learned kill/pickup rule names, when the frame matches."""
    if not rule.get('confirmed') or int.from_bytes(data[:2], 'little') != rule.get('opcode'):
        return None
    length = rule.get('length')
    if length is not None and len(data) != length:
        return None
    at = rule.get('offset', 2)
    if at + 4 > len(data):
        return None
    return int.from_bytes(data[at:at+4], 'little')
