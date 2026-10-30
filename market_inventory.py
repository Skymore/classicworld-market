"""Receive-only inventory observations from ClassicWorld's ordered server stream.

Only the verified ordinary stack layout is decoded. Equipment, cash items and
unknown encodings remain unknown. A complete, uniquely bounded three-bag chain
is required before absence can mean zero. Never search for a requested item ID.
Raw character packets are not persisted or uploaded by this module.
"""
import collections
import json
import struct
import time


def stack(data, pos, category, capacity):
    slot, kind, item, cash = struct.unpack_from('<HBIB', data, pos)
    if not (1 <= slot <= capacity and kind == 2 and item // 1000000 == category and cash == 0):
        raise ValueError('Unsupported stack')
    if len(data) < pos + 43 or data[pos+16:pos+20] != b'\xff'*4 or data[pos+20] not in (0, 1):
        raise ValueError('Unsupported stack layout')
    quantity = struct.unpack_from('<H', data, pos+21)[0]
    if not quantity:
        raise ValueError('Empty occupied slot')
    # Rechargeable ammunition has an additional eight-byte serial after the
    # ordinary stack. It is part of this record, not the next inventory slot.
    end = pos+43+(8 if item//10000 in (207, 233) else 0)
    if len(data) < end:
        raise ValueError('Truncated rechargeable stack')
    return end, slot, item, quantity


def bags(data, pos, capacities):
    slots = {}
    for category in (2, 3, 4):
        last = 0
        while True:
            slot = struct.unpack_from('<H', data, pos)[0]
            if slot == 0:
                pos += 2
                break
            pos, slot, item, quantity = stack(data, pos, category, capacities[category-1])
            if slot <= last:
                raise ValueError('Unordered inventory')
            last = slot
            slots[category, slot] = (item, quantity)
    # The next section must be either the cash inventory or its empty marker.
    slot, kind, item = struct.unpack_from('<HBI', data, pos)
    if slot and not (1 <= slot <= capacities[4] and kind in (2, 3) and item // 1000000 == 5):
        raise ValueError('Missing inventory boundary')
    return slots


def header(data):
    if (len(data) < 512 or data[14:24] != bytes.fromhex('00000000000100000000')
            or int.from_bytes(data[:2], 'little') not in (0x1a6, 0x1a9)):
        raise ValueError('Not a supported character snapshot')
    mesos = struct.unpack_from('<Q', data, 341)[0]
    capacities = struct.unpack_from('<6H', data, 353)
    if mesos > 10**12 or not all(1 <= n <= 1000 for n in capacities) or data[365:368] != bytes(3):
        raise ValueError('Unsupported character inventory header')
    return mesos, capacities


def snapshot(data):
    mesos, capacities = header(data)
    candidates = []
    # Ordinary stacks follow the terminated equipment sections. Reject a start
    # that is really the tail of another valid stack, including holes in slots.
    for pos in range(370, min(len(data)-43, 200000)):
        if data[pos+2] == 2 and data[pos-16:pos] == bytes(16):
            try:
                stack(data, pos, 2, capacities[1])
                continuation = False
                for size in (43, 51):
                    try:
                        previous_slot, _, previous_item = struct.unpack_from('<HBI', data, pos-size)
                        # A malformed preceding record must not make the tail
                        # look like a complete bag with its first item absent.
                        continuation |= (1 <= previous_slot <= capacities[1]
                            and previous_item//1000000 == 2
                            and size == 43+(8 if previous_item//10000 in (207, 233) else 0))
                    except (ValueError, struct.error):
                        pass
                if continuation:
                    continue
                candidates.append(bags(data, pos, capacities))
            except (ValueError, struct.error):
                pass
    if len(candidates) != 1:
        raise ValueError('Inventory boundary is missing or ambiguous')
    return mesos, candidates[0], capacities


class Inventory:
    def __init__(self):
        self.session = None
        self.slots = None
        self.mesos = None
        self.capacities = None
        self.observed_at = 0

    def invalidate(self, session=None):
        if session is None or session == self.session:
            self.slots = self.mesos = None
            self.observed_at = 0

    def observe(self, data, session):
        opcode = int.from_bytes(data[:2], 'little')
        if opcode in (0x1a6, 0x1a9) and len(data) >= 512:
            self.invalidate()
            self.session = session
            try:
                self.mesos, self.capacities = header(data)
                self.observed_at = int(time.time())
                self.mesos, self.slots, self.capacities = snapshot(data)
                self.observed_at = int(time.time())
            except (ValueError, struct.error):
                pass
            return
        if session != self.session:
            return
        if opcode == 0x72:
            if self.slots is None:
                return
            try:
                self.update(data)
                self.observed_at = int(time.time())
            except (ValueError, struct.error, KeyError, IndexError):
                # An unknown item update does not invalidate independently
                # observed currency; missing bags remain unknown, never zero.
                self.slots = None
        elif opcode == 0x7e:
            if len(data) == 19 and data[:9] == bytes.fromhex('7e0000000100000400') and data[17:] == bytes(2):
                balance = struct.unpack_from('<Q', data, 9)[0]
                self.mesos = balance if balance <= 10**12 else None
                self.observed_at = int(time.time())
            elif not (len(data) >= 11 and data[:4] == bytes.fromhex('7e000000')
                      and data[4] in (0, 1) and not (int.from_bytes(data[5:9], 'little') & 0x40000)):
                # Unknown stat masks cannot leave a possibly changed balance
                # labelled current. Never infer it from the purchase budget.
                self.mesos = None

    def update(self, data):
        if len(data) < 9 or data[2] not in (0, 1) or data[3] != 0:
            raise ValueError('Unsupported inventory update')
        count = struct.unpack_from('<I', data, 4)[0]
        if count > 1000 or data[8] != 0:
            raise ValueError('Unsupported update envelope')
        # The pet refresh sent immediately after entering a channel removes
        # and re-adds one cash slot. Both operations are wholly outside the
        # tracked bags. Validate its complete envelope before ignoring it.
        if (count == 2 and len(data) == 92 and data[9:11] == bytes([3, 5])
                and data[13:15] == bytes([0, 5]) and data[11:13] == data[15:17]
                and 1 <= int.from_bytes(data[11:13], 'little') <= self.capacities[4]
                and data[17] == 3 and int.from_bytes(data[18:22], 'little')//1000000 == 5
                and data[22] == 1):
            return
        slots, pos = dict(self.slots), 9
        for _ in range(count):
            mode, category, slot = struct.unpack_from('<BBh', data, pos)
            pos += 4
            if category not in (2, 3, 4) or not 1 <= slot <= self.capacities[category-1]:
                raise ValueError('Unsupported inventory change')
            key = category, slot
            if mode == 0:
                # Add includes ItemSlotBase after the explicit slot number.
                end, _, item, quantity = stack(data, pos-2, category, self.capacities[category-1])
                slots[key] = item, quantity
                pos = end
            elif mode == 1:
                quantity = struct.unpack_from('<H', data, pos)[0]
                pos += 2
                if not quantity:
                    raise ValueError('Zero quantity without removal')
                slots[key] = slots[key][0], quantity
            elif mode == 2:
                dest = struct.unpack_from('<h', data, pos)[0]
                pos += 2
                if not 1 <= dest <= self.capacities[category-1]:
                    raise ValueError('Unsupported destination')
                other = category, dest
                old = slots.pop(key)
                if other in slots:
                    slots[key] = slots.pop(other)
                slots[other] = old
            elif mode == 3:
                del slots[key]
            else:
                raise ValueError('Unsupported inventory operation')
        if pos != len(data):
            raise ValueError('Unconsumed inventory update')
        self.slots = slots

    def view(self):
        if self.slots is None and self.mesos is None:
            return None
        totals = collections.Counter()
        for item, quantity in (self.slots or {}).values():
            totals[item] += quantity
        return dict(observed_at=self.observed_at, mesos=self.mesos, categories=[2, 3, 4] if self.slots is not None else [],
                    items=[dict(item_id=item, quantity=quantity) for item, quantity in sorted(totals.items())])


def read_inventory(folder, connected=True):
    if not connected:
        return None
    try:
        packet = json.loads((folder/'inventory_state.json').read_text(encoding='utf-8'))
        if not 0 <= time.time()-packet['alive_at'] <= 15:
            return None
        return packet['holdings']
    except (OSError, ValueError, KeyError, TypeError):
        return None
