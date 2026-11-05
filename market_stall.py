"""Where a shop stands and how it looks, from the decoded game stream.

A player-store owner cannot move while the store is open, so the owner's
position in the map-entry record (0x22d, legacy 0x22a) is the stall's
position, in world pixels. The same record ends with the owner's mini-room
balloon: type 3, store serial, a constant 2, the store title, and the store
permit item (514xxxx) that sets the stall's look. The sign packet (0x23d,
legacy 0x23a) repeats that balloon by character ID when a store opens or
closes after the map entry.

Layout checked on 41 store owners in recorded Free Market sessions: the
position is the first `ff ff` + eight zero bytes + x, y (int16) + stance
(4 or 5, standing) + foothold before the balloon; pets sit in between and
carry their own positions, so the first match is the owner's. Anything that
does not fit returns nothing.
"""
import re

PARSER = 'cw_stall_v1'
ENTRY = (0x22A, 0x22D)
SIGN = (0x23A, 0x23D)
_BALLOON = re.compile(rb'\x03\x00\x00\x00(.{4})\x02\x00\x00\x00(.{2})', re.S)
_POSITION = re.compile(rb'\xff\xff\x00{8}(.{2})(.{2})[\x04\x05](.{2})', re.S)


def _permit(value):
    return value if 5140000 <= value <= 5149999 else None


def balloon(body, start=0):
    """(start, title, permit) of the last store balloon in body, or None."""
    found = None
    for match in _BALLOON.finditer(body, start):
        size = int.from_bytes(match[2], 'little')
        end = match.end() + size
        if not 1 <= size <= 120 or end + 4 > len(body):
            continue
        permit = _permit(int.from_bytes(body[end:end+4], 'little'))
        if permit is None:
            continue
        try:
            title = body[match.end():end].decode('utf-8')
        except UnicodeError:
            continue
        found = (match.start(), title, permit)
    return found


def entry_character(body):
    """The persistent character ID of a player-entry record (see market_presence)."""
    for offset in (6, 10):
        if len(body) < offset + 18 or (offset == 10 and body[6:10] != bytes(4)):
            continue
        character_id = int.from_bytes(body[offset:offset+4], 'little')
        size = int.from_bytes(body[offset+12:offset+14], 'little')
        name = body[offset+14:offset+14+size]
        if (body[offset+4:offset+8] == bytes(4) and character_id and 1 <= size <= 24
                and len(name) == size and re.fullmatch(rb'[A-Za-z0-9_]+', name)):
            return character_id
    return None


def parse_entry(body):
    """{character_id, x, y, permit, title} for a store owner's entry, else None."""
    if int.from_bytes(body[:2], 'little') not in ENTRY:
        return None
    character_id = entry_character(body)
    shop = balloon(body)
    if character_id is None or shop is None:
        return None
    start, title, permit = shop
    position = _POSITION.search(body, 0, start)
    if position is None:
        return None
    x = int.from_bytes(position[1], 'little', signed=True)
    y = int.from_bytes(position[2], 'little', signed=True)
    # Free Market rooms span about -700..1700 x and -1100..1800 y.
    if not (-4000 <= x <= 4000 and -4000 <= y <= 4000):
        return None
    return dict(character_id=character_id, x=x, y=y, permit=permit, title=title)


def parse_sign(body):
    """(character_id, title, permit) when a store opens; (character_id, None, None) when it closes."""
    if int.from_bytes(body[:2], 'little') not in SIGN or len(body) < 24:
        return None
    character_id = int.from_bytes(body[2:6], 'little')
    if not character_id:
        return None
    if body[6:] == bytes(len(body) - 6):
        return character_id, None, None
    shop = balloon(body, 6)
    if shop is None or shop[0] != 6:
        return None
    return character_id, shop[1], shop[2]


class StallTracker:
    """Stalls of the current map, by owner character ID. Cleared on map entry."""

    def __init__(self):
        self.positions = {}
        self.signs = {}

    def clear(self):
        self.positions.clear()
        self.signs.clear()

    def observe(self, body):
        op = int.from_bytes(body[:2], 'little')
        if op in ENTRY:
            stall = parse_entry(body)
            character_id = stall['character_id'] if stall else entry_character(body)
            if stall:
                self.positions[character_id] = (stall['x'], stall['y'])
                self.signs[character_id] = (stall['title'], stall['permit'])
            elif character_id is not None:
                # A player who entered without a store: any position we had is stale.
                self.positions.pop(character_id, None)
                self.signs.pop(character_id, None)
        elif op in SIGN:
            sign = parse_sign(body)
            if sign is None:
                return
            character_id, title, permit = sign
            if title is None:
                # Closed: the owner may walk off and open elsewhere, where only
                # a new map entry tells the position again.
                self.signs.pop(character_id, None)
                self.positions.pop(character_id, None)
            else:
                self.signs[character_id] = (title, permit)

    def stall(self, character_id, title):
        """The upload's `stall` for this owner's store, when position and title agree."""
        position = self.positions.get(character_id)
        sign = self.signs.get(character_id)
        if position is None or sign is None or sign[0] != title:
            return None
        return dict(x=position[0], y=position[1], permit=sign[1], parser=PARSER)
