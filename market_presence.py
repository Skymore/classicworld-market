"""Player departures and structurally complete map-entry rosters; never timeout absence."""
import re


def roster_payload(data):
    from shared_protocol import integer, text
    if (data.get('version') != 1 or data.get('parser') != 'cw_room_roster_v1'
            or data.get('world') != 'ClassicWorld' or data.get('complete') is not True):
        raise ValueError('Unsupported roster evidence')
    ids = data['character_ids']
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500:
        raise ValueError('Invalid roster size')
    ids = [integer(value, 1, 2**32-1) for value in ids]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate roster identity')
    location = data['location']
    return dict(version=1, world='ClassicWorld', parser='cw_room_roster_v1', complete=True,
                event_id=text(data['event_id'], 32), started_at=float(data['started_at']),
                observed_at=float(data['observed_at']), character_ids=ids,
                location=dict(channel=integer(location['channel'], 1, 255),
                              room=integer(location['room'], 1, 22)))


class RoomRoster:
    """A strict, ordered initialization envelope on the lossless decoded stream.

    The local player is not sent as a remote-player entry; include its identity
    from the validated long map-entry layout. Short portal entries retain it.
    Unknown layouts, malformed players, interleaved messages and missing suffix
    packets fail closed. Silence can never complete a roster.
    """
    suffix = ((0x209, 12), (0xAE, 4), (0x82, 2), (0x20F, 7), (0x211, 6))

    def __init__(self):
        self.self_id = None
        self.reset()

    def reset(self):
        self.phase = None
        self.ids = set()
        self.location = None

    def begin(self, plain, location, now):
        self.reset()
        if len(plain) >= 512:
            self.self_id = None
            # Current channel-entry character block: repeated persistent ID,
            # followed by the fixed-width character name (not an entity handle).
            a, b = (int.from_bytes(plain[i:i+4], 'little') for i in (158, 162))
            name = plain[170:183].split(b'\0', 1)[0]
            if (location and location.get('parser') == 'channel_entry_v1'
                    and a == b and a and re.fullmatch(rb'[A-Za-z0-9_]{1,13}', name)):
                self.self_id = a
        if self.self_id and location and 1 <= (location.get('room') or 0) <= 22:
            self.location = {k: location[k] for k in ('channel', 'room')}
            self.started_at = now
            self.phase = 'header'
            self.ids = {self.self_id}

    def observe(self, plain, now):
        if self.phase is None:
            return None
        if now < self.started_at or now - self.started_at > 10:
            self.reset()
            return None
        op = int.from_bytes(plain[:2], 'little')
        if self.phase == 'header':
            if plain == b'\xfa\x01\0':
                self.phase = 'players'
            elif op in (0x22A, 0x22D, 0x22B, 0x22E):
                self.reset()
            return None
        if self.phase == 'players' and op == 0x22D:
            player = PlayerPresence()
            player.observe(plain, now)
            if len(player.players) != 1 or len(self.ids) >= 500:
                self.reset()
            else:
                self.ids.update(player.players)
            return None
        index = 0 if self.phase == 'players' else self.phase
        expected, size = self.suffix[index]
        if (op != expected or len(plain) != size
                or (index >= 2 and plain[2:] != bytes(size - 2))):
            self.reset()
            return None
        self.phase = index + 1
        if self.phase == len(self.suffix):
            result = dict(parser='cw_room_roster_v1', complete=True, location=self.location,
                          started_at=self.started_at, observed_at=now, character_ids=sorted(self.ids))
            self.reset()
            return result


def departure_payload(data):
    """Upload allowlist: no raw bodies, session identifiers or local file paths."""
    from shared_protocol import integer, text
    if data.get('version') != 1 or data.get('parser') != 'cw_player_departure_v1' or data.get('world') != 'ClassicWorld':
        raise ValueError('Unsupported presence evidence')
    location = data['location']
    return dict(version=1, world='ClassicWorld', parser='cw_player_departure_v1',
                event_id=text(data['event_id'], 32), name=text(data['name'], 24),
                character_id=integer(data['character_id'], 1, 2**32-1),
                observed_at=float(data['observed_at']), seen_at=float(data['seen_at']),
                location=dict(channel=integer(location['channel'], 1, 255),
                              room=integer(location['room'], 1, 22)))


class PlayerPresence:
    def __init__(self):
        self.players = {}

    def observe(self, body, now):
        op = int.from_bytes(body[:2], 'little')
        if op in (0x22A, 0x22D):
            # Observed 32/64-bit entity-handle layouts share the same persistent
            # character ID/name structure. Never use the transient handle as ID.
            for offset in (6, 10):
                if len(body) < offset + 18 or (offset == 10 and body[6:10] != bytes(4)):
                    continue
                character_id = int.from_bytes(body[offset:offset+4], 'little')
                size = int.from_bytes(body[offset+12:offset+14], 'little')
                name = body[offset+14:offset+14+size]
                if (body[offset+4:offset+8] == bytes(4) and character_id
                        and 1 <= size <= 24 and len(name) == size and re.fullmatch(rb'[A-Za-z0-9_]+', name)):
                    self.players[character_id] = (name.decode('ascii'), now)
                    break
        elif op in (0x22B, 0x22E) and len(body) == 6:
            character_id = int.from_bytes(body[2:6], 'little')
            previous = self.players.pop(character_id, None)
            if previous is not None:
                name, seen = previous
                return dict(character_id=character_id, name=name, seen_at=seen,
                            observed_at=now, parser='cw_player_departure_v1')
        return None
