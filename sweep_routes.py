"""Navigate recent matching shops; historical quotes never authorize a purchase."""
import collections
import json
import time
from pathlib import Path


def shop_key(location, owner):
    return location.get('room'), location.get('channel'), owner


def targets(rows, plan, minutes, now):
    from collector_sweep import matching, stock_key
    watches = {w['item_id']: w for w in plan['watches']}
    valid = []
    stock = collections.Counter()
    for row in rows:
        loc = row.get('location') or {}
        observed = row.get('observed')
        if (row.get('source') != 'packet' or not isinstance(row.get('owner_name'), str)
                or not row['owner_name'] or type(loc.get('room')) is not int or not 1 <= loc['room'] <= 20
                or type(loc.get('channel')) is not int or not 1 <= loc['channel'] <= 40
                or type(observed) not in (int, float) or not 0 <= now-observed <= minutes*60
                or row.get('item_id') not in watches
                or any(type(row.get(k)) is not int or row[k] <= 0 for k in ('price','bundle','stock'))):
            continue
        key = shop_key(loc, row['owner_name'])
        valid.append((key, row))
        stock[key, stock_key(row)] += row['stock']
    shops = {}
    for key, row in valid:
        watch = watches[row['item_id']]
        candidate = dict(row, stock=stock[key, stock_key(row)])
        if any(matching(candidate, rule, watch['base']) for rule in watch['groups']):
            entry = shops.setdefault(key, dict(room=key[0], channel=key[1], owner=key[2], observed=0, offers=[]))
            entry['observed'] = max(entry['observed'], row['observed'])
            entry['offers'].append([row['item_id'], row.get('slot'), row['price'], row['bundle'], row['stock'], row.get('equipment')])
    return sorted(shops.values(), key=lambda s: (-s['observed'], s['room'], s['channel'], s['owner']))


class TargetComplete(Exception):
    """Raised only at the scanner's completed-channel checkpoint, after cleanup."""


def run_recent(folder, hwnd, ready, stop, status, engine, scan):
    from scan_progress import ScanProgress
    folder = Path(folder)
    visited = {}
    total = 0
    while not stop.is_set() and engine.buying():
        queue = engine.recent_targets()
        locations = {}
        now = time.monotonic()
        for shop in queue:
            key = shop_key(shop, shop['owner'])
            fingerprint = json.dumps(shop['offers'], sort_keys=True)
            previous = visited.get(key)
            if previous and previous[0] == fingerprint and now-previous[1] < 300:
                continue
            locations.setdefault((shop['room'], shop['channel']), []).append((shop, fingerprint))
        if not locations:
            engine.progress('等待新的命中店铺', revisits=0)
            status(('confirmed', dict(step='recent_wait', room=None, channel=None, visited=total)))
            stop.wait(15)
            continue
        for index, ((room, channel), shops) in enumerate(locations.items()):
            if stop.is_set() or not engine.buying():
                break
            engine.progress(f'近期命中：{room} 洞 · {channel}频道 · 待访 {len(locations)-index} 处', revisits=len(locations)-index)
            class VisitProgress(ScanProgress):
                armed = False
                def save(self, r, ch, cycle, **details):
                    if self.armed and details.get('phase') == 'pending':
                        raise TargetComplete()
                    super().save(r, ch, cycle, **details)
            progress = VisitProgress(folder/'recent-checkpoint.json')
            progress.save(room, channel, 1, phase='pending', channel_plan=dict(channel=channel,direction=1,boundary=0,empty_streak=0))
            progress.armed = True
            visit_folder = folder/f'recent_{room}_{channel}_{time.time_ns()}'
            visit_folder.mkdir()
            count = 0
            def observed(event):
                nonlocal count
                if isinstance(event, tuple) and event[0] == 'progress':
                    count = event[1].get('visited', 0)
                    event = ('progress', dict(event[1], visited=total+count))
                status(event)
            try:
                outcome = scan(visit_folder, hwnd, ready, stop, observed, progress=progress,
                               shop_callback=engine.on_shop_open, capture_receipt=engine.receipt)
                if not stop.is_set():
                    raise RuntimeError(f'Recent target incomplete: {outcome}')
            except TargetComplete:
                for shop, fingerprint in shops:
                    visited[shop_key(shop, shop['owner'])] = fingerprint, time.monotonic()
                total += count
    return dict(reason='recent_finished', visited=total)
