"""Restore missing locations from saved, same-session map evidence.

Only structured observations go to the collector's existing server. Packet
evidence and captures remain on the computer. Original quotes are immutable.
"""
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

from market_location import LocationTimeline
from shared_protocol import digest, from_snapshot


def repair_history(folders, config, opener, stop, pace=0.55):
    destination = config['endpoint'].rstrip('/')
    url = urlsplit(destination)
    local = url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port is not None and not url.username and not url.password and not url.path and not url.query and not url.fragment
    if destination != 'https://mxd.ruit.me' and not local:
        raise ValueError('Unsupported endpoint')
    headers = {'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'}
    pending = set()
    after = 0
    for _ in range(100):
        if stop.is_set(): return 0
        request = urllib.request.Request(destination + '/api/v1/collector/missing-locations?after=' + str(after), headers=headers)
        with opener().open(request, timeout=20) as response: data = json.load(response)
        ids = data['observations']
        if not isinstance(ids, list) or any(not isinstance(v, str) or len(v) > 64 for v in ids):
            raise ValueError('Invalid history response')
        pending.update(ids)
        next_after = data.get('next')
        if next_after is None: break
        if type(next_after) is not int or next_after <= after: raise ValueError('Invalid history cursor')
        after = next_after
    if not pending: return 0
    repaired = 0
    for folder in folders:
        folder = Path(folder)
        timeline = LocationTimeline(folder / 'map_observations.jsonl')
        for path in sorted(folder.glob('shop_*.json')):
            if stop.is_set() or not pending: return repaired
            if path.stem.endswith('_zh'): continue
            try:
                snapshot = json.loads(path.read_text(encoding='utf-8'))
                key = digest([snapshot['session'], snapshot['time'], snapshot['shop_id']])
                if key not in pending or snapshot.get('triggered_by_python'): continue
                # No fallback from titles, adjacent shops, or a later connection.
                context = timeline.resolve_context(snapshot['session'], snapshot['time'])
                if not context or context.get('room') is None: continue
                payload = from_snapshot(snapshot, context)
                payload['map_context'] = {k: context[k] for k in ('channel', 'map_id')}
            except (ValueError, KeyError, TypeError, OSError): continue
            request = urllib.request.Request(destination + '/api/v1/collector/repair-location',
                data=json.dumps(payload, ensure_ascii=False).encode(), headers=headers, method='POST')
            try:
                with opener().open(request, timeout=20) as response: result = json.load(response)
                if not result.get('ok'): raise ValueError('Repair was not acknowledged')
                repaired += int(bool(result.get('repaired')))
                pending.discard(key)
            except urllib.error.HTTPError as error:
                # A conflict means evidence disagrees; never overwrite the original.
                if error.code == 409: pending.discard(key)
                else: raise
            if stop.wait(pace): return repaired
    return repaired
