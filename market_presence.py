"""Explicit player departures only; silence, map changes and disconnects are not departures."""
import re


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
            # Entity handle at +2 is NOT the persistent character id at +6.
            if len(body) < 24:
                return None
            character_id = int.from_bytes(body[6:10], 'little')
            size = int.from_bytes(body[18:20], 'little')
            name = body[20:20+size]
            if (body[10:14] != bytes(4) or not character_id or
                    not 1 <= size <= 24 or len(name) != size or not re.fullmatch(rb'[A-Za-z0-9_]+', name)):
                return None
            self.players[character_id] = (name.decode('ascii'), now)
        elif op in (0x22B, 0x22E) and len(body) == 6:
            character_id = int.from_bytes(body[2:6], 'little')
            previous = self.players.pop(character_id, None)
            if previous is not None:
                name, seen = previous
                return dict(character_id=character_id, name=name, seen_at=seen,
                            observed_at=now, parser='cw_player_departure_v1')
        return None
