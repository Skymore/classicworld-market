"""Live sweep engine (SWEEP.md sections 3 and 4): joins server sweep runs, buys through the local purchaser.

The plan comes from the server; this computer's settings bound every purchase. Each purchase
needs a server reservation and a live lease. Losing the server, the lease or the run, or
signing out, stops buying at once. Stock counts bundles; limits count items (rechargeable
ammunition counts sets). Files under <capture folder>/sweep/ are local and never uploaded.
"""
import collections
import copy
import hashlib
import json
import math
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from account_device import DeviceError, EventStream
from shared_protocol import from_snapshot
from sweep_purchase import REASONS, PurchaseHalt, PurchaseOrder, PurchaseResult, load_purchaser

STATS = {'weapon_attack', 'magic_attack', 'str', 'dex', 'int', 'luk', 'hp', 'mp',
         'accuracy', 'avoid', 'speed', 'jump', 'weapon_defense', 'magic_defense'}
LIMIT = 10**12
DEFAULT_SETTINGS = dict(allow_web_start=False, max_spend=0, max_order=0, reserve_mesos=0)


def number(value, low, high, integer=True):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high or (integer and int(value) != value):
        raise ValueError('条件中的数字无效')
    return int(value) if integer else value


def configuration(raw):
    """Validate a plan from the server, enriched with item names and base stats."""
    source = raw.get('watches') if isinstance(raw, dict) else None
    if not isinstance(source, list) or not 1 <= len(source) <= 100:
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
    if not any(w['groups'] for w in watches):
        raise ValueError('没有可扫货的条件组')
    return dict(watches=watches)


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


def local_settings(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('allow_web_start'), bool):
        raise ValueError('本机设置无效')
    clean = dict(allow_web_start=raw['allow_web_start'])
    for key in ('max_spend', 'max_order', 'reserve_mesos'):
        value = raw.get(key)
        if type(value) is not int or not 0 <= value <= LIMIT:
            raise ValueError('金额需为 0 到 1 万亿之间的整数')
        clean[key] = value
    return clean


def units_per(row):
    return 1 if row['item_id']//10000 in (207, 233) else row['bundle']


def stock_key(row):
    return json.dumps([row['item_id'], row['price'], row['bundle'], row.get('equipment')], sort_keys=True)


def listing_key(location, owner, row):
    identity = [location['room'], location['channel'], owner, row['category'], row['slot'],
                row['item_id'], row['price'], row['bundle'], row.get('equipment')]
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def checked_result(result, order):
    """A purchaser result that breaks the contract is treated as unknown."""
    if not isinstance(result, PurchaseResult) or result.status not in ('bought', 'not_bought', 'unknown'):
        return PurchaseResult('unknown', reason='error')
    reason = result.reason if result.reason in REASONS else ''
    if result.status == 'bought':
        if (type(result.quantity) is not int or not 1 <= result.quantity <= order.quantity
                or type(result.spent) is not int or not 0 <= result.spent <= result.quantity*order.price):
            return PurchaseResult('unknown', reason='error')
        return PurchaseResult('bought', result.quantity, result.spent, reason)
    return PurchaseResult(result.status, 0, 0, reason or 'error')


def game_connected():
    try:
        from cloud_scan import game_connected as connected
    except ImportError:
        return False
    return connected()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    for attempt in range(5):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(.02)


class CaptureReceipt:
    """This visit's shop capture, from the in-process collector's events (no folder scans)."""
    def __init__(self, engine):
        self.engine = engine
        self.mark = engine.captures_seen
        self.started = time.time()

    def poll(self):
        found = []
        for name in self.engine.captured_since(self.mark):
            path = self.engine.folder/name
            try:
                row = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            if (not isinstance(row, dict) or row.get('triggered_by_python') is not False
                    or not isinstance(row.get('items'), list) or type(row.get('shop_id')) is not int
                    or type(row.get('time')) not in (int, float) or row['time'] < self.started-1):
                continue
            found.append(dict(file=str(path.resolve()), time=row['time'], session=row.get('session'),
                shop_id=row['shop_id'], item_count=len(row['items']), market_location=row.get('market_location'),
                correlation='one_new_capture_during_foreground_visit'))
        if len(found) > 1:
            raise RuntimeError('Multiple shop captures during one visit; cannot attribute prices')
        return found[0] if found else None


