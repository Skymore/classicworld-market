"""Server message numbers across game versions: the collector's parsers speak the numbering
of the game before 2026-11-18; messages of a newer game are renumbered to it here.

The 2026-11-18 update (Forgotten Hollow, new shops, the Moon Bunny party quest) added and
removed server messages, so whole blocks of numbers moved, each by its own amount. The
blocks below were read off recordings from both sides of the update (same sizes, same
contents, counts that match): the snapshot on entering a channel 0x1A9 -> 0x1A5, mobs
appearing 0x3C9 -> 0x3C4, leaving 0x3D4 -> 0x3CF, hit 0x44D -> 0x448, an item dropping
0x471 -> 0x46D and leaving the ground 0x472 -> 0x470, the key table 0x5F5 -> 0x5F3...
Between two blocks that moved by different amounts the game inserted or removed messages;
numbers there are not mapped. An unmapped number becomes UNKNOWN | number, which no parser
reads, so a new message can never pass for the old one that happened to have its number.

Recordings keep what the collector saw: before UPDATE_AT the old numbering; after it the
renumbered messages, marked "n" (grind_frames), except those written between the update
and this release, which `normalize` renumbers when they are replayed.
"""

# The update went live between these (2026-11-18 local time, our recordings): the last
# snapshot with the old number at 05:03:53, the first with the new one at 20:07:57.
UPDATE_AT = 1795007100.0
UNKNOWN = 0xF000

# (first old number, last old number, shift): old + shift is the number in the new game.
BLOCKS = (
    (0x000, 0x0A9, 0),
    (0x0AD, 0x0CB, -1),
    (0x18C, 0x22F, -4),
    (0x279, 0x2BC, -3),
    (0x3C9, 0x44D, -5),
    (0x471, 0x471, -4),
    (0x472, 0x62E, -2),   # stalls (0x577-0x57B) assumed with this block: not yet seen after the update
)
# Small-message envelopes that hold their opcode in the first two bytes, little-endian.
NEW_TO_OLD = {old + shift: old for first, last, shift in BLOCKS for old in range(first, last + 1)}


# The player's own messages are found by their index in the mapping table the server sends
# (0x32), and the update moved those too (2026-11-21, a pet's potion: 321 -> 319, so no pet
# potion was counted): (first old index, last old index, shift), read off the same way.
CLIENT_BLOCKS = (
    (0, 191, 0),          # moving 20, attacks 26-28, potions by hand 73, skills 119, stalls 186
    (207, 567, -2),       # key settings 212 -> 210, a pet's potion 321 -> 319
    (607, 867, -1),
)
CLIENT_NEW_TO_OLD = {old + shift: old for first, last, shift in CLIENT_BLOCKS for old in range(first, last + 1)}


def client_index(index):
    """The old mapping-table index for one of the player's messages to the new game
    (UNKNOWN | index when not mapped)."""
    return CLIENT_NEW_TO_OLD.get(index, UNKNOWN | index)


def renumber(opcode):
    """The old number for a message of the new game (UNKNOWN | number when not mapped)."""
    return NEW_TO_OLD.get(opcode, UNKNOWN | opcode)


def normalize(plain):
    """A server message of the new game in the old numbering."""
    if len(plain) < 2:
        return plain
    opcode = int.from_bytes(plain[:2], 'little')
    old = renumber(opcode)
    if old == opcode:
        return plain
    return old.to_bytes(2, 'little') + bytes(plain[2:])


def new_game(stamp):
    """Whether a message received at `stamp` came from the updated game."""
    return stamp >= UPDATE_AT
