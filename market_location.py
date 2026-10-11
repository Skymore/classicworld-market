"""Passive map observations. Unknown packet layouts invalidate the old location."""
import struct
import json
from bisect import bisect_right

MAP_ENTRY = 0x1A6


def inspect_map(plain, packet_length=None):
    if len(plain) < 2 or int.from_bytes(plain[:2], 'little') != MAP_ENTRY:
        raise ValueError('Not a map entry')
    # Keep bounded structural evidence for validating the short portal format.
    evidence = dict(length=len(plain), prefix_hex=plain[:320].hex(),
                    candidates=[dict(offset=i, map_id=struct.unpack_from('<I', plain, i)[0])
                        for i in range(min(len(plain)-3, 320))
                        if 80002000 <= struct.unpack_from('<I', plain, i)[0] <= 80002022])
    channel = int.from_bytes(plain[10:14], 'little') + 1 if len(plain) >= 14 else None
    evidence['channel_candidate'] = channel if channel and 1 <= channel <= 18 else None
    # Two complete channel-entry captures agree on this layout. Portal messages
    # remain unknown until an actual portal transition has been checked.
    location = None
    size = len(plain) if packet_length is None else packet_length
    offset = None
    parser = None
    if size >= 512 and len(plain) >= 251 and plain[14:24] == bytes.fromhex('00000000000100000000'):
        offset, parser = 247, 'channel_entry_v1'
    elif size == 103 and len(plain) >= 103 and plain[14:19] == bytes(5) and plain[32:36] == bytes(4):
        offset, parser = 36, 'portal_entry_v1'
    if offset is not None:
        map_id = int.from_bytes(plain[offset:offset+4], 'little')
        if evidence['channel_candidate'] and 80002000 <= map_id <= 80002022:
            location = dict(channel=channel, room=map_id-80002000, map_id=map_id,
                            source='server_map_entry', parser=parser,
                            validation='live_route_verified')
    return location, evidence


class LocationTimeline:
    """Recompute derived locations without changing immutable capture files."""
    def __init__(self, path):
        self.sessions = {}
        try:
            lines = path.read_text(encoding='utf-8').splitlines()
        except OSError:
            lines = []
        for line in lines:
            try:
                record = json.loads(line)
                proof = record['evidence']
                location, _ = inspect_map(bytes.fromhex(proof['prefix_hex']), proof['length'])
                if location:
                    location.update(time=record['time'], session=record['session'])
                self.sessions.setdefault(record['session'], []).append((record['time'], location))
            except (ValueError, KeyError, TypeError):
                continue
        for entries in self.sessions.values():
            entries.sort(key=lambda x: x[0])

    def resolve(self, session, timestamp, fallback=None):
        entries = self.sessions.get(session, [])
        index = bisect_right([x[0] for x in entries], timestamp)-1
        return entries[index][1] if index >= 0 else fallback
