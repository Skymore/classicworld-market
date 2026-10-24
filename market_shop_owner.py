"""Extract only the shop host identity from a validated shop-open response."""
import json
import re
import struct
from pathlib import Path

PARSER = 'cw_shop_owner_v1'


def decode_owner(opened, title=None, shop_id=None):
    if len(opened) < 20 or int.from_bytes(opened[:2], 'little') not in (0x577, 0x57a):
        return None
    if opened[2:6] != b'\x02\x00\x00\x00':
        return None
    try:
        title_size = int.from_bytes(opened[18:20], 'little')
        end = 20 + title_size
        actual_title = opened[20:end].decode('utf-8')
        if title is not None and actual_title != title:
            return None
        if shop_id is not None and int.from_bytes(opened[14:18], 'little') != shop_id:
            return None
        participants, character_id, _ = struct.unpack_from('<III', opened, end)
        name_size = int.from_bytes(opened[end+12:end+14], 'little')
        name_end = end + 14 + name_size
        name = opened[end+14:name_end].decode('utf-8')
        if not (1 <= participants <= 8 and 1 <= character_id <= 0xffffffff
                and 1 <= name_size <= 24 and len(name) == name_size
                and re.fullmatch(r'[A-Za-z0-9_]+', name)):
            return None
        # The host is repeated in the first avatar record. Do not identify a
        # visitor by searching for an arbitrary nickname elsewhere in the body.
        identity = opened[end+4:name_end]
        if opened.find(identity, name_end, name_end+96) < 0:
            return None
        return dict(character_id=character_id, name=name, parser=PARSER)
    except (ValueError, UnicodeError, struct.error):
        return None


def owner_from_snapshot(snapshot, folder):
    """Old collectors kept raw shop records locally; never upload those bytes."""
    filename = snapshot.get('raw_source', '')
    if not isinstance(filename, str) or not re.fullmatch(r'raw_shop_[0-9a-f]{32}\.jsonl', filename):
        return None
    try:
        path = Path(folder) / filename
        with path.open(encoding='utf-8') as stream:
            opened = json.loads(stream.readline(512 * 1024))
            listed = json.loads(stream.readline(512 * 1024))
        if opened.get('session') != snapshot['session'] or listed.get('session') != snapshot['session']:
            return None
        a, b = bytes.fromhex(opened['body_hex']), bytes.fromhex(listed['body_hex'])
        if len(b) < 8 or int.from_bytes(b[:2], 'little') != int.from_bytes(a[:2], 'little')+1:
            return None
        if not a.endswith(b[6:]):
            return None
        from decode_shops import rows
        items = rows(b)
        expected = snapshot['items']
        fields = ('category', 'slot', 'item_id', 'price_mesos_candidate',
                  'bundle_quantity_candidate', 'available_quantity_candidate')
        if len(items) != len(expected) or any(any(x[k] != y[k] for k in fields) for x,y in zip(items,expected)):
            return None
        return decode_owner(a, snapshot['title'], snapshot['shop_id'])
    except (OSError, ValueError, KeyError, TypeError, struct.error):
        return None
