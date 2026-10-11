"""Versioned, conservative decoding of captured ClassicWorld equipment records.

Values come from packet bytes, never substituted from the item catalogue.
Bit names are inferred from multiple item families; live same-instance validation
is still pending. Unknown bits stay explicitly labelled.
"""
import struct

FIELDS = {
    0: ('str', '力量'), 1: ('dex', '敏捷'), 2: ('int', '智力'),
    3: ('luk', '运气'), 4: ('hp', '最大 HP'), 5: ('mp', '最大 MP'),
    6: ('speed', '移动速度'), 7: ('jump', '跳跃力'),
    9: ('magic_attack', '魔法攻击'), 10: ('weapon_defense', '物理防御'),
    11: ('magic_defense', '魔法防御'), 12: ('accuracy', '命中'),
    13: ('avoid', '回避'), 16: ('weapon_attack', '物理攻击'),
}


def decode_equipment(raw_hex, item_id):
    if item_id // 1000000 != 1:
        return None
    failure = dict(status='unsupported', stats=[], note='此记录格式尚未解析，原始数据已保留')
    try:
        raw = bytes.fromhex(raw_hex)
        if len(raw) < 60 or raw[20:22] != b'\x01\x01' or int.from_bytes(raw[22:26], 'little') != item_id:
            return failure
        if raw[26] not in (0, 1):
            return failure
        offset = 40 + (8 if raw[26] else 0)
        if raw[offset-5:offset] != bytes.fromhex('ffffffff01'):
            return failure
        mask = struct.unpack_from('<I', raw, offset)[0]
        # Higher-bit encodings have not been observed/validated.
        if mask & ~0x1ffff:
            return failure
        bits = [bit for bit in range(17) if mask & (1 << bit)]
        end = offset + 4 + 2 * len(bits)
        if len(raw) < end + 8:
            return failure
        values = struct.unpack_from('<' + 'H' * len(bits), raw, offset + 4)
        stats, unknown = [], []
        for bit, value in zip(bits, values):
            if bit in FIELDS:
                key, label = FIELDS[bit]
                stats.append(dict(key=key, label=label, value=value))
            else:
                unknown.append(dict(bit=bit, value=value))
        # Only decode the exact tail shape observed in ordinary equipment.
        slots = raw[end+4] if raw[end:end+4] == bytes.fromhex('01000400') and raw[end+5] == 255 else None
        if slots is not None and slots > 15:
            slots = None
        return dict(status='candidate', parser='cw_equipment_v1', stats=stats,
                    remaining_upgrades=slots, unknown_fields=unknown, mask=mask,
                    note='原始包解析值；尚待同一件装备截图核对，不作为已验证估价依据')
    except (ValueError, struct.error, IndexError):
        return failure
