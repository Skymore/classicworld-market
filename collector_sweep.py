"""Local paper trading only. This module has no game input or purchase transport.

New complete shop captures drive evaluation. Rules never create market uploads.
Stock counts bundles; limits count items (rechargeable ammunition counts sets).
Each simulated purchase bundle reserves one virtual slot, without assuming stacking.
"""
import copy
import hashlib
import json
import math
import queue
import threading
import time
import uuid
from pathlib import Path
from shared_protocol import from_snapshot

STATS = {'weapon_attack', 'magic_attack', 'str', 'dex', 'int', 'luk', 'hp', 'mp',
         'accuracy', 'avoid', 'speed', 'jump', 'weapon_defense', 'magic_defense'}


def number(value, low, high, integer=True):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high or (integer and int(value) != value):
        raise ValueError('条件中的数字无效')
    return int(value) if integer else value


def configuration(raw):
    if not isinstance(raw, dict) or raw.get('mode') != 'simulate':
        raise ValueError('内测版仅支持模拟')
    limits = raw.get('limits', {})
    limits = {k: number(limits.get(k), 0, 96 if k in ('slots', 'reserveSlots') else 10**12)
              for k in ('budget', 'maxOrder', 'wallet', 'reserve', 'slots', 'reserveSlots')}
    source = raw.get('watches')
    if not isinstance(source, list) or len(source) > 100:
        raise ValueError('最多支持 100 种关注商品')
    watches = []
    ids = set()
    for w in source:
        iid = number(w.get('item_id'), 1000000, 5999999)
        if iid in ids:
            raise ValueError('关注商品重复')
        ids.add(iid)
        groups = w.get('groups')
        if not isinstance(groups, list) or not 1 <= len(groups) <= 12:
            raise ValueError('请选择条件组')
        safe = []
        for g in groups:
            if g.get('buy') is not True:
                continue
            f = g.get('reminder') or {}
            if f.get('percentile', 'all') != 'all' or f.get('equipment', 'all') == 'missing':
                raise ValueError('扫货需使用固定最高价与已知属性')
            cap = number(g.get('cap'), 0.000001, 10**15, False)
            lower, upper = f.get('minUpgrades'), f.get('maxUpgrades')
            for v in (lower, upper):
                if v is not None:
                    number(v, 0, 15)
            if lower is not None and upper is not None and lower > upper:
                raise ValueError('可升级次数范围无效')
            stats = f.get('stats', [])
            if not isinstance(stats, list) or len(stats) > 14:
                raise ValueError('属性条件无效')
            clean_stats = []
            for stat in stats:
                if stat.get('stat') not in STATS:
                    raise ValueError('未知装备属性')
                clean_stats.append({'stat': stat['stat'], 'min': number(stat.get('min') if stat.get('min') is not None else 1, 0, 65535)})
            if f.get('stock', 'all') not in ('all', 'known', 'unknown') or f.get('equipment', 'all') not in ('all', 'captured', 'bonus'):
                raise ValueError('筛选条件无效')
            safe.append(dict(id=str(g.get('id', ''))[:64], name=str(g.get('name') or '默认条件')[:40], cap=cap,
                min_price=None if f.get('minPrice') is None else number(f['minPrice'], 0, 10**15, False),
                min_stock=None if f.get('minStock') is None else number(f['minStock'], 1, 10**9),
                stock=f.get('stock', 'all'), equipment=f.get('equipment', 'all'),
                min_upgrades=lower, max_upgrades=upper, stats=clean_stats))
        base = w.get('base_stats', [])
        if not isinstance(base, list) or len(base) > 32:
            raise ValueError('基础属性无效')
        base = {str(k): number(v, 0, 65535) for k, v in base if k in STATS}
        watches.append(dict(item_id=iid, name=str(w.get('name') or iid)[:120], limit=number(w.get('limit'), 1, 9999), groups=safe, base=base))
    source_key = raw.get('source_key', '')
    if not isinstance(source_key, str) or len(source_key) != 64 or any(c not in '0123456789abcdef' for c in source_key):
        raise ValueError('规则版本无效')
    return dict(mode='simulate', limits=limits, watches=watches, source_key=source_key)


