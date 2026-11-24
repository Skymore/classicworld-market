"""Server message numbers across game versions: the collector's parsers speak the numbering
of the game before 2026-11-18; messages of a newer game are renumbered to it here.

The 2026-11-18 update (Forgotten Hollow, new shops, the Moon Bunny party quest) added and
removed server messages, so whole blocks of numbers moved, each by its own amount. The
blocks below were read off recordings from both sides of the update (same sizes, same
contents, counts that match): the snapshot on entering a channel 0x1A9 -> 0x1A5, mobs
appearing 0x3C9 -> 0x3C4, leaving 0x3D4 -> 0x3CF, hit 0x44D -> 0x448, an item dropping
0x471 -> 0x46D and leaving the ground 0x472 -> 0x470, the key table 0x5F5 -> 0x5F3...
The 2026-11-24 update moved everything from the 0x44D-0x44E region on by one more (the
key table 0x5F3 -> 0x5F2, so scans stopped at "key table format not supported"), and the
player's mapping indexes from the 830s on by one more.
Between two blocks that moved by different amounts the game inserted or removed messages;
numbers there are not mapped. An unmapped number becomes UNKNOWN | number, which no parser
reads, so a new message can never pass for the old one that happened to have its number.

Recordings keep what the collector saw, marked "n" with the version whose numbering it
renumbered with (1 = the 2026-11-18 game's map; grind_frames); a line marked with an older
version than the game it was received from goes back to the game's number and is renumbered
again when it is replayed, so recordings from before each update keep their old rules.
"""

UNKNOWN = 0xF000

# (first old number, last old number, shift): old + shift is the number in that game.
# Old = the game before 2026-11-18, the numbering every parser reads.
BLOCKS_1118 = (
    (0x000, 0x0A9, 0),
    (0x0AD, 0x0CB, -1),
    (0x18C, 0x22F, -4),
    (0x279, 0x2BC, -3),
    (0x3C9, 0x44D, -5),
    (0x471, 0x471, -4),
    (0x472, 0x62E, -2),   # stalls 0x577-0x57B: seen after 2026-11-24 with this block
)
BLOCKS_1124 = (
    (0x000, 0x0A9, 0),
    (0x0AD, 0x0CB, -1),
    (0x18C, 0x22F, -4),
    (0x279, 0x2BC, -3),
    (0x3C9, 0x44D, -6),   # mobs: assumed with the block above them, not yet seen after 11-24
    (0x471, 0x471, -5),   # an item dropping
    (0x472, 0x62E, -3),   # leaving the ground, stalls 0x577-0x57B, the key table 0x5F5
)

# The player's own messages are found by their index in the mapping table the server sends
# (0x32), and the updates moved those too (2026-11-21, a pet's potion: 321 -> 319, so no pet
# potion was counted): (first old index, last old index, shift), read off the same way.
CLIENT_BLOCKS_1118 = (
    (0, 191, 0),          # moving 20, attacks 26-28, potions by hand 73, skills 119, stalls 186
    (207, 567, -2),       # key settings 212 -> 210, a pet's potion 321 -> 319
    (607, 867, -1),
)
CLIENT_BLOCKS_1124 = (
    (0, 191, 0),
    (207, 531, -2),       # unchanged since 2026-11-18 as far as seen (up to 529)
    (831, 867, -2),       # 830s on: one more
)

# The updates went live between these (local time, our recordings).
# 2026-11-18: the last snapshot with the old number at 05:03:53, the first new at 20:07:57.
# 2026-11-24: the last old recording at 07:00:35, the first new one at 12:28:51.
UPDATE_AT = 1795007100.0
UPDATE_AT_1124 = 1795536000.0   # 2026-11-24 08:00 local (PST), in the maintenance


def _maps(blocks):
    new_to_old = {old + shift: old for first, last, shift in blocks for old in range(first, last + 1)}
    return new_to_old, {old: new for new, old in new_to_old.items()}


# Version n (1-based): what the game of that version sends -> the old numbering, and back.
VERSIONS = (
    (UPDATE_AT, _maps(BLOCKS_1118), _maps(CLIENT_BLOCKS_1118)),
    (UPDATE_AT_1124, _maps(BLOCKS_1124), _maps(CLIENT_BLOCKS_1124)),
)
LATEST = len(VERSIONS)
# The latest game's maps (older callers and tests read these).
NEW_TO_OLD = VERSIONS[-1][1][0]
CLIENT_NEW_TO_OLD = VERSIONS[-1][2][0]


def version(stamp=None):
    """Which game sent a message received at `stamp` (0: before 2026-11-18; None: now)."""
    if stamp is None:
        import time
        stamp = time.time()
    return sum(1 for at, _, _ in VERSIONS if stamp >= at)


def _forward(table, number):
    return table.get(number, UNKNOWN | number)


def _back(table, number):
    if number & 0xF000 == UNKNOWN:
        return number & 0x0FFF
    return table.get(number, number)


def renumber(opcode, game=None):
    """The old number for a message of game version `game` (default: the latest)."""
    return _forward(VERSIONS[(game or LATEST) - 1][1][0], opcode)


def client_index(index, game=None):
    """The old mapping-table index for one of the player's messages to game version `game`
    (default: the latest; UNKNOWN | index when not mapped)."""
    return _forward(VERSIONS[(game or LATEST) - 1][2][0], index)


def original_index(index, game):
    """The index game version `game` used, for an index renumbered with its map."""
    return _back(VERSIONS[game - 1][2][1], index)


def _replace(plain, opcode):
    return opcode.to_bytes(2, 'little') + bytes(plain[2:])


def normalize(plain, game=None):
    """A server message of game version `game` (default: the latest) in the old numbering."""
    if len(plain) < 2:
        return plain
    opcode = int.from_bytes(plain[:2], 'little')
    old = renumber(opcode, game)
    return plain if old == opcode else _replace(plain, old)


def original(plain, game):
    """The message game version `game` sent, for one renumbered with its map."""
    if len(plain) < 2:
        return plain
    opcode = int.from_bytes(plain[:2], 'little')
    sent = _back(VERSIONS[game - 1][1][1], opcode)
    return plain if sent == opcode else _replace(plain, sent)


def new_game(stamp):
    """Whether a message received at `stamp` came from an updated game (renumber it)."""
    return version(stamp) > 0
