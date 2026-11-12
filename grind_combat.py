"""Bounded combat layouts verified against local Classic World captures.

Damage is the attack's reported damage, including overkill, not inferred HP
loss. Remote attacks are broadcasts visible to this client, not global party
telemetry. No player names or damage events are sent to the website.
"""
import collections
import struct

REMOTE_ATTACKS = (0x2A8, 0x2A9, 0x2AA)
PARTY = 0xA7
WINDOW = 30
MAX_DAMAGE = 10**12


def number(data, at, size=4, signed=False):
    if at < 0 or at + size > len(data):
        raise ValueError('Truncated combat field')
    return int.from_bytes(data[at:at+size], 'little', signed=signed)


def attack(data, index=None):
    """{actor, skill, targets: [(object, [damage...])]} or None.

    Local: a length-prefixed action label at 84, then a fixed 29-byte header;
    each target has ID, template, hit count, ten bytes per hit and a 90-byte
    trailer. Remote: a 63-byte header; target ID, hit count and two flags,
    ten bytes per hit, six-byte trailer. Validate the exact end of the frame.
    """
    try:
        local = index is not None
        if local:
            if index not in (26, 27):
                return None  # own magic layout has no capture evidence yet
            length = number(data, 84, 2)
            label = data[86:86+length]
            if label not in (b'User Melee', b'User Melee Skill System', b'User Shoot'):
                return None
            pos = 115 + length
            count = number(data, pos - 12)
            if count != number(data, 3, 1):
                return None
            actor, skill = None, number(data, 4)
        else:
            if number(data, 0, 2) not in REMOTE_ATTACKS:
                return None
            actor, skill = number(data, 2), number(data, 8)
            count, pos = number(data, 51), 63
        if not 0 <= count <= 15:
            return None
        targets = []
        for _ in range(count):
            oid = number(data, pos)
            hits = number(data, pos + (8 if local else 4), 2)
            if not oid or not 1 <= hits <= 30:
                return None
            start = pos + (11 if local else 8)
            amounts = [number(data, start + i * 10, 8) for i in range(hits)]
            if any(d > MAX_DAMAGE for d in amounts):
                return None
            targets.append((oid, amounts))
            pos += (100 if local else 14) + 10 * hits
        if local:
            pos += 13 if skill else 5
        if pos != len(data):
            return None
        return dict(actor=actor, skill=skill, targets=targets)
    except (ValueError, IndexError, struct.error):
        return None


def party(data, self_id):
    """Roster from a complete PartyInfo; None means an unsupported layout.

    Avatar blocks vary with equipped appearance. Extract only their strongly
    bounded member cores, never names from arbitrary traffic: require a known
    PartyInfo envelope, its complete title/footer, a unique self entry, valid
    character/job/level/channel fields and separated appearance blocks.
    """
    try:
        if number(data, 0, 2) != PARTY or self_id is None:
            return None
        kind = number(data, 2, 1)
        if kind == 0x0D and number(data, 3, 1) == 1:
            start = 9
        elif kind == 0x13:
            start = 10 + number(data, 3, 2)
        elif kind == 0x10:
            if number(data, 3) == self_id:
                return {}
            start = 16 + number(data, 9, 2)
        else:
            return None
        if not 160 <= len(data) <= 16384 or data[-2:] != b'\x01\x00':
            return None
        # Six map IDs and six 20-byte portal records precede the party title.
        endings = []
        for at in range(max(start, len(data) - 104), len(data) - 3):
            size = number(data, at, 2)
            if 1 <= size <= 100 and at + 2 + size + 2 == len(data):
                try:
                    title = data[at+2:at+2+size].decode('utf-8')
                except UnicodeError:
                    continue
                if title.isprintable():
                    endings.append(at - 144)
        if len(endings) != 1:
            return None
        end = endings[0] - 8  # leader ID and reserved word
        found = []
        for at in range(start, end - 26):
            ident, size = number(data, at), number(data, at + 4, 2)
            if not 1 <= ident < 2**31 or not 1 <= size <= 13:
                continue
            pos = at + 6 + size
            if pos + 21 > end:
                continue
            try:
                name = data[at+6:pos].decode('utf-8')
            except UnicodeError:
                continue
            job, level, channel = number(data, pos, 8), number(data, pos+8), number(data, pos+12, signed=True)
            valid_job = job == 0 or (job // 100 in range(1, 6) and job % 100 in (0, 10, 11, 12, 20, 21, 22, 30, 31, 32))
            if (name.isprintable() and valid_job and 1 <= level <= 200 and -2 <= channel <= 100
                    and data[pos+16:pos+21] == bytes(5)):
                found.append((at, dict(id=ident, name=name, job=job, level=level, channel=channel)))
        if (not 1 <= len(found) <= 6 or found[0][0] != start
                or any(b[0] - a[0] < 100 for a, b in zip(found, found[1:]))):
            return None
        rows = {r['id']: r for _, r in found}
        if len(rows) != len(found) or self_id not in rows:
            return None
        return rows
    except (ValueError, IndexError):
        return None


class Meter:
    def __init__(self, saved=None):
        self.players = {}
        for key, row in (saved or {}).items():
            self.players[int(key)] = dict(row, events=collections.deque(row.get('events', []), maxlen=4000))

    def player(self, ident, name, own=False):
        row = self.players.setdefault(ident, dict(name=name, own=own, damage=0, kills=0, hits=0,
                                                known=False, partial=False, started_at=None, active_start=0,
                                                events=collections.deque(maxlen=4000)))
        row.update(name=name, own=own)
        return row

    def damage(self, ident, name, own, targets, now, active=0):
        row = self.player(ident, name, own)
        if row.get('started_at') is None:
            row.update(started_at=now, active_start=active)
        amount = sum(sum(hits) for _, hits in targets)
        row['damage'] += amount
        row['hits'] += sum(len(hits) for _, hits in targets)
        row['known'] = True
        row['events'].append((now, amount))

    def kill(self, ident, name, own=False):
        self.player(ident, name, own)['kills'] += 1

    def to_json(self):
        return {str(k): dict(v, events=list(v['events'])) for k, v in self.players.items()}

    def rows(self, now, active, started, running, self_id=None, self_kills=None, roster=None):
        result = []
        for ident, row in self.players.items():
            while row['events'] and now - row['events'][0][0] > WINDOW:
                row['events'].popleft()
            span = min(WINDOW, max(1, now - (row.get('started_at') or started)))
            observed_active = max(1, active - row.get('active_start', 0))
            member = (roster or {}).get(ident)
            me = (roster or {}).get(self_id)
            away = not row['own'] and (roster is None or not member or (me and member['channel'] != me['channel']))
            known = row['known'] and not row['partial']
            result.append(dict(character_id=ident, name=row['name'], self=row['own'], away=bool(away),
                               damage=row['damage'] if row['known'] else None,
                               dps=(sum(x for _, x in row['events']) / span) if known and running and not away else None,
                               average_dps=(row['damage'] / observed_active) if known and active else None,
                               kills=self_kills if row['own'] and self_kills is not None else row['kills'],
                               hits=row['hits'], partial=row['partial']))
        return sorted(result, key=lambda r: (not r['self'], r['away'], -(r['damage'] or 0), r['name'] or ''))