class SweepEngine:
    def __init__(self, folder, client, purchaser=None, game=game_connected, dashboard=None):
        self.folder = Path(folder)
        self.home = self.folder/'sweep'
        self.client = client
        self.purchaser = purchaser if purchaser is not None else load_purchaser()
        self.game = game
        self.dashboard = Path(dashboard) if dashboard else None
        self.lock = threading.RLock()
        self.poll_lock = threading.Lock()
        self.shop_lock = threading.Lock()  # Held while the scanner is inside a shop.
        self.wake, self.closed = threading.Event(), threading.Event()
        self.events = EventStream(self._local_events, self._event, self.closed)
        self.settings = self._read_settings()
        self.pending = self._read_pending()
        self.recent = [self._entry(e) for e in self._purchases()[-20:]][::-1]
        self.token = self.account = self.device = None
        self.run = self.plan = self.plan_version = self.lease = None
        self.lease_deadline, self.ttl = 0, 30
        self.left = set()
        self.seen, self.units, self.spent, self.checked = set(), {}, 0, 0
        self.message = ''
        self.captures = collections.deque(maxlen=32)
        self.captures_seen = 0
        self.reported, self.report_due, self.report_retry = None, 0, 0
        self.game_state, self.game_checked = False, -10
        self.connected, self.connected_at = False, 0
        self.names = {}
        self.thread = None

    # Local files.
    def _read_settings(self):
        try:
            return local_settings(json.loads((self.home/'settings.json').read_text(encoding='utf-8')))
        except (OSError, ValueError, TypeError):
            return dict(DEFAULT_SETTINGS)

    def _read_pending(self):
        try:
            value = json.loads((self.home/'pending.json').read_text(encoding='utf-8'))
            return [p for p in value if isinstance(p, dict) and isinstance(p.get('body'), dict)]
        except (OSError, ValueError, TypeError):
            return []

    def _purchases(self, run=None):
        try:
            with (self.home/'purchases.jsonl').open(encoding='utf-8') as source:
                lines = source.read(16*1024*1024).splitlines()
        except OSError:
            return []
        entries = []
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and (run is None or entry.get('run') == run):
                entries.append(entry)
        return entries

    @staticmethod
    def _entry(e):
        return {k: e.get(k) for k in ('name', 'item_id', 'status', 'quantity', 'units', 'spent', 'reason', 'room', 'channel', 'owner', 'at')}

    def _note(self, entry, record=None):
        with self.lock:
            self.recent.insert(0, self._entry(entry))
            del self.recent[20:]
        if record:
            try:
                self.home.mkdir(parents=True, exist_ok=True)
                with (self.home/'purchases.jsonl').open('a', encoding='utf-8') as out:
                    out.write(json.dumps({**entry, **record}, ensure_ascii=False)+'\n')
            except OSError:
                with self.lock:
                    self.message = '本机购买记录保存失败'

    # Snapshots for the desktop UI.
    def status(self):
        self._identity()
        executor = self.purchaser.status()
        with self.lock:
            run = None
            if self.run:
                participant = self.run.get('participant') or {}
                run = dict({k: self.run.get(k) for k in ('id', 'status', 'budget', 'remaining', 'ends_at', 'started_by', 'plan_version')},
                    state=participant.get('state'), message=participant.get('message') or '',
                    spent_here=max(self.spent, self.run.get('spent_here') if type(self.run.get('spent_here')) is int else 0))
            return copy.deepcopy(dict(linked=self.token is not None, account=self.account, device=self.device,
                sweep=dict(settings=self.settings, executor=dict(ready=bool(executor.ready), reason=str(executor.reason or '')),
                           run=run, recent=self.recent, message=self.message)))

    def summary(self):
        with self.lock:
            return dict(enabled=self.lease is not None, units=sum(self.units.values()), spent=self.spent, message=self.message)

    # Scanner hook.
    def collector_event(self, event):
        if event.get('type') == 'captured' and isinstance(event.get('file'), str):
            name = Path(event['file']).name
            if name.startswith('shop_') and name.endswith('.json'):
                with self.lock:
                    self.captures_seen += 1
                    self.captures.append((self.captures_seen, name))

    def captured_since(self, mark):
        with self.lock:
            return [name for number, name in self.captures if number > mark]

    def receipt(self):
        return CaptureReceipt(self) if self.buying() else None

    def buying(self):
        with self.lock:
            return bool(self.token and self.run and self.plan and self.lease and not self.closed.is_set()
                        and time.monotonic() < self.lease_deadline)

    def _purchase_allowed(self, run, lease, plan_version):
        with self.lock:
            return bool(self.buying() and self.run['id'] == run and self.lease == lease
                        and self.plan_version == plan_version)

    def on_shop_open(self, collected, window):
        """Called on the scanner input thread while the shop is open and its prices are captured."""
        if not self.buying() or not isinstance(collected, dict):
            return
        with self.shop_lock:
            self._shop(collected, window)

    def _shop(self, collected, window):
        packet = self._load(collected.get('file'))
        if packet is None:
            return
        location = packet.get('location') or {}
        with self.lock:
            if not self.plan:
                return
            if not location.get('room') or not location.get('channel'):
                self.message = '本次店铺缺少洞频道，已跳过'
                return
            self.checked += 1
            watches = {w['item_id']: w for w in self.plan['watches']}
            plan_version = self.plan_version
        owner = packet.get('owner') or {}
        stock = collections.Counter()
        for row in packet['items']:
            stock[stock_key(row)] += row['stock']
        for row in packet['items']:
            watch = watches.get(row['item_id'])
            if not watch or row['stock'] <= 0:
                continue
            if not any(matching({**row, 'stock': stock[stock_key(row)]}, rule, watch['base']) for rule in watch['groups']):
                continue
            if not self.buying():
                return
            self._buy(row, watch, packet, location, owner, plan_version, window)

    def _load(self, filename):
        try:
            path = Path(filename)
            if path.parent.resolve() != self.folder.resolve() or path.stat().st_size > 2*1024*1024:
                return None
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('owner') is None:
                from market_shop_owner import owner_from_snapshot
                found = owner_from_snapshot(data, self.folder)
                if found is not None:
                    data['owner'] = found
            return from_snapshot(data)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            with self.lock:
                self.message = '本次店铺记录无法读取，已跳过'
            return None

    def _buy(self, row, watch, packet, location, owner, plan_version, window):
        per, price = units_per(row), row['price']
        key = listing_key(location, owner.get('character_id', packet['shop_id']), row)
        note = dict(name=watch['name'], item_id=row['item_id'], room=location['room'], channel=location['channel'],
                    owner=owner.get('name'), quantity=0, units=0, spent=0)
        with self.lock:
            if key in self.seen or not self.run or not self.lease:
                return
            self.seen.add(key)
            run, lease, settings = self.run['id'], self.lease, dict(self.settings)
            spent = max(self.spent, self.run.get('spent_here') if type(self.run.get('spent_here')) is int else 0)
            caps = [('item_limit', (watch['limit']-self.units.get(row['item_id'], 0))//per),
                    ('max_spend', (settings['max_spend']-spent)//price)]
            if type(self.run.get('remaining')) is int:
                caps.append(('budget', self.run['remaining']//price))
        executor = self.purchaser.status()
        if not executor.ready:
            self._stop_buying(executor.reason or '购买执行器未就绪')
            return
        if settings['max_order']:
            caps.append(('max_order', settings['max_order']//price))
        if type(executor.mesos) is int:
            caps.append(('reserve_mesos', (executor.mesos-settings['reserve_mesos'])//price))
        quantity = min([row['stock'], *(cap for _, cap in caps)])
        if quantity <= 0:
            self._note(dict(note, status='skipped', reason=next(name for name, cap in caps if cap <= 0)))
            return
        body = dict(run=run, lease=lease, plan_version=plan_version, listing=key, item_id=row['item_id'], price=price,
                    bundle=row['bundle'], stock=row['stock'], quantity=quantity,
                    location=dict(room=location['room'], channel=location['channel'], shop_id=packet['shop_id'],
                                  owner=owner.get('name'), category=row['category'], slot=row['slot']))
        started = time.monotonic()
        try:
            answer = self.client.call('POST', '/api/v1/device/sweep/reserve', body, timeout=2)
        except DeviceError as error:
            self._rejected(error)
            return
        except OSError:
            return  # No reservation within 2 s: do not buy.
        self._contact()
        granted, reservation, ttl = answer.get('granted'), answer.get('reservation'), answer.get('expires_in')
        if type(granted) is not int or granted <= 0 or not isinstance(reservation, str):
            self._note(dict(note, status='skipped', reason=str(answer.get('reason') or 'budget')[:32]))
            return
        order = PurchaseOrder(reservation=reservation, item_id=row['item_id'], name=watch['name'],
            category=row['category'], slot=row['slot'], price=price, bundle=row['bundle'],
            quantity=min(granted, quantity), equipment=row.get('equipment'), shop_id=packet['shop_id'],
            owner=owner.get('name'), room=location['room'], channel=location['channel'],
            deadline=min(started+(ttl if type(ttl) is int else 0)-5, self.lease_deadline),
            can_buy=lambda: self._purchase_allowed(run, lease, plan_version))
        # Stop or logout may have landed while the reservation was in flight.
        with self.lock:
            stopped = self.lease != lease or not self.buying()
        if stopped or order.deadline-time.monotonic() < 1:
            self._finish(order, PurchaseResult('not_bought', reason='stopped' if stopped else 'timeout'), note, per, run, lease, key)
            return
        try:
            result = checked_result(self.purchaser.buy(order, window), order)
        except PurchaseHalt as error:
            result = checked_result(error.result, order)
            self._finish(order, result, note, per, run, lease, key)
            if result.status != 'unknown' and result.reason != 'trade_locked':
                self._leave(run, lease, 'window_lost', '购买窗口未恢复，已停止扫描')
            raise
        except BaseException:
            # The window state is uncertain: report unknown, leave, and stop the scanner.
            self._finish(order, PurchaseResult('unknown', reason='error'), note, per, run, lease, key)
            raise
        self._finish(order, result, note, per, run, lease, key)
        if result.status == 'unknown':
            # Returning normally lets the scanner close this shop and click another.
            # An unconfirmed purchase/dialog must never receive those extra inputs.
            raise PurchaseHalt(result)

    def _finish(self, order, result, note, per, run, lease, key):
        unknown = result.status == 'unknown'
        cost = order.quantity*order.price if unknown else result.spent
        units = (order.quantity if unknown else result.quantity)*per
        with self.lock:
            if self.run and self.run['id'] == run:
                self.spent += cost
                self.units[order.item_id] = self.units.get(order.item_id, 0)+units
        entry = dict(note, status=result.status, quantity=result.quantity, units=result.quantity*per,
                     spent=result.spent, reason=result.reason, at=time.time())
        self._note(entry, dict(run=run, reservation=order.reservation, listing=key, cost=cost, counted_units=units,
                               price=order.price, bundle=order.bundle, shop_id=order.shop_id))
        self.settle(dict(reservation=order.reservation, status=result.status, quantity=result.quantity,
                         spent=result.spent, reason=result.reason))
        if unknown:
            self._leave(run, lease, 'unknown', '购买结果不确定，本机已退出本轮扫货')
        elif result.reason == 'trade_locked':
            self._leave(run, lease, 'trade_locked', '游戏账号尚未解锁交易，本机已退出本轮扫货')

    # Server conversation.
    def _contact(self):
        with self.lock:
            self.connected, self.connected_at = True, time.monotonic()

    def _identity(self):
        record = self.client.record()
        token = record['token'] if record else None
        with self.lock:
            if token == self.token:
                return
            self.token = token
            self.account = record['account'] if record else None
            self.device = record['device'] if record else None
            self._clear_run('' if token else '登录账号后可参加扫货')
            self.reported, self.report_due = None, 0
        self.wake.set()

    def _clear_run(self, message):
        with self.lock:
            self.run = self.plan = self.plan_version = self.lease = None
            self.lease_deadline = 0
            self.message = message

    def _stop_buying(self, message):
        with self.lock:
            self.lease, self.lease_deadline, self.message = None, 0, message
        self.wake.set()

    def _rejected(self, error):
        if error.code == 'sweep_stopped':
            self._clear_run('扫货已结束')
        elif error.code in ('lease_lost', 'plan_changed'):
            with self.lock:
                self.plan = None if error.code == 'plan_changed' else self.plan
            self._stop_buying('扫货规则已更新' if error.code == 'plan_changed' else '与服务器的扫货连接已中断')
        elif error.status == 401:
            self._identity()

    def _leave(self, run, lease, reason, message):
        try:
            self.client.call('POST', '/api/v1/device/sweep/leave', dict(run=run, lease=lease, reason=reason), timeout=5)
        except DeviceError:
            # A stale lease cannot leave; refuse also frees the seat.
            try:
                self.client.call('POST', '/api/v1/device/sweep/refuse', dict(run=run, reason=reason), timeout=5)
            except (OSError, DeviceError):
                pass
        except OSError:
            pass  # The lease then lapses on the server within 30 s.
        with self.lock:
            self.left.add(run)
            if self.run and self.run['id'] == run:
                self.run.setdefault('participant', {})['state'] = 'left'
                self.lease, self.lease_deadline, self.plan, self.message = None, 0, None, message

    def settle(self, body):
        try:
            self.client.call('POST', '/api/v1/device/sweep/settle', body, timeout=3)
            return
        except DeviceError as error:
            if error.status not in (401, 429) and error.status < 500:
                return  # Rejected for good; the server counts unsettled reservations as spent.
        except OSError:
            pass
        with self.lock:
            self.pending.append(dict(body=body, at=time.time()))
            self._save_pending()

    def _save_pending(self):
        try:
            write_json(self.home/'pending.json', self.pending)
        except OSError:
            self.message = '本机待回报记录保存失败'

    def retry_pending(self):
        with self.lock:
            items = list(self.pending)
        for item in items:
            done = time.time()-item.get('at', 0) > 86400
            if not done:
                try:
                    self.client.call('POST', '/api/v1/device/sweep/settle', item['body'], timeout=5)
                    done = True
                except DeviceError as error:
                    done = error.status not in (401, 429) and error.status < 500
                except OSError:
                    return
            if done:
                with self.lock:
                    if item in self.pending:
                        self.pending.remove(item)
                        self._save_pending()

    def poll(self, blocking=True):
        if not self.poll_lock.acquire(blocking):
            return
        try:
            self._identity()
            answer = self.client.call('GET', '/api/v1/device/sweep', timeout=5)
            self._contact()
            self._apply(answer.get('run'))
        finally:
            self.poll_lock.release()

    def _apply(self, run):
        if not isinstance(run, dict) or run.get('status') != 'running' or not isinstance(run.get('id'), str):
            with self.lock:
                if self.run is None:
                    return
                message = self.message if self.run['id'] in self.left else '扫货已结束'
            self._clear_run(message)
            return
        with self.lock:
            if not self.run or self.run['id'] != run['id']:
                self._new_run(run)
            plan = self.plan if self.plan_version == run.get('plan_version') else None
            self.run = {k: v for k, v in run.items() if k != 'plan'}
            if run['id'] in self.left:
                return
            state = (run.get('participant') or {}).get('state')
            settled = self.lease is not None and plan is not None
        if state == 'invited' or state == 'active' and not settled:
            self._decide(run, state == 'invited')

    def _new_run(self, run):
        self.plan = self.plan_version = self.lease = None
        self.lease_deadline, self.checked = 0, 0
        self.seen, self.units, self.spent = set(), {}, 0
        for entry in self._purchases(run['id']):  # Survive a restart within the same run.
            self.seen.add(entry.get('listing'))
            self.spent += entry.get('cost') if type(entry.get('cost')) is int else 0
            if type(entry.get('item_id')) is int and type(entry.get('counted_units')) is int:
                self.units[entry['item_id']] = self.units.get(entry['item_id'], 0)+entry['counted_units']

    def _decide(self, run, invited):
        reason, plan = self._refusal(run)
        if reason:
            with self.lock:
                lease = self.lease
            # Without a lease the server only accepts refuse, which also frees an active seat.
            action = 'leave' if lease and not invited else 'refuse'
            body = dict(run=run['id'], reason=reason)
            if action == 'leave':
                body['lease'] = lease
            try:
                self.client.call('POST', '/api/v1/device/sweep/'+action, body, timeout=5)
            except (OSError, DeviceError):
                pass
            with self.lock:
                self.left.add(run['id'])
                if self.run and self.run['id'] == run['id']:
                    self.run.setdefault('participant', {}).update(state='left' if action == 'leave' else 'refused', message=reason)
                self.lease, self.plan, self.message = None, None, '未参加扫货：'+reason
            return
        started = time.monotonic()
        try:
            answer = self.client.call('POST', '/api/v1/device/sweep/join',
                                      dict(run=run['id'], plan_version=run['plan_version']), timeout=5)
        except DeviceError as error:
            if error.code == 'plan_changed':
                self.wake.set()
            elif error.code == 'sweep_stopped':
                self._clear_run('扫货已结束')
            else:
                with self.lock:
                    self.message = '暂时无法加入扫货'
            return
        lease, ttl = answer.get('lease'), answer.get('expires_in')
        if not isinstance(lease, str) or type(ttl) is not int or ttl < 20:
            with self.lock:
                self.message = '暂时无法加入扫货'
            return
        self._contact()
        with self.lock:
            if not self.run or self.run['id'] != run['id']:
                return
            # The lease guard runs from request START, well inside the server's expiry.
            self.lease, self.lease_deadline, self.ttl = lease, started+min(15, ttl-10), ttl
            self.plan, self.plan_version = plan, run['plan_version']
            self.run.setdefault('participant', {}).update(state='active', plan_version=run['plan_version'])
            self.message = '扫货中'

    def _refusal(self, run):
        """A short Chinese reason not to take part, or (None, validated plan)."""
        with self.lock:
            settings, device = dict(self.settings), (self.device or {}).get('id')
        if run.get('started_by') != device and not settings['allow_web_start']:
            return '本机未允许网页发起扫货', None
        executor = self.purchaser.status()
        if not executor.ready:
            return str(executor.reason or '购买执行器未就绪')[:80], None
        if settings['max_spend'] <= 0:
            return '本机最多花费为 0', None
        try:
            return None, self._plan(run)
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            return ('规则校验失败：'+str(error))[:80], None

    def _plan(self, run):
        watches = (run.get('plan') or {}).get('watches')
        if not isinstance(watches, list) or not 1 <= len(watches) <= 100:
            raise ValueError('没有可扫货的条件组')
        ids = [number(w.get('item_id'), 1000000, 5999999) for w in watches]
        # Names are display only: exact-id lookups, cached, at most 20 per plan.
        for iid in [i for i in ids if i not in self.names][:20]:
            try:
                items = self.client.public('/api/v1/watchlist/catalog?'+urlencode({'q': iid})).get('items') or []
            except (OSError, DeviceError, AttributeError):
                break
            item = next((x for x in items if isinstance(x, dict) and x.get('item_id') == iid), {})
            self.names[iid] = str(item.get('name_zh') or item.get('name_en') or iid)
        # Base stats decide "bonus" rules, so they must load.
        reference = self.client.public('/api/v1/watchlist/listings?'+urlencode({'ids': ','.join(map(str, ids))}))
        enriched = []
        for w in watches:
            enriched.append(dict(item_id=w['item_id'], limit=w.get('limit'), groups=w.get('groups'),
                name=self.names.get(w['item_id'], str(w['item_id'])),
                base_stats=(reference.get('base_stats') or {}).get(str(w['item_id']), [])))
        return configuration(dict(watches=enriched))

    def heartbeat(self):
        with self.lock:
            if not self.run or not self.lease:
                return
            run, lease = self.run['id'], self.lease
            body = dict(run=run, lease=lease, status=dict(message=self.message[:80], checked=self.checked))
        started = time.monotonic()
        try:
            answer = self.client.call('POST', '/api/v1/device/sweep/heartbeat', body, timeout=3)
        except DeviceError as error:
            if error.status == 429 or error.status >= 500:
                return  # Transient: the local guard still expires on time.
            self._rejected(error if error.code in ('sweep_stopped', 'lease_lost') or error.status == 401
                           else DeviceError(409, {'error': 'lease_lost'}))
            return
        except OSError:
            with self.lock:
                if time.monotonic() >= self.lease_deadline:
                    self.message = '与服务器连接中断，已停止购买'
            return
        self._contact()
        with self.lock:
            if self.lease != lease:
                return
            self.lease_deadline = started+min(15, self.ttl-10)
            if type(answer.get('remaining')) is int:
                self.run['remaining'] = answer['remaining']
            if answer.get('plan_version') != self.plan_version:
                self.plan = None  # Stop reserving until the new plan is checked and joined.
                self.message = '扫货规则已更新，正在重新确认'
                self.wake.set()

    def state_body(self):
        from collector_update import VERSION
        executor = self.purchaser.status()
        now = time.monotonic()
        if now-self.game_checked >= 5:
            try:
                self.game_state = bool(self.game())
            except Exception:
                self.game_state = False
            self.game_checked = now
        with self.lock:
            settings = dict(self.settings)
        return dict(client_version=VERSION, sweep=dict(settings, executor=dict(ready=bool(executor.ready),
            reason=str(executor.reason or '')[:80]), game=dict(connected=self.game_state)))

    def report(self, force=False):
        body, now = self.state_body(), time.monotonic()
        if not force and (now < self.report_retry or body == self.reported and now < self.report_due):
            return
        try:
            self.client.call('POST', '/api/v1/device/state', body, timeout=5)
        except Exception:
            self.report_retry = now+10
            raise
        self.reported, self.report_due, self.report_retry = body, now+60, 0

    # Desktop commands.
    def save_settings(self, raw):
        settings = local_settings(raw)
        write_json(self.home/'settings.json', settings)
        with self.lock:
            self.settings = settings
        try:
            self.report(force=True)
        except Exception:
            pass  # The loop retries the report.

    def start_run(self, value):
        if not isinstance(value, dict) or type(value.get('budget')) is not int or type(value.get('minutes')) is not int \
                or not 1 <= value['budget'] <= LIMIT or not 5 <= value['minutes'] <= 720:
            raise ValueError('预算或时长无效')
        self._identity()
        if not self.token:
            raise ValueError('请先登录账号')
        executor = self.purchaser.status()
        if not executor.ready:
            raise ValueError(executor.reason or '购买执行器未就绪')
        if self.settings['max_spend'] <= 0:
            raise ValueError('请先设置本机最多花费')
        answer = self.client.call('POST', '/api/v1/device/sweep/start',
                                  dict(budget=value['budget'], minutes=value['minutes']), timeout=10)
        with self.poll_lock:
            self._apply(answer.get('run'))

    def stop_run(self):
        with self.lock:
            run = self.run and self.run['id']
            if run:
                self.left.add(run)  # Buying stops here even if the server is unreachable.
        if run:
            self._stop_buying('正在停止扫货')
            self.client.call('POST', '/api/v1/device/sweep/stop', dict(run=run), timeout=10)
            self._clear_run('扫货已停止')

    def logout(self):
        # Stop buying, let a purchase in progress finish and report it, then revoke the token.
        self._stop_buying('正在退出账号')
        if self.shop_lock.acquire(timeout=40):
            self.shop_lock.release()
        self.retry_pending()
        with self.poll_lock:
            self._clear_run('已退出账号')
            self.client.logout()
        self._identity()

    # Background work.
    def _event(self, name):
        if name == 'sweep':
            self.wake.set()

    def _local_events(self):
        # Pages and this engine share the dashboard's single upstream stream.
        import urllib.request
        address = urlsplit(json.loads(self.dashboard.read_text(encoding='utf-8'))['url'])
        if address.scheme != 'http' or address.hostname != '127.0.0.1' or not address.port:
            raise ValueError('Invalid dashboard address')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        response = opener.open(f'http://127.0.0.1:{address.port}/api/v1/account/events', timeout=45)
        return response, lambda: True

    def start(self):
        self.thread = threading.Thread(target=self._loop, name='sweep-engine', daemon=True)
        self.thread.start()
        if self.dashboard:
            self.events.start()

    def close(self):
        self.closed.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=5)

    def _loop(self):
        next_poll = next_beat = next_pending = 0
        while not self.closed.is_set():
            woke = self.wake.is_set()
            self.wake.clear()
            try:
                self._identity()
                if self.token:
                    now = time.monotonic()
                    if self.lease and now >= next_beat:
                        next_beat = now+5
                        self.heartbeat()
                    if woke or now >= next_poll:
                        next_poll = now+15
                        self.poll(blocking=False)
                    self.report()
                    if self.pending and now >= next_pending:
                        next_pending = now+10
                        self.retry_pending()
                with self.lock:
                    if self.connected and time.monotonic()-self.connected_at > 30:
                        self.connected = False
                        if self.run:
                            self.message = '与服务器连接中断，已停止购买'
            except (OSError, DeviceError, RuntimeError):
                pass  # Offline or still starting; every step retries on its own schedule.
            except Exception as error:
                print(f'Sweep engine deferred ({type(error).__name__}: {error}).', flush=True)
            self.wake.wait(1)


def create_engine(runtime):
    """The desktop app's engine; runtime is unified_client.CollectorRuntime."""
    from account_device import DeviceClient
    engine = SweepEngine(runtime.folder, DeviceClient(runtime.configuration, runtime.home),
                         dashboard=runtime.home/'dashboard.json')
    runtime.add_listener(engine.collector_event)
    return engine
