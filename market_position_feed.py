"""Follow a local movement diagnostic without restarting its live TCP decoder.

Only derived coordinates are published; diagnostic packet bodies stay local.
"""
import json
import os
import time
from pathlib import Path
from classicworld_codec import opcode_table
from market_movement import MOVEMENT_INDEX, parse_movement


def publish_position(output, state):
    temporary = output.with_name(output.name+'.tmp')
    temporary.write_text(json.dumps(state), encoding='utf-8')
    # Windows readers briefly hold a handle without FILE_SHARE_DELETE.
    for attempt in range(20):
        try:
            os.replace(temporary, output)
            return
        except PermissionError:
            if attempt == 19:raise
            time.sleep(.01)


class PositionTracker:
    def __init__(self):
        self.sessions = {}
        self.active = None
        self.state = dict(valid=False, reason='Waiting for movement', sequence=0)

    def invalidate(self, reason):
        self.state.update(valid=False, reason=reason)

    def consume(self, row):
        event = row['event']; sid = row.get('session')
        if event in ('capture_started', 'capture_stopped'):
            self.invalidate(event)
            if event == 'capture_started':
                self.sessions.clear(); self.active = None
            return
        if event == 'handshake':
            self.sessions[sid] = dict(table=[], location=None, last=None)
            self.active = sid
            self.invalidate('New game connection; waiting for movement')
        session = self.sessions.get(sid)
        if session is None:
            return
        if event in ('invalidated', 'disconnected'):
            session['last'] = None
            if sid == self.active:
                self.invalidate(event)
            return
        if event == 'opcode_map_unparsed':
            session['table'] = opcode_table(bytes.fromhex(row['body']))
        if event == 'location':
            session['location'] = row['location']; session['last'] = None
            if sid == self.active:
                self.invalidate('Map changed; waiting for movement')
        if event != 'message' or sid != self.active:
            return
        self.state['traffic_time'] = row['time']
        table = session['table']
        index = row.get('map_index')
        if index is None and row['opcode'] in table:
            index = table.index(row['opcode'])
        if row['direction'] != 'client' or index != MOVEMENT_INDEX:
            return
        try:
            if not row.get('body'):
                raise ValueError('Movement body unavailable')
            parsed = parse_movement(bytes.fromhex(row['body']))
            location = session['location']
            if not location:
                raise ValueError('Unknown map')
            end = parsed['end']
            # Strict continuity is evidence of complete movement decoding.
            previous = session['last']
            session['last'] = end
            if previous and any(previous[k] != parsed['start'][k] for k in ('x', 'y')):
                raise ValueError('Movement continuity changed; waiting for next report')
            self.state = dict(valid=True, reason=None, session=sid,
                              sequence=self.state['sequence']+1,
                              time=row['time'], traffic_time=row['time'],
                              **location, **end)
            self.state.update(source=parsed['source'], parser=parsed['parser'],
                              validation='movement_continuity_and_map_geometry')
        except ValueError as error:
            session['last'] = None
            self.invalidate(str(error))


def read_position(path, map_id, now=None):
    for attempt in range(20):
        try:
            state = json.loads(Path(path).read_text(encoding='utf-8'))
            break
        except PermissionError:
            if attempt == 19:raise
            time.sleep(.01)
    now = time.time() if now is None else now
    if not state.get('valid'):
        raise ValueError(state.get('reason', 'Position unavailable'))
    if not 0 <= now-state.get('feed_time', 0) <= 2:
        raise ValueError('Position feed stopped')
    if not 0 <= now-state.get('traffic_time', 0) <= 15:
        raise ValueError('No recent game traffic')
    if state.get('map_id') != map_id:
        raise ValueError('Position belongs to a different map')
    return state


def follow(folder, output, seconds=600):
    tracker = PositionTracker()
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with (folder/'movement.jsonl').open(encoding='utf-8') as stream:
        pending = ''
        try:
            while time.monotonic()-started < seconds:
                pending += stream.read()
                lines = pending.split('\n'); pending = lines.pop()
                for line in lines:
                    if not line: continue
                    try:
                        tracker.consume(json.loads(line))
                    except (ValueError, KeyError, TypeError) as error:
                        tracker.invalidate(str(error))
                state = dict(tracker.state, feed_time=time.time())
                publish_position(output,state)
                time.sleep(.1)
        finally:
            tracker.invalidate('Position feed stopped')
            publish_position(output,tracker.state)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('market_data/player_position.json'))
    parser.add_argument('--seconds', type=int, default=600)
    args = parser.parse_args()
    follow(args.folder, args.output, args.seconds)
