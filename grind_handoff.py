"""Local tracker state for an already validated, gap-free connection handoff."""
import collections
import json
import tempfile
from pathlib import Path


def encode(value):
    if isinstance(value, dict):
        return {'dict': [[encode(k), encode(v)] for k, v in value.items()]}
    if isinstance(value, collections.deque):
        return {'deque': [encode(v) for v in value], 'maxlen': value.maxlen}
    if isinstance(value, tuple):
        return {'tuple': [encode(v) for v in value]}
    if isinstance(value, list):
        return [encode(v) for v in value]
    return value


def decode(value):
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        if 'dict' in value:
            return {decode(k): decode(v) for k, v in value['dict']}
        if 'tuple' in value:
            return tuple(decode(v) for v in value['tuple'])
        if 'deque' in value:
            return collections.deque((decode(v) for v in value['deque']), maxlen=value['maxlen'])
        raise ValueError('Unknown tracker state type')
    return value


def snapshot(tracker, sessions):
    return dict(version=1, characters=[dict(session=c.session,
        fields=encode({k: v for k, v in vars(c).items() if k not in ('run', 'session')}),
        run=c.run.to_json() if c.run else None)
        for c in tracker.characters.values() if c.session in sessions])


def restore(tracker, saved, sessions):
    from grind_tracker import Character, Run
    if saved.get('version') != 1:
        raise ValueError('Unknown tracker handoff version')
    characters = {}
    for row in saved['characters']:
        if row['session'] not in sessions:
            continue
        c = Character(row['session'])
        for key, value in decode(row['fields']).items():
            if key in vars(c) and key not in ('session', 'run'):
                setattr(c, key, value)
        c.run = Run.from_json(row['run']) if row.get('run') else None
        characters[c.session] = c
    tracker.characters.update(characters)
    ids = {c.run.id for c in characters.values() if c.run}
    tracker.restored = [r for r in tracker.restored if r.id not in ids]
    tracker.dirty = True


def legacy(tracker, sessions, cutoff):
    """0.7.20 and earlier saved raw frames but not Character state.

    Rebuild only the inherited sessions, stopping at their mapping handshake.
    The existing run ledger remains authoritative; frames only restore parser
    baselines, identity and live combat/BUFF state. No history or uploads change.
    """
    from grind_tracker import Tracker, Run
    from grind_pricing import Prices
    from market_inventory import Inventory
    remaining, records = set(sessions), []
    for path in sorted((tracker.data / 'frames').glob('frames_*.jsonl'), reverse=True):
        if not remaining:
            break
        for line in reversed(path.read_bytes().splitlines()):
            try:
                row = json.loads(line)
                if row.get('s') not in remaining or row['t'] > cutoff:
                    continue
                data = bytes.fromhex(row['h'])
            except (KeyError, ValueError, TypeError):
                continue
            records.append(row)
            if not row.get('c') and data[:2] == b'\x32\0':
                remaining.remove(row['s'])
    if not records:
        return
    with tempfile.TemporaryDirectory(prefix='grind-handoff-') as temporary:
        folder = Path(temporary) / 'grind'
        folder.mkdir()
        settings = dict(tracker.settings, enabled=True, record_frames=False, upload=False)
        (folder / 'settings.json').write_text(json.dumps(settings), encoding='utf-8')
        clock = [0.0]
        replay = Tracker(temporary, Prices(), now=lambda: clock[0])
        replay.profile = tracker.profile
        inventories = {}
        for row in reversed(records):
            clock[0] = row['t']
            session, data = row['s'], bytes.fromhex(row['h'])
            if row.get('c'):
                replay.observe_client(session, data, recorded_index=row.get('i'))
            else:
                inventory = inventories.setdefault(session, Inventory())
                inventory.observe(data, session)
                replay.observe(session, data, inventory)
            c = replay.characters.get(session)
            if c and c.key:
                for orphan in tracker.restored:
                    if not orphan.character.get('key') and abs(orphan.started_at - row['t']) <= .002:
                        orphan.character = c.facts()
                        orphan.level_start = orphan.level_start or c.level
                        for segment in orphan.segments:
                            if segment.map_id is None and abs(segment.started_at - row['t']) <= .002:
                                segment.map_id = c.map_id
                                segment.level, segment.job = c.level, c.job
        try:
            runs = json.loads((tracker.data / 'current.json').read_text(encoding='utf-8'))['runs']
        except (OSError, ValueError, KeyError):
            runs = []
        for c in replay.characters.values():
            candidates = [r for r in runs if c.key and r['character'].get('key') == c.key]
            c.run = Run.from_json(candidates[0]) if len(candidates) == 1 else None
        restore(tracker, snapshot(replay, sessions), sessions)


def recover_inventory(data, session, cutoff):
    """Replay a known session's last full bag snapshot after a parser upgrade."""
    from market_inventory import Inventory
    rows, found = [], False
    for path in sorted((data/'frames').glob('frames_*.jsonl'), reverse=True):
        for line in reversed(path.read_bytes().splitlines()):
            try:
                row = json.loads(line)
                if row.get('s') != session or row.get('c') or row['t'] > cutoff:
                    continue
                payload = bytes.fromhex(row['h'])
            except (KeyError, ValueError, TypeError):
                continue
            op = int.from_bytes(payload[:2], 'little')
            if op in (0x1a6, 0x1a9, 0x72, 0x7e):
                rows.append(payload)
            if op in (0x1a6, 0x1a9) and len(payload) >= 512:
                found = True
                break
        if found:
            break
    if not found:
        return None
    inventory = Inventory()
    for payload in reversed(rows):
        inventory.observe(payload, session)
    return inventory if inventory.slots is not None else None
