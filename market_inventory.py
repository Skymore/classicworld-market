"""Receive-only inventory observations from ClassicWorld's ordered server stream.

The verified ordinary stack layout is decoded, and the equipment bag is read
record by record (see `equipment_bag`). Cash items and unknown encodings
remain unknown. A complete, uniquely bounded three-bag chain
is required before absence can mean zero. Never search for a requested item ID.
Raw character packets are not persisted or uploaded by this module.
"""
import collections
import json
import struct
import time
from character_snapshot import character_shift
from market_equipment import decode_equipment
from grind_protocol import stat_header, parse_stat, MESO_BIT


def stack(data, pos, category, capacity):
    slot, kind, item, cash = struct.unpack_from('<HBIB', data, pos)
    if not (1 <= slot <= capacity and kind == 2 and item // 1000000 == category and cash == 0):
        raise ValueError('Unsupported stack')
    if len(data) < pos + 43 or data[pos+16:pos+20] != b'\xff'*4 or data[pos+20] not in (0, 1):
        raise ValueError('Unsupported stack layout')
    quantity = struct.unpack_from('<H', data, pos+21)[0]
    rechargeable = item//10000 in (207, 233)
    # Used-up stars/bullets remain in their occupied slot until recharged.
    # Their explicit zero is valid; ordinary occupied stacks still need units.
    if not quantity and not rechargeable:
        raise ValueError('Empty occupied slot')
    # Rechargeable ammunition has an additional eight-byte serial after the
    # ordinary stack. It is part of this record, not the next inventory slot.
    end = pos+43+(8 if rechargeable else 0)
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


def inventory_shift(data):
    """character_shift plus an optional name after the skill-point books.

    Some characters' snapshots carry a flag at 272 (+books) set to 1 and followed by a
    length-prefixed name (2026-11-15: a teammate's own character name, 11 extra bytes);
    others have 0 there and nothing after. Everything from the mesos on moves with it,
    so without this their bags never parsed and loot/consumables stayed empty. Fields
    before 272 (location, level, exp) are unaffected and keep character_shift.
    """
    shift = character_shift(data)
    at = 272 + shift
    if len(data) > at + 3 and data[at] == 1:
        size = struct.unpack_from('<H', data, at + 1)[0]
        if 1 <= size <= 32 and len(data) > at + 3 + size:
            return shift + 2 + size
    return shift


def header(data):
    if (len(data) < 512 or data[14:24] != bytes.fromhex('00000000000100000000')
            or int.from_bytes(data[:2], 'little') not in (0x1a6, 0x1a9)):
        raise ValueError('Not a supported character snapshot')
    shift = inventory_shift(data)
    mesos = struct.unpack_from('<Q', data, 341+shift)[0]
    capacities = struct.unpack_from('<6H', data, 353+shift)
    if mesos > 10**12 or not all(1 <= n <= 1000 for n in capacities) or data[365+shift:368+shift] != bytes(3):
        raise ValueError('Unsupported character inventory header')
    return mesos, capacities


def snapshot(data):
    mesos, capacities = header(data)
    _, slots = _ordinary(data, capacities)
    return mesos, slots, capacities


def _ordinary(data, capacities):
    """(position of the first use stack, ordinary bags) of a snapshot."""
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
                candidates.append((pos, bags(data, pos, capacities)))
            except (ValueError, struct.error):
                pass
    if len(candidates) != 1:
        raise ValueError('Inventory boundary is missing or ambiguous')
    return candidates[0]


# Body slots of worn equipment (item type = item_id // 10000).
BODY = {1: (100,), 2: (101,), 3: (102,), 4: (103,), 5: (104, 105), 6: (106,), 7: (107,),
        8: (108,), 9: (110,), 10: (109,)}
MIN_EQUIP_RECORD = 100


def equip_header(data, pos):
    """(slot, item, cash) when an equipment record starts at `pos`, else None."""
    if pos < 0 or pos+30 > len(data):
        return None
    slot, kind, item, cash = struct.unpack_from('<hBIB', data, pos)
    if not (slot and abs(slot) <= 1000 and kind == 1 and item//1000000 == 1 and cash in (0, 1)):
        return None
    q = pos+16+(8 if cash else 0)
    if data[q:q+4] != bytes(4*[255]) or data[q+4] not in (0, 1):
        return None
    return slot, item, cash


def equip_record(data, start, end, slot, item):
    """One equipment piece; stats use the shop decoder, so unknown layouts keep no stats."""
    eq = decode_equipment((bytes(20)+bytes([1])+data[start+2:end]).hex(), item) or {}
    known = eq.get('status') == 'candidate'
    return dict(slot=slot, item_id=item, decoded=known,
                stats=[dict(key=x['key'], value=x['value']) for x in eq.get('stats', [])] if known else [],
                remaining_upgrades=eq.get('remaining_upgrades') if known else None,
                enhancements=eq.get('enhancements') if known else None,
                unknown_fields=len(eq.get('unknown_fields') or []) if known else 0)


def worn(section):
    def fits(slot, item):
        kind = item//10000
        if slot in BODY:
            return kind in BODY[slot]
        return (slot == 11 and 130 <= kind < 170) or (slot >= 12 and 111 <= kind <= 119)
    return all(fits(slot, item) for _, slot, item, _ in section)


def equipment_bag(data, begin, end, capacity):
    """(worn, bag) dicts slot -> piece between the inventory header and the use bag.

    Records are found by their fixed header (slot, kind 1, equipment ID, cash flag,
    expiry, ffffffff). Slot numbers rise within a section; worn pieces sit on their
    body slots and come first, then the equipment bag; cash sections are skipped.
    Anything else raises, so a layout change leaves the bag unknown, never wrong.
    """
    records = []
    for pos in range(begin, end-30):
        found = equip_header(data, pos)
        if found and (not records or pos >= records[-1][0]+MIN_EQUIP_RECORD):
            records.append((pos,)+found)
    if not records:
        if end-begin > 16 or any(data[begin:end]):
            raise ValueError('Unrecognised equipment sections')
        return {}, {}
    if records[0][0] != begin or not MIN_EQUIP_RECORD <= end-records[-1][0] <= 400:
        raise ValueError('Equipment sections do not join the use bag')
    sections = []
    for i, record in enumerate(records):
        if record[1] <= 0:
            raise ValueError('Negative snapshot slot')
        if not sections or record[1] <= sections[-1][-1][1] or record[3] != sections[-1][-1][3]:
            sections.append([])
        sections[-1].append(record)
    plain = [section for section in sections if not section[0][3]]
    if not plain:
        return {}, {}
    if worn(plain[0]):
        on, bag = plain[0], (plain[1] if len(plain) > 1 else [])
        extra = plain[2:]
    else:
        on, bag, extra = [], plain[0], plain[1:]
    if extra or any(slot > capacity for _, slot, _, _ in bag):
        raise ValueError('Ambiguous equipment sections')
    ends = {record[0]: (records[i+1][0] if i+1 < len(records) else end) for i, record in enumerate(records)}
    piece = lambda r: equip_record(data, r[0], ends[r[0]], r[1], r[2])
    return {r[1]: piece(r) for r in on}, {r[1]: piece(r) for r in bag}


# Bags the collector does not track: cash (5) and cash equipment (6).
UNTRACKED = (5, 6)


class Inventory:
    def __init__(self):
        self.revision = 0
        self.session = None
        self.slots = None
        self.mesos = None
        self.capacities = None
        self.observed_at = 0
        # Equipment bag and worn pieces, slot -> piece; None while unknown.
        self.equipment = self.worn = None

    def invalidate(self, session=None):
        if session is None or session == self.session:
            self.revision += 1
            self.slots = self.mesos = None
            self.equipment = self.worn = None
            self.observed_at = 0

    def observe(self, data, session):
        # Updates replace slots atomically. Health/MP and unrelated frames do
        # not trigger inventory disk writes or a new position revision.
        before = self.session, self.slots, self.mesos, self.equipment
        self._observe(data, session)
        if before != (self.session, self.slots, self.mesos, self.equipment):
            self.revision += 1

    def _observe(self, data, session):
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
                return
            try:
                start, _ = _ordinary(data, self.capacities)
                self.worn, self.equipment = equipment_bag(
                    data, 368+inventory_shift(data), start-2, self.capacities[0])
            except (ValueError, struct.error, IndexError):
                self.worn = self.equipment = None
            return
        if session != self.session:
            return
        if opcode == 0x72:
            if self.slots is None:
                return
            try:
                self.update(data)
                self.observed_at = int(time.time())
            except (ValueError, struct.error, KeyError, IndexError) as error:
                # An unknown item update does not invalidate independently
                # observed currency; missing bags remain unknown, never zero.
                self.slots = self.equipment = self.worn = None
                # Into the client log (sent with diagnostics): a new kind of change can be
                # read from it without waiting for a player to report it. Item updates
                # carry item IDs and counts, nothing that names the player.
                print(json.dumps(dict(time=time.time(), event='inventory_unread', reason=str(error)[:80],
                                      length=len(data), head=bytes(data[:96]).hex())), flush=True)
        elif opcode == 0x7e:
            envelope = stat_header(data)
            values = parse_stat(data, {MESO_BIT: 8})
            if values is not None and MESO_BIT in values:
                balance = values[MESO_BIT]
                self.mesos = balance if balance <= 10**12 else None
                self.observed_at = int(time.time())
            elif not (envelope and not (envelope[0] & (1 << MESO_BIT))):
                # Unknown stat masks cannot leave a possibly changed balance
                # labelled current. Never infer it from the purchase budget.
                self.mesos = None

    def update(self, data):
        # Equipment refresh + equip/unequip, with an opaque final sequence byte.
        # Observed as mode 5 refreshes of the moved pieces followed by a mode 2
        # move: one refresh (the source slot), or two when two pieces trade
        # places (2026-11-15 live: a worn cape and the bag cape, count 3).
        # Bound each record by the next operation, never scan its body for
        # apparent item operations. Ordinary bags are unaffected.
        if (len(data) >= 70 and data[2:4] == bytes([1, 1]) and data[8] == 0
                and data[9:11] == bytes([5, 1]) and data[-7:-5] == bytes([2, 1])):
            count = struct.unpack_from('<I', data, 4)[0]
            source, destination = struct.unpack_from('<hh', data, len(data)-5)
            if (count not in (2, 3) or not source or not destination or abs(destination) > 1000
                    or source > self.capacities[0] or destination > self.capacities[0]):
                raise ValueError('Invalid equipment refresh/move')
            starts = [11]
            if count == 3:
                # The second refresh is the other slot of the move, as "05 01" and a valid record.
                first = equip_header(data, 11)
                other = destination if first and first[0] == source else source
                second = next((p for p in range(41, len(data)-7-30)
                               if data[p:p+2] == bytes([5, 1]) and (equip_header(data, p+2) or (None,))[0] == other), None)
                if second is None:
                    raise ValueError('Invalid equipment refresh/move')
                starts.append(second+2)
            ends = [start-2 for start in starts[1:]] + [len(data)-7]
            records = [(equip_header(data, start), start, end) for start, end in zip(starts, ends)]
            if any(not found or found[0] not in (source, destination) for found, _, _ in records)                     or records[0][0][0] != source:
                raise ValueError('Invalid equipment refresh/move')
            if self.equipment is not None and self.worn is not None:
                bag, worn = dict(self.equipment), dict(self.worn)
                for (slot, item, _), start, end in records:
                    (bag if slot > 0 else worn)[abs(slot)] = equip_record(data, start, end, abs(slot), item)
                first, a = (bag, source) if source > 0 else (worn, -source)
                second, b = (bag, destination) if destination > 0 else (worn, -destination)
                moved = first.pop(a)
                if b in second:
                    first[a] = dict(second.pop(b), slot=a)
                second[b] = dict(moved, slot=b)
                self.equipment, self.worn = bag, worn
            return
        if len(data) < 9 or data[2] not in (0, 1) or data[3] not in (0, 1):
            raise ValueError('Unsupported inventory update')
        count = struct.unpack_from('<I', data, 4)[0]
        if count > 1000 or data[8] != 0:
            raise ValueError('Unsupported update envelope')
        # Byte 3 set: the records are followed by one opaque sequence byte, as in the
        # equipment refresh/move above (2026-11-25 live: a cash-equipment piece moved onto
        # a worn cash slot, "01 01", one mode 2 record in bag 6, then the byte; reading it
        # as a record blinded the run and stopped potion counting until a channel change).
        if data[3] == 1:
            if len(data) < 10:
                raise ValueError('Unsupported update envelope')
            data = data[:-1]
        # The pet refresh sent immediately after entering a channel removes
        # and re-adds one cash slot. Both operations are wholly outside the
        # tracked bags. Validate its complete envelope before ignoring it.
        if (count == 2 and len(data) == 92 and data[9:11] == bytes([3, 5])
                and data[13:15] == bytes([0, 5]) and data[11:13] == data[15:17]
                and 1 <= int.from_bytes(data[11:13], 'little') <= self.capacities[4]
                and data[17] == 3 and int.from_bytes(data[18:22], 'little')//1000000 == 5
                and data[22] == 1):
            return
        bag = None if self.equipment is None else dict(self.equipment)
        worn = None if self.worn is None else dict(self.worn)
        self.slots, self.equipment, self.worn = self._records(data, 9, 0, count, dict(self.slots), bag, worn)

    def _records(self, data, pos, first, count, slots, bag, worn):
        """Records first..count-1 from `pos`, which must end exactly at the message's end:
        (slots, bag, worn) after them, or ValueError when they cannot be read safely.

        Only the use/setup/etc bags (2-4) and equipment (1) are tracked. A change we cannot
        read in them makes the bags unknown until the next snapshot. Changes in the bags we
        do not track (5 cash, 6 cash equipment) are stepped over, so a cash item, pet or
        cape never blinds the run (2026-11-16: a teammate was told to change channel every
        ~20 minutes): an unknown operation or an add is skipped when it ends the message;
        a pet add is a fixed 75 bytes (the single pet refresh above: 92 = 9 + 4 + 4 + 75);
        any other add ends where the rest of the message parses to its end, which must be
        exactly one place."""
        for index in range(first, count):
            mode, category, slot = struct.unpack_from('<BBh', data, pos)
            pos += 4
            if category == 1:
                if not slot or abs(slot) > 1000 or slot > self.capacities[0]:
                    raise ValueError('Unsupported equipment slot')
                place = (lambda n: (bag, n) if n > 0 else (worn, -n))
                if mode == 0:
                    # The record length is only known when it runs to the end.
                    kind, item, cash = struct.unpack_from('<BIB', data, pos)
                    if index != count-1 or kind != 1 or item//1000000 != 1 or cash != 0:
                        raise ValueError('Unsupported equipment add')
                    found = equip_header(data, pos-2)
                    if found and found[0] == slot and bag is not None:
                        target, n = place(slot)
                        target[n] = equip_record(data, pos-2, len(data), n, found[1])
                    elif bag is not None:
                        # An unreadable piece leaves the ordinary bags as they are.
                        bag = worn = None
                    pos = len(data)
                elif mode == 2:
                    dest = struct.unpack_from('<h', data, pos)[0]
                    pos += 2
                    if not dest or abs(dest) > 1000 or dest > self.capacities[0]:
                        raise ValueError('Unsupported equipment destination')
                    if bag is not None:
                        (source, a), (target, b) = place(slot), place(dest)
                        if a not in source:
                            bag = worn = None
                        else:
                            moved = source.pop(a)
                            if b in target:
                                source[a] = dict(target.pop(b), slot=a)
                            target[b] = dict(moved, slot=b)
                elif mode == 3:
                    if bag is not None:
                        target, n = place(slot)
                        if target.pop(n, None) is None:
                            bag = worn = None
                else:
                    raise ValueError('Unsupported equipment operation')
                continue
            if category in UNTRACKED:
                if not 1 <= slot <= self.capacities[category-1]:
                    raise ValueError('Unsupported cash slot')
                if mode in (1, 2):
                    pos += 2
                elif mode == 3:
                    pass
                elif index == count-1:
                    pos = len(data)   # an add or an unknown operation, last: nothing tracked after it
                elif (mode == 0 and pos + 75 <= len(data) and data[pos] == 3
                      and int.from_bytes(data[pos+1:pos+5], 'little')//1000000 == 5 and data[pos+5] == 1):
                    pos += 75
                elif mode == 0:
                    found = []
                    for start in range(pos + 6, len(data) - 3):
                        try:
                            found.append(self._records(data, start, index+1, count, dict(slots),
                                                       None if bag is None else dict(bag),
                                                       None if worn is None else dict(worn)))
                        except (ValueError, struct.error, KeyError, IndexError):
                            continue
                        if len(found) > 1:
                            break
                    if len(found) != 1:
                        raise ValueError('Cash record boundary missing or ambiguous')
                    return found[0]
                else:
                    raise ValueError('Unsupported cash operation')
                continue
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
                if not quantity and slots[key][0]//10000 not in (207, 233):
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
        return slots, bag, worn

    def view(self):
        if self.slots is None and self.mesos is None:
            return None
        totals = collections.Counter()
        for item, quantity in (self.slots or {}).values():
            totals[item] += quantity
        view = dict(session=self.session, revision=self.revision, observed_at=self.observed_at, mesos=self.mesos, categories=[2, 3, 4] if self.slots is not None else [],
                    items=[dict(item_id=item, quantity=quantity) for item, quantity in sorted(totals.items())])
        # The equipment bag is a separate field: sweep checks read only `items`.
        if self.equipment is not None and self.slots is not None:
            view['equipment'] = [self.equipment[slot] for slot in sorted(self.equipment)]
        return view


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
