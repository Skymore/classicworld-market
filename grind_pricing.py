"""Prices for the grind ledger, fetched from the site and cached locally.

Every median is over the last 72 hours of sales only (the site sends it so).
Loot (use/etc/setup items): the item's median sale price (成交中位), else the
NPC buy-back price, else nothing. Monster materials (400xxxx) whose median is at
most 30% above the NPC buy-back go to the NPC, so they count at its price.
Equipment, the same way as the selling page, by key stats (the ones the site
sends per item) and remaining upgrades: three or more sales in 72 hours of the
same stats, their median; else those stats' sales (30 days) and asks together;
else the sales and asks of the same remaining upgrades whose weighted key stats
(attack counts 3) are closest, at least three of them; else the item's median,
else NPC buy-back. Consumables used while grinding: the median sale too, like loot,
so a potion costs what it would fetch; the cheapest NPC shop price only when
it never sold. Every value carries the basis it came from.
"""
import json
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from grind_npc_prices import NPC_SELL

REFRESH = 30 * 60
RETRY = 60
BATCH = 100
DEFENCE = {'weapon_defense', 'magic_defense', 'pdd', 'mdd'}
RECHARGEABLE = (207, 233)
# Fixed values, whatever the market says: 南瓜派 (Pumpkin Pie, 2026-11-18 event) restores 700 HP
# and 400 MP, priced at 0.5 a HP and 1 a MP (the user's rule, for this item only).
FIXED = {2020027: (750, '按回复量')}
# A material that sells for at most this much over the NPC buy-back goes to the NPC.
NPC_CLOSE = 1.3
NEAR_MIN = 3
SCORE_WEIGHT = {'weapon_attack': 3, 'magic_attack': 3}


