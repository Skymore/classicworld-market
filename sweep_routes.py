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


class PriorityPending(Exception):
    """Controlled route handoff, never a channel failure or recovery request."""


def fingerprint(shop):
    return json.dumps(sorted(shop['offers'], key=lambda v: json.dumps(v, sort_keys=True)), sort_keys=True)


class LiveTargets:
    """Owned under the engine lock. Refreshes replace stale/sold navigation hints."""
    def __init__(self):
        self.shops = []
        self.done = collections.OrderedDict()

    def update(self, shops):
        self.shops = shops

    def next(self, now):
        from collector_sweep import TARGET_MINUTES
        window = TARGET_MINUTES*60
        while self.done and next(iter(self.done.values())) < now-window:
            self.done.popitem(last=False)
        eligible = [s for s in self.shops if 0 <= now-s['observed'] <= window
                    and (shop_key(s, s['owner']), fingerprint(s)) not in self.done]
        if not eligible:
            return []
        place = eligible[0]['room'], eligible[0]['channel']
        return [s for s in eligible if (s['room'], s['channel']) == place]

    def complete(self, shops, now):
        for shop in shops:
            key = shop_key(shop, shop['owner']), fingerprint(shop)
            self.done.pop(key, None)
            self.done[key] = now
        while len(self.done) > 4096:
            self.done.popitem(last=False)


def with_live_priority(folder, hwnd, ready, stop, status, engine, scan, regular, *, visited=None):
    """The ordinary route releases its room lease before yielding control here."""
    due = lambda: getattr(engine, 'recent_pass_due', lambda: False)() is True

    def checkpoint():
        if not stop.is_set() and (engine.next_live_target() or due()):
            raise PriorityPending()

    while not stop.is_set():
        if due():
            # A rule change (or a fresh run) revisits every match from the last
            # 12 hours once; shops looked at under the old rules count again.
            if visited is not None:
                visited.clear()
            engine.progress('按新条件回访 12 小时内命中', revisits=1)
            run_recent(folder, hwnd, ready, stop, status, engine, scan, once=True, visited=visited)
            continue
        shops = engine.next_live_target()
        if shops:
            room, channel = shops[0]['room'], shops[0]['channel']
            engine.progress(f'优先扫货：{room} 洞 · {channel}频道', revisits=1)
            # No checkpoint hook: finish this highest-priority channel once.
            run_recent(folder, hwnd, ready, stop, status, engine, scan,
                       once=True, target_shops=shops, visited=visited)
            if not stop.is_set():
                engine.complete_live_target(shops)
            continue
        try:
            return regular(checkpoint)
        except PriorityPending:
            # full_market_scan has already released held keys; regular() must
            # close CloudScan before this exception reaches the dispatcher.
            continue
    return dict(reason='cancelled')


def run_recent(folder, hwnd, ready, stop, status, engine, scan, *, once=False,
               target_shops=None, visited=None, safe_checkpoint=None):
    from scan_progress import ScanProgress
    folder = Path(folder)
    visited = {} if visited is None else visited
    total = 0
    # A completed one-shot pass over the server's matches settles this plan version.
    pass_key = engine.recent_pass_key() if once and target_shops is None and hasattr(engine, 'recent_pass_key') else None
    while not stop.is_set() and engine.buying():
        if safe_checkpoint:
            safe_checkpoint()
        queue = engine.recent_targets() if target_shops is None else target_shops
        locations = {}
        now = time.monotonic()
        for shop in queue:
            key = shop_key(shop, shop['owner'])
            stamp = fingerprint(shop)
            previous = visited.get(key)
            if previous and previous[0] == stamp and now-previous[1] < 300:
                continue
            locations.setdefault((shop['room'], shop['channel']), []).append((shop, stamp))
        if not locations:
            if once:
                break
            engine.progress('等待新的命中店铺', revisits=0)
            status(('confirmed', dict(step='recent_wait', room=None, channel=None, visited=total)))
            # Polling runs separately; a new hit can interrupt this idle wait.
            for _ in range(15):
                if stop.wait(1):
                    break
                if safe_checkpoint:
                    safe_checkpoint()
            continue
        for index, ((room, channel), shops) in enumerate(locations.items()):
            if stop.is_set() or not engine.buying():
                break
            if safe_checkpoint:
                safe_checkpoint()
            label = '优先扫货' if target_shops is not None else '近期命中'
            engine.progress(f'{label}：{room} 洞 · {channel}频道 · 待访 {len(locations)-index} 处', revisits=len(locations)-index)
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
                               shop_callback=engine.on_shop_open, capture_receipt=engine.receipt,
                               **({'safe_checkpoint': safe_checkpoint} if safe_checkpoint else {}))
                if not stop.is_set():
                    raise RuntimeError(f'Recent target incomplete: {outcome}')
            except TargetComplete:
                for shop, stamp in shops:
                    visited[shop_key(shop, shop['owner'])] = stamp, time.monotonic()
                total += count
        if once:
            break
    if pass_key and not stop.is_set() and engine.buying():
        engine.mark_recent_pass(pass_key)
    return dict(reason='recent_finished', visited=total)
