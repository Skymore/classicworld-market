"""The player's own pets from the server's messages, for the overlay's feeding reminder.

A pet is a cash item (kind 3, item 500xxxx). Its record (2026-11-16 recordings):

    kind 3 | item (4) | cash 1 | serial (8) | expiry (8) | ff ff ff ff | ? (1) |
    name (13) | level (1) | closeness (2) | fullness (1, 0-100) | ...

The full character snapshot (login, channel change) lists the pets the character owns.
While a pet is out the server sends its record again, refreshing its cash slot (0x72),
every time fullness drops by one: about once a minute (faster for some pets). At 0 the
game sends the pet back to the bag: one last record with fullness 5 and closeness one
lower (a teammate's Black Pig: full 1 -> 5, closeness 199 -> 198, then no more records).
A pet recalled by hand sends nothing we know of, so a pet unheard of for OUT_SECONDS is
taken as back in the bag.
"""
import time

PET_MIN, PET_MAX = 5000000, 5010000
OUT_SECONDS = 180       # three missed fullness drops
HUNGRY = 20             # fullness under this: "宠物饿了，请喂食"


def records(data):
    """[(serial, item, name, level, closeness, fullness)] of the pet records in a message."""
    found = []
    pos = 2
    while pos <= len(data) - 44:
        if (data[pos] == 3 and data[pos + 5] == 1 and data[pos + 22:pos + 26] == b'\xff\xff\xff\xff'
                and PET_MIN <= int.from_bytes(data[pos + 1:pos + 5], 'little') < PET_MAX):
            fullness = data[pos + 43]
            if fullness <= 100:
                name = bytes(data[pos + 27:pos + 40]).split(b'\0')[0].decode('utf-8', 'replace')
                found.append((bytes(data[pos + 6:pos + 14]).hex(), int.from_bytes(data[pos + 1:pos + 5], 'little'),
                              name, data[pos + 40], int.from_bytes(data[pos + 41:pos + 43], 'little'), fullness))
                pos += 44
                continue
        pos += 1
    return found


def observe(pets, data, snapshot, now=None):
    """Update `pets` (serial -> state) from one server message. A snapshot lists the pets
    owned: new ones start in the bag, known ones keep what their records said (a refresh
    follows a snapshot within the second, and a player changing channel every few seconds
    made them flicker out of the bag, 2026-11-16). A refresh means that pet is out, unless
    it is the hunger return (fullness back up to 5 with closeness down); the same record
    sent again right after that does not bring it back out."""
    now = time.time() if now is None else now
    found = records(data)
    if snapshot:
        if found:
            for serial in [s for s in pets if s not in {f[0] for f in found}]:
                del pets[serial]   # given away or deleted
        for serial, item, name, level, closeness, fullness in found:
            pet = pets.setdefault(serial, dict(out=False, seen_at=None))
            pet.update(item_id=item, name=name, level=level, closeness=closeness, fullness=fullness)
        return bool(found)
    for serial, item, name, level, closeness, fullness in found:
        old = pets.get(serial) or {}
        state = dict(item_id=item, name=name, level=level, closeness=closeness, fullness=fullness)
        went_home = (old.get('out') and old.get('closeness') is not None and closeness < old['closeness']
                     and old.get('fullness') is not None and fullness > old['fullness'] and fullness <= 5)
        echo = (old.get('home_at') is not None and now - old['home_at'] <= 10
                and (old.get('closeness'), old.get('fullness')) == (closeness, fullness))
        if went_home or echo:
            pets[serial] = dict(state, out=False, seen_at=None, home_at=old.get('home_at') if echo else now)
        else:
            pets[serial] = dict(state, out=True, seen_at=now, home_at=None)
    return bool(found)


def view(pets, now=None):
    """The pets for the overlay: out ones first, each with fullness and whether it is out."""
    now = time.time() if now is None else now
    rows = []
    for serial, pet in pets.items():
        if 'item_id' not in pet:
            continue
        out = bool(pet.get('out') and pet.get('seen_at') is not None and now - pet['seen_at'] <= OUT_SECONDS)
        rows.append(dict(serial=serial, item_id=pet['item_id'], name=pet.get('name'), level=pet.get('level'),
                         fullness=pet.get('fullness'), out=out, hungry=out and (pet.get('fullness') or 0) < HUNGRY))
    return sorted(rows, key=lambda r: (not r['out'], r['serial']))