def matching(row, rule, base):
    bundle = 1 if row['item_id']//10000 in (207, 233) else row['bundle']
    unit = row['price']/bundle
    if row['stock'] <= 0 or row['price'] <= 0 or unit > rule['cap']:
        return False
    if rule['min_price'] is not None and unit < rule['min_price']:
        return False
    if rule['stock'] == 'unknown' or rule['min_stock'] is not None and row['stock'] < rule['min_stock']:
        return False
    eq = row.get('equipment') or {}
    known = eq.get('status') == 'candidate'
    values = {s['key']: s['value'] for s in eq.get('stats', [])} if known else {}
    if rule['equipment'] == 'captured' and not known:
        return False
    if rule['equipment'] == 'bonus' and not (known and base and any(k not in ('weapon_defense', 'magic_defense') and v > base.get(k, 0) for k, v in values.items())):
        return False
    if any(s['stat'] not in values or values[s['stat']] < s['min'] for s in rule['stats']):
        return False
    if rule['min_upgrades'] is not None or rule['max_upgrades'] is not None:
        n = eq.get('remaining_upgrades')
        if not known or type(n) is not int or not 0 <= n <= 15:
            return False
        if rule['min_upgrades'] is not None and n < rule['min_upgrades'] or rule['max_upgrades'] is not None and n > rule['max_upgrades']:
            return False
    return True