def median(values):
    values = sorted(values)
    n = len(values)
    if not n:
        return None
    return values[n // 2] if n % 2 else (values[n // 2 - 1] + values[n // 2]) / 2


def gear_price(row, piece):
    """(unit, label) of a piece of equipment from the site's attribute groups, like
    the selling page; None without groups carrying their prices (an older site)."""
    groups = row.get('groups') or []
    if not groups or any('asks' not in g for g in groups):
        return None
    keys = row.get('key_stats')
    weights = lambda stats: sum(v * SCORE_WEIGHT.get(k, 1) for k, v in stats)
    mine_stats = sorted([s['key'], s['value']] for s in piece.get('stats') or []
                        if (s['key'] in keys if keys is not None else s['key'] not in DEFENCE))
    slots = piece.get('remaining_upgrades')
    parsed = []
    for g in groups:
        try:
            stats, upgrades = json.loads(g['key'])[:2]
        except (ValueError, TypeError, KeyError):
            continue
        parsed.append((sorted(map(list, stats)), upgrades, g))
    same = [g for stats, upgrades, g in parsed if stats == mine_stats and upgrades == slots]
    recent = [p for g in same for p in g.get('recent') or []]
    if len(recent) >= 3:
        return median(recent), '同属性成交中位'
    pool = recent + [p for g in same for p in (g.get('older') or []) + (g.get('asks') or [])]
    if pool:
        return median(pool), '同属性成交加在售'
    target = weights(mine_stats)
    near = sorted(((abs(weights(stats) - target), g) for stats, upgrades, g in parsed if upgrades == slots),
                  key=lambda x: x[0])
    picked, count, cut = [], 0, None
    for gap, g in near:
        if cut is not None and gap > cut:
            break
        prices = (g.get('recent') or []) + (g.get('older') or []) + (g.get('asks') or [])
        picked += prices
        count += len(prices)
        if count >= NEAR_MIN and cut is None:
            cut = gap
    if picked:
        return median(picked), '相近属性'
    return None


def group_key(piece, keys=None):
    """The item page's equipment group: same JSON shape on both sides. `keys`:
    the item's key stats from the site (main and secondary stats of its jobs,
    attack, critical); without them every stat but defence."""
    stats = sorted([s['key'], s['value']] for s in piece.get('stats') or []
                   if (s['key'] in keys if keys is not None else s['key'] not in DEFENCE))
    return json.dumps([stats, piece.get('remaining_upgrades'), piece.get('unknown_fields') or 0],
                      separators=(',', ':'))


def client_version():
    try:
        from collector_update import VERSION
        return VERSION
    except Exception:
        return None


class Prices:
    def __init__(self, cache_path=None, fetch=None):
        self.cache_path = Path(cache_path) if cache_path else None
        self.fetch = fetch
        self.rows = {}
        self.maps = {}
        self.mobs = {}
        self.wanted = set()
        self.wanted_maps = set()
        self.wanted_mobs = set()
        self.failed_at = 0
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.thread = None
        if self.cache_path:
            try:
                saved = json.loads(self.cache_path.read_text(encoding='utf-8'))
                self.rows = {int(k): v for k, v in (saved.get('items') or {}).items()}
                if saved.get('version') != client_version():
                    # A new client may price differently (v0.7.44: the last 72 hours,
                    # per attribute group): ask again instead of waiting out REFRESH.
                    for row in self.rows.values():
                        row['at'] = 0
                self.maps = {int(k): v for k, v in (saved.get('maps') or {}).items()}
                self.mobs = {int(k): v for k, v in (saved.get('mobs') or {}).items()}
            except (OSError, ValueError, AttributeError):
                pass

    def want(self, ids):
        with self.lock:
            fresh = {i for i in ids if i and (i not in self.rows or time.time() - self.rows[i].get('at', 0) > REFRESH)}
            if fresh - self.wanted:
                self.wanted |= fresh
                self.wake.set()

    def want_map(self, map_id):
        with self.lock:
            if map_id and map_id not in self.maps and map_id not in self.wanted_maps:
                self.wanted_maps.add(map_id)
                self.wake.set()

    def map(self, map_id):
        from grind_map_names import MAP_NAMES
        row = self.maps.get(map_id)
        if row and row.get('name'):
            return row
        name = MAP_NAMES.get(map_id)
        return dict(row or {}, name=name) if name else row

    def want_mob(self, mob_id):
        with self.lock:
            if mob_id and mob_id not in self.mobs and mob_id not in self.wanted_mobs:
                self.wanted_mobs.add(mob_id)
                self.wake.set()

    def mob(self, mob_id):
        return self.mobs.get(mob_id)

    def row(self, item_id):
        return self.rows.get(item_id)

    def start(self, stop):
        if self.thread or not self.fetch:
            return
        def run():
            while not stop.is_set():
                self.wake.wait(5)
                self.wake.clear()
                self.refresh_once()
        self.thread = threading.Thread(target=run, daemon=True, name='grind-prices')
        self.thread.start()

    def refresh_once(self):
        if not self.fetch or time.time() - self.failed_at < RETRY:
            return
        with self.lock:
            ids = sorted(self.wanted)[:BATCH]
            maps = sorted(self.wanted_maps)[:BATCH]
            mobs = sorted(self.wanted_mobs)[:BATCH]
        if not ids and not maps and not mobs:
            return
        try:
            result = self.fetch(ids, maps, mobs) or {}
        except Exception as error:
            self.failed_at = time.time()
            # Names and prices silently missing is hard to notice: say why, once a minute at most.
            print(json.dumps(dict(time=self.failed_at, event='grind_prices_failed', error=type(error).__name__,
                                  detail=str(error)[:160])), flush=True)
            return
        now = time.time()
        with self.lock:
            for item in ids:
                row = (result.get('prices') or {}).get(str(item)) or {}
                row['at'] = now
                self.rows[item] = row
                self.wanted.discard(item)
            for map_id in maps:
                self.maps[map_id] = (result.get('maps') or {}).get(str(map_id)) or {}
                self.wanted_maps.discard(map_id)
            for mob_id in mobs:
                self.mobs[mob_id] = (result.get('mobs') or {}).get(str(mob_id)) or {}
                self.wanted_mobs.discard(mob_id)
        self.save()

    def refresh_now(self, ids):
        """Fetch these items now, in batches (a rebuild, before it prices anything)."""
        ids = sorted({i for i in ids if i})
        for start in range(0, len(ids), BATCH):
            with self.lock:
                self.wanted |= set(ids[start:start + BATCH])
            self.failed_at = 0
            self.refresh_once()

    def save(self):
        if not self.cache_path:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.cache_path.with_name(self.cache_path.name + '.tmp')
            temporary.write_text(json.dumps(dict(version=client_version(), items=self.rows, maps=self.maps, mobs=self.mobs)), encoding='utf-8')
            temporary.replace(self.cache_path)
        except OSError:
            pass

    def loot(self, item_id, piece=None, basis='typical'):
        """(unit value, basis label) of a picked-up item; (None, None) while unknown."""
        row = self.rows.get(item_id) or {}
        if basis == 'none':
            return 0, '不计'
        if item_id in FIXED:
            return FIXED[item_id]
        if basis == 'typical':
            if piece is not None:
                priced = gear_price(row, piece)
                if priced is not None:
                    return priced
                key = group_key(piece, row.get('key_stats'))
                for group in row.get('groups') or []:
                    if group.get('key') == key and group.get('median'):
                        return group['median'], '同属性成交中位'
                for group in row.get('groups') or []:
                    if group.get('key') == key and group.get('lowest_ask'):
                        return group['lowest_ask'], '同属性最低挂单'
            sell = row.get('npc_sell') or NPC_SELL.get(item_id)
            if row.get('typical') and not (item_id // 10000 == 400 and sell and row['typical'] <= sell * NPC_CLOSE):
                return row['typical'], '成交中位'
        sell = row.get('npc_sell') or NPC_SELL.get(item_id)
        if sell is not None:
            return sell, 'NPC 回收价'
        if item_id in self.rows:
            # The site answered and knows no price (quest items, 2026-11-25: 南瓜块, 派用面粉 and
            # 牛奶罐 waited for a price forever): worth nothing, not "waiting for prices".
            return 0, '无价格'
        return None, None

    def consumable(self, item_id):
        """(unit cost, basis) of a consumable used while grinding."""
        if item_id // 10000 in RECHARGEABLE:
            return 0, '飞镖子弹不计'
        if item_id in FIXED:
            return FIXED[item_id]
        row = self.rows.get(item_id)
        if row is None:
            return None, None
        if row.get('typical'):
            return row['typical'], '成交中位'
        if row.get('npc_shop') is not None:
            return row['npc_shop'], '商店价'
        return 0, '无价格'


def site_fetch(config, opener_factory):
    """fetch(item ids, map ids) for Prices, against the collector's configured site."""
    def fetch(ids, maps=(), mobs=()):
        query = urllib.parse.urlencode(dict(ids=','.join(map(str, ids)), maps=','.join(map(str, maps)),
                                            mobs=','.join(map(str, mobs))))
        request = urllib.request.Request(config['endpoint'].rstrip('/') + '/api/v1/grind/prices?' + query,
                                         headers={'Authorization': 'Bearer ' + config['token']})
        with opener_factory().open(request, timeout=8) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError('Oversized price response')
        return json.loads(raw)
    return fetch