class SweepSimulator:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.home = self.folder/'sweep-beta'
        self.lock = threading.RLock()
        self.config = None
        self.enabled = False
        self.session_id = None
        self.started = 0
        self.spent = self.units = self.checked = 0
        self.counts, self.slots, self.seen, self.observations = {}, {}, set(), set()
        self.recent = []
        self.message = ''
        self.source_key = ''
        self.observer = self.worker = None
        self.closed = threading.Event()
        self.pending = queue.Queue(maxsize=512)
        try:
            old = json.loads((self.home/'status.json').read_text(encoding='utf-8'))
            for k in ('session_id', 'spent', 'units', 'checked', 'source_key', 'recent'):
                if k in old:
                    setattr(self, k, old[k])
            self.message = '程序已重启，模拟已停止' if self.session_id else ''
        except (OSError, ValueError, TypeError):
            pass

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(dict(mode='simulate', enabled=self.enabled, session_id=self.session_id,
                spent=self.spent, units=self.units, checked=self.checked, source_key=self.source_key,
                recent=self.recent, message=self.message))

    def persist(self, event=None):
        self.home.mkdir(parents=True, exist_ok=True)
        if event:
            with (self.home/'simulations.jsonl').open('a', encoding='utf-8') as out:
                out.write(json.dumps(dict(session_id=self.session_id, at=time.time(), mode='simulate', **event), ensure_ascii=False)+'\n')
        path = self.home/'status.json'
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.snapshot(), ensure_ascii=False), encoding='utf-8')
        for attempt in range(5):
            try:
                tmp.replace(path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(.02)

    def command(self, raw):
        action = raw.get('action')
        with self.lock:
            if action == 'stop':
                self.enabled = False
                self.message = '模拟已停止'
                self.persist({'event': 'stopped'})
                return self.snapshot()
            if action != 'start':
                raise ValueError('未知模拟操作')
            config = configuration(raw)
            if not any(w['groups'] for w in config['watches']):
                raise ValueError('请先勾选参与扫货的条件组')
            self.config = config
            self.source_key = config['source_key']
            self.session_id = uuid.uuid4().hex
            self.started = time.time()
            self.spent = self.units = self.checked = 0
            self.counts, self.slots, self.seen, self.observations = {}, {}, set(), set()
            self.recent = []
            self.message = '等待新的店铺采集'
            self.enabled = True
            self.persist({'event': 'started', 'configuration': config})
            return self.snapshot()

    def process(self, data, now=None):
        now = time.time() if now is None else now
        packet = from_snapshot(data, now=now)
        with self.lock:
            if not self.enabled or packet['observed_at'] < self.started or not 0 <= now-packet['observed_at'] <= 120:
                return
            if packet['observation_id'] in self.observations:
                return
            self.observations.add(packet['observation_id'])
            self.checked += 1
            self.message = '模拟运行中'
            location = packet.get('location') or {}
            if not location.get('room') or not location.get('channel'):
                self.message = '本次店铺缺少洞频道，已跳过'
                self.persist()
                return
            watches = {w['item_id']: w for w in self.config['watches']}
            limits = self.config['limits']
            def stock_key(row):
                return json.dumps([row['item_id'], row['price'], row['bundle'], row.get('equipment')], sort_keys=True)
            grouped_stock = {}
            for row in packet['items']:
                k = stock_key(row)
                grouped_stock[k] = grouped_stock.get(k, 0)+row['stock']
            for row in packet['items']:
                watch = watches.get(row['item_id'])
                if not watch or row['stock'] <= 0:
                    continue
                hit = [r for r in watch['groups'] if matching({**row, 'stock':grouped_stock[stock_key(row)]}, r, watch['base'])]
                if not hit:
                    continue
                # Stock changes and repeated captures do not re-buy the same listing.
                identity = [location['room'], location['channel'], (packet.get('owner') or {}).get('character_id', packet['shop_id']),
                    row['category'], row['slot'], row['item_id'], row['price'], row['bundle'], row.get('equipment')]
                key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
                if key in self.seen:
                    continue
                self.seen.add(key)
                bundle = 1 if row['item_id']//10000 in (207, 233) else row['bundle']
                funds = max(0, min(limits['budget']-self.spent, limits['wallet']-limits['reserve']-self.spent))
                free = max(0, limits['slots']-limits['reserveSlots']-self.slots.get(row['category'], 0))
                left = max(0, watch['limit']-self.counts.get(row['item_id'], 0))
                purchases = min(row['stock'], left//bundle, funds//row['price'], limits['maxOrder']//row['price'], free)
                cost, units = purchases*row['price'], purchases*bundle
                reason = ''
                if not purchases:
                    reason = '商品数量上限' if left < bundle else '模拟空格不足' if not free else '单次交易上限' if limits['maxOrder'] < row['price'] else '模拟预算或保留金币不足'
                record = dict(event='planned' if purchases else 'skipped', key=key, name=watch['name'], item_id=row['item_id'],
                    room=location['room'], channel=location['channel'], owner=(packet.get('owner') or {}).get('name'),
                    groups=[r['name'] for r in hit], purchases=purchases, units=units, cost=cost, reason=reason)
                self.spent += cost
                self.units += units
                self.counts[row['item_id']] = self.counts.get(row['item_id'], 0)+units
                self.slots[row['category']] = self.slots.get(row['category'], 0)+purchases
                self.recent.insert(0, record)
                del self.recent[20:]
                self.persist(record)
            self.persist()

    def enqueue(self, filename):
        path = Path(filename)
        if not self.enabled or path.parent.resolve() != self.folder.resolve() or not path.name.startswith('shop_') or path.suffix != '.json':
            return
        try:
            self.pending.put_nowait(path)
        except queue.Full:
            with self.lock:
                self.enabled = False
                self.message = '模拟队列已满，请重新开始'

    def start_observer(self):
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler
        self.folder.mkdir(parents=True, exist_ok=True)
        with self.lock:
            self.persist()
        engine = self
        class Changes(FileSystemEventHandler):
            def on_created(self, event):
                engine.enqueue(event.src_path)
            def on_modified(self, event):
                engine.enqueue(event.src_path)
            def on_moved(self, event):
                engine.enqueue(event.dest_path)
        def work():
            while not self.closed.is_set():
                try:
                    path = self.pending.get(timeout=.5)
                except queue.Empty:
                    continue
                for delay in (0, .1, .3):
                    if self.closed.wait(delay):
                        return
                    try:
                        if path.stat().st_size > 2*1024*1024:
                            raise ValueError('Capture too large')
                        data = json.loads(path.read_text(encoding='utf-8'))
                        try:
                            self.process(data)
                        except OSError:
                            with self.lock:
                                self.enabled = False
                                self.message = '模拟记录保存失败，已停止'
                        break
                    except (OSError, ValueError, KeyError, TypeError):
                        continue
                    except Exception:
                        with self.lock:
                            self.enabled = False
                            self.message = '模拟处理失败，已停止；采集不受影响'
                        break
        self.worker = threading.Thread(target=work, name='sweep-simulator', daemon=True)
        self.worker.start()
        self.observer = Observer()
        self.observer.schedule(Changes(), str(self.folder), recursive=False)
        self.observer.start()

    def close(self):
        self.closed.set()
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=2)
        if self.worker:
            self.worker.join(timeout=2)
