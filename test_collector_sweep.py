import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from account_device import DeviceError
from collector_sweep import SweepEngine, configuration, listing_key
from sweep_purchase import PurchaseHalt, PurchaseResult, PurchaserStatus, UnavailablePurchaser, load_purchaser

TOKEN = 'cwd_'+'A'*43
RECORD = dict(token=TOKEN, account=dict(id='acct-1', nickname='Tester'), device=dict(id='dev-1', name='PC'))
ITEM = 1002000


def group(**reminder):
    return dict(id='g1', name='Rule', cap=100, notify=False, buy=True, reminder=reminder)


def plan(item=ITEM, limit=10, **reminder):
    return {'watches': [dict(item_id=item, limit=limit, groups=[group(**reminder)])]}


class FakeServer:
    """The device API seen through DeviceClient.call/public/record/logout."""
    def __init__(self):
        self.record_value = dict(RECORD)
        self.calls = []
        self.down = set()
        self.run = None
        self.grant = None
        self.lease = 1

    def invite(self, started_by='web', version=1, **change):
        self.run = dict(id='run-1', status='running', budget=10000, remaining=10000, ends_at='later', started_by=started_by,
                        plan=change.pop('plan', plan()), plan_version=version, spent_here=0,
                        participant=dict(state='invited', message='', plan_version=None), **change)

    def record(self):
        return self.record_value

    def logout(self):
        self.calls.append(('logout', None))
        self.record_value = None

    def public(self, path, timeout=10):
        if path.startswith('/api/v1/watchlist/catalog?q='):
            names = {str(ITEM): '测试帽', '4000000': '蜗牛壳'}
            item = path.rsplit('=', 1)[1]
            return {'items': [{'item_id': int(item), 'name_zh': names[item]}] if item in names else []}
        return {'base_stats': {str(ITEM): [['str', 1]]}}

    def named(self, path):
        return [body for name, body in self.calls if name == path]

    def call(self, method, path, body=None, timeout=10):
        name = path.rsplit('/', 1)[-1]
        self.calls.append((name, body))
        if name in self.down:
            raise OSError('offline')
        handler = getattr(self, 'on_'+name, None)
        return handler(body) if handler else {'ok': True}

    def on_sweep(self, body):
        return {'run': json.loads(json.dumps(self.run))}

    def on_join(self, body):
        if body['plan_version'] != self.run['plan_version']:
            raise DeviceError(409, {'error': 'plan_changed'})
        self.run['participant']['state'] = 'active'
        self.lease += 1
        return {'lease': f'lease-{self.lease}', 'expires_in': 30}

    def on_heartbeat(self, body):
        return {'plan_version': self.run['plan_version'], 'remaining': self.run['remaining']}

    def on_reserve(self, body):
        granted = body['quantity'] if self.grant is None else self.grant
        if not granted:
            return {'granted': 0, 'reason': 'item_limit'}
        return {'reservation': 'res-%d' % len(self.named('reserve')), 'granted': granted, 'expires_in': 30}

    def on_start(self, body):
        self.invite(started_by='dev-1', plan=dict(plan(), scan=body.get('scan', {'mode':'market'})))
        self.run['id'] = 'run-2'
        return {'run': json.loads(json.dumps(self.run))}


class FakePurchaser:
    def __init__(self, ready=True, mesos=None, result=None):
        self.ready, self.mesos, self.orders = ready, mesos, []
        self.result = result or (lambda order: PurchaseResult('bought', order.quantity, order.quantity*order.price))

    def status(self):
        return PurchaserStatus(self.ready, '' if self.ready else '执行器未就绪', self.mesos)

    def buy(self, order, window):
        self.orders.append((order, window))
        return self.result(order)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.server = FakeServer()
        self.purchaser = FakePurchaser()
        self.engine = self.make()

    def make(self):
        return SweepEngine(self.folder, self.server, self.purchaser, game=lambda: True)

    def settings(self, **change):
        self.engine.save_settings(dict(dict(allow_web_start=True, max_spend=100000, max_order=0, reserve_mesos=0), **change))

    def joined(self, **change):
        self.settings(**change)
        self.server.invite()
        self.engine.poll()
        self.assertTrue(self.engine.buying(), self.engine.message)

    def capture(self, name='shop_a.json', items=None, room=3, channel=8, owner=123, **extra):
        rows = items or [dict(item_id=ITEM, slot=1, price_mesos_candidate=100, bundle_quantity_candidate=1, available_quantity_candidate=3)]
        raw = dict(session='s1', time=time.time(), shop_id=55, title='Shop', triggered_by_python=False,
                   market_location=dict(room=room, channel=channel) if room else None, items=rows,
                   owner=dict(character_id=owner, name='Owner', parser='cw_shop_owner_v1'), **extra)
        path = self.folder/name
        path.write_text(json.dumps(raw), encoding='utf-8')
        return {'file': str(path.resolve())}

    def test_settings_defaults_are_off_and_validated(self):
        self.assertEqual(self.engine.settings, dict(allow_web_start=False, max_spend=0, max_order=0, reserve_mesos=0))
        for bad in [dict(allow_web_start=1, max_spend=0, max_order=0, reserve_mesos=0),
                    dict(allow_web_start=True, max_spend=-1, max_order=0, reserve_mesos=0),
                    dict(allow_web_start=True, max_spend=10**12+1, max_order=0, reserve_mesos=0),
                    dict(allow_web_start=True, max_spend=True, max_order=0, reserve_mesos=0)]:
            with self.assertRaises(ValueError):
                self.engine.save_settings(bad)
        self.settings(max_spend=500)
        self.assertEqual(self.make().settings['max_spend'], 500)
        state = self.server.named('state')[-1]
        self.assertEqual(state['sweep']['max_spend'], 500)
        self.assertEqual(state['sweep']['executor'], {'ready': True, 'reason': ''})
        self.assertEqual(state['sweep']['game'], {'connected': True})
        self.assertIn('client_version', state)

    def test_state_is_reported_on_change_and_every_minute(self):
        self.engine._identity()
        self.engine.report()
        self.engine.report()
        self.assertEqual(len(self.server.named('state')), 1)
        self.purchaser.ready = False
        self.engine.report()
        self.assertEqual(self.server.named('state')[-1]['sweep']['executor']['ready'], False)
        self.engine.report_due = 0
        self.engine.report()
        self.assertEqual(len(self.server.named('state')), 3)
        self.server.down.add('state')
        self.purchaser.ready = True
        with self.assertRaises(OSError):
            self.engine.report()
        self.engine.report()  # Backs off instead of retrying every second.
        self.assertEqual(len(self.server.named('state')), 4)

    def test_refuse_reasons(self):
        cases = [(dict(allow_web_start=False), None, '本机未允许网页发起扫货'),
                 ({}, FakePurchaser(ready=False), '执行器未就绪'),
                 (dict(max_spend=0), None, '本机最多花费为 0'),
                 ({}, None, '规则校验失败：扫货需使用固定最高价与已知属性')]
        for change, purchaser, reason in cases:
            self.engine = SweepEngine(self.folder, self.server, purchaser or self.purchaser, game=lambda: True)
            self.settings(**change)
            self.server.invite(plan=plan(percentile='10') if reason.startswith('规则') else plan())
            self.engine.poll()
            self.assertEqual(self.server.named('refuse')[-1], {'run': 'run-1', 'reason': reason})
            self.assertFalse(self.engine.buying())
            self.assertEqual(self.engine.status()['sweep']['run']['state'], 'refused')
            self.engine.poll()
            self.assertEqual(len(self.server.named('refuse')), cases.index((change, purchaser, reason))+1, 'decided once')
        self.assertEqual(self.server.named('join'), [])

    def test_device_started_run_needs_no_web_permission(self):
        self.settings(allow_web_start=False)
        self.server.invite(started_by='dev-1')
        self.engine.poll()
        self.assertEqual(self.server.named('join'), [{'run': 'run-1', 'plan_version': 1}])
        self.assertEqual(self.engine.plan['watches'][0]['name'], '测试帽')
        self.assertEqual(self.engine.plan['watches'][0]['base'], {'str': 1})

    def test_join_heartbeat_and_local_guard_from_request_start(self):
        clock = [1000.0]
        with patch('collector_sweep.time.monotonic', lambda: clock[0]):
            self.joined()
            self.assertEqual(self.engine.lease_deadline, 1015.0)
            clock[0] = 1005
            self.engine.heartbeat()
            self.assertEqual(self.engine.lease_deadline, 1020.0)
            self.assertEqual(self.server.named('heartbeat')[-1]['lease'], 'lease-2')
            self.assertNotIn('pending', self.server.named('heartbeat')[-1]['status'], 'market mode reports no revisit count')
            # Recent-match progress carries the revisit count; waiting is 0; leaving the mode clears it.
            self.engine.progress('近期命中：3 洞 · 12频道 · 待访 7 处', revisits=7)
            self.engine.heartbeat()
            self.assertEqual(self.server.named('heartbeat')[-1]['status'], {'message': '近期命中：3 洞 · 12频道 · 待访 7 处', 'checked': 0, 'pending': 7})
            self.engine.progress('等待新的命中店铺', revisits=0)
            self.engine.heartbeat()
            self.assertEqual(self.server.named('heartbeat')[-1]['status']['pending'], 0)
            self.engine.progress('扫货中')
            self.engine.heartbeat()
            self.assertNotIn('pending', self.server.named('heartbeat')[-1]['status'])
            self.server.down.add('heartbeat')
            clock[0] = 1010
            self.engine.heartbeat()
            self.assertTrue(self.engine.buying())
            clock[0] = 1020
            self.assertFalse(self.engine.buying(), 'no renewal for 15 s stops buying')
            self.assertIsNone(self.engine.receipt())

    def test_lost_lease_rejoins_and_stopped_run_ends(self):
        self.joined()
        self.server.on_heartbeat = lambda body: (_ for _ in ()).throw(DeviceError(409, {'error': 'lease_lost'}))
        self.engine.heartbeat()
        self.assertFalse(self.engine.buying())
        self.engine.poll()
        self.assertTrue(self.engine.buying())
        self.assertEqual(len(self.server.named('join')), 2)
        self.server.on_heartbeat = lambda body: (_ for _ in ()).throw(DeviceError(409, {'error': 'sweep_stopped', 'reason': 'time_up'}))
        self.engine.heartbeat()
        self.assertIsNone(self.engine.status()['sweep']['run'])
        self.assertFalse(self.engine.buying())

    def test_plan_version_change_pauses_reserving_until_rejoined(self):
        self.joined()
        self.server.run['plan_version'] = 2
        self.server.run['plan'] = plan(limit=5)
        self.engine.heartbeat()
        self.assertFalse(self.engine.buying())
        self.engine.on_shop_open(self.capture(), 'window')
        self.assertEqual(self.server.named('reserve'), [])
        self.engine.poll()
        self.assertEqual(self.server.named('join')[-1], {'run': 'run-1', 'plan_version': 2})
        self.assertEqual(self.engine.plan['watches'][0]['limit'], 5)
        self.assertTrue(self.engine.buying())

    def test_invalid_new_plan_leaves(self):
        self.joined()
        self.server.run.update(plan_version=2, plan=plan(equipment='missing'))
        self.engine.poll()
        self.assertEqual(self.server.named('leave')[-1]['reason'][:6], '规则校验失败')
        self.assertFalse(self.engine.buying())

    def test_full_purchase_reserve_buy_settle_and_local_record(self):
        self.joined()
        self.engine.on_shop_open(self.capture(), 'window')
        reserve = self.server.named('reserve')[0]
        self.assertEqual((reserve['quantity'], reserve['price'], reserve['stock'], reserve['plan_version']), (3, 100, 3, 1))
        self.assertEqual(reserve['location'], dict(room=3, channel=8, shop_id=55, owner='Owner', category=1, slot=1))
        self.assertRegex(reserve['listing'], r'^[0-9a-f]{64}$')
        order, window = self.purchaser.orders[0]
        self.assertEqual((order.quantity, order.reservation, window, order.room, order.channel), (3, 'res-1', 'window', 3, 8))
        self.assertGreater(order.deadline-time.monotonic(), 10)
        self.assertLessEqual(order.deadline, self.engine.lease_deadline)
        self.assertEqual(self.server.named('settle'), [dict(reservation='res-1', status='bought', quantity=3, spent=300, reason='')])
        recent = self.engine.status()['sweep']['recent'][0]
        self.assertEqual({k: recent[k] for k in ('name', 'status', 'quantity', 'units', 'spent', 'room', 'channel', 'owner')},
                         dict(name='测试帽', status='bought', quantity=3, units=3, spent=300, room=3, channel=8, owner='Owner'))
        self.assertEqual(self.engine.status()['sweep']['run']['spent_here'], 300)
        self.assertTrue((self.folder/'sweep/purchases.jsonl').is_file())
        self.engine.on_shop_open(self.capture('shop_again.json'), 'window')
        self.assertEqual(len(self.server.named('reserve')), 1, 'the same listing is reserved once')
        restarted = self.make()
        restarted.poll()
        restarted.on_shop_open(self.capture('shop_third.json'), 'window')
        self.assertEqual(len(self.server.named('reserve')), 1, 'a restart within the run keeps the listing and spend')
        self.assertEqual(restarted.spent, 300)

    def test_partial_and_zero_grants(self):
        self.joined()
        self.server.grant = 1
        self.engine.on_shop_open(self.capture(), 'window')
        self.assertEqual(self.purchaser.orders[-1][0].quantity, 1)
        self.server.grant = 0
        self.engine.on_shop_open(self.capture('shop_b.json', owner=456), 'window')
        self.assertEqual(len(self.purchaser.orders), 1)
        self.assertEqual(self.engine.status()['sweep']['recent'][0]['reason'], 'item_limit')

    def test_preparation_reads_balance_before_reservation_and_honors_native_batch(self):
        self.joined(reserve_mesos=100)
        self.purchaser.mesos = 10000
        self.purchaser.max_quantity = 1
        self.purchaser.prepare = lambda window: setattr(self.purchaser, 'mesos', 250)
        self.engine.on_shop_open(self.capture(), 'window')
        self.assertEqual(self.server.named('reserve')[0]['quantity'], 1)
        self.assertEqual(self.purchaser.orders[0][0].reserve_mesos, 100)

    def test_unverified_window_leaves_run_without_reserving_or_automatic_rejoin(self):
        self.joined()
        def invalid(window):
            raise RuntimeError('Unreadable shop')
        self.purchaser.prepare = invalid
        with self.assertRaises(PurchaseHalt):
            self.engine.on_shop_open(self.capture(), 'window')
        self.assertEqual(self.server.named('reserve'), [])
        self.assertEqual(self.server.named('leave')[-1]['reason'], 'window_lost')
        self.engine.poll()
        self.assertFalse(self.engine.buying())

    def test_unsupported_untouched_shop_skips_without_reserving(self):
        self.joined()
        self.purchaser.prepare = lambda window: False
        self.engine.on_shop_open(self.capture(), 'window')
        self.assertEqual(self.server.named('reserve'), [])
        self.assertEqual(self.purchaser.orders, [])
        self.assertEqual(self.server.named('leave'), [])
        self.assertTrue(self.engine.buying())

    def test_local_caps_bound_the_reservation(self):
        self.purchaser.mesos = 1000
        self.joined(max_spend=250)
        self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.server.named('reserve')[-1]['quantity'], 2)
        self.engine.on_shop_open(self.capture('shop_b.json', owner=2), 'w')
        self.assertEqual(len(self.server.named('reserve')), 1, 'max_spend reached without asking the server')
        self.assertEqual(self.engine.status()['sweep']['recent'][0]['reason'], 'max_spend')
        self.settings(max_spend=10000, max_order=150)
        self.engine.on_shop_open(self.capture('shop_c.json', owner=3), 'w')
        self.assertEqual(self.server.named('reserve')[-1]['quantity'], 1)
        self.settings(max_spend=10000, reserve_mesos=850)
        self.engine.on_shop_open(self.capture('shop_d.json', owner=4), 'w')
        self.assertEqual(self.server.named('reserve')[-1]['quantity'], 1)
        self.settings(max_spend=10000, reserve_mesos=950)
        self.engine.on_shop_open(self.capture('shop_e.json', owner=5), 'w')
        self.assertEqual(self.engine.status()['sweep']['recent'][0]['reason'], 'reserve_mesos')

    def test_batch_orders_use_remaining_item_allowance_across_listings(self):
        self.joined()
        self.engine.plan = configuration(plan(limit=193))
        self.purchaser.max_quantity = 9999
        self.purchaser.mesos = 50000
        self.engine.run['remaining'] = 97527
        rows = [dict(item_id=ITEM, slot=slot, price_mesos_candidate=100,
                     bundle_quantity_candidate=1, available_quantity_candidate=100) for slot in (1,2,3)]
        self.engine.on_shop_open(self.capture(items=rows), 'w')
        self.assertEqual([o.quantity for o,_ in self.purchaser.orders], [100,93])
        self.assertEqual(self.engine.units[ITEM],193)
        self.assertEqual(self.engine.spent,19300)
        self.assertEqual(self.engine.status()['sweep']['recent'][0]['reason'],'item_limit')

    def test_unlimited_quantity_keeps_budget_and_per_order_guards(self):
        self.joined(max_spend=15000)
        self.engine.plan = configuration(plan(limit=0))
        self.engine.units[ITEM] = 20000
        self.purchaser.max_quantity = 100
        self.engine.run['remaining'] = 15000
        rows = [dict(item_id=ITEM, slot=slot, price_mesos_candidate=100,
                     bundle_quantity_candidate=1, available_quantity_candidate=500) for slot in (1, 2, 3)]
        self.engine.on_shop_open(self.capture(items=rows), 'w')
        self.assertEqual([o.quantity for o, _ in self.purchaser.orders], [100, 50])
        self.assertEqual(self.engine.units[ITEM], 20150)
        self.assertEqual(self.engine.spent, 15000)
        self.assertEqual(self.engine.status()['sweep']['recent'][0]['reason'], 'max_spend')

    def test_ammunition_counts_sets_and_bundles_count_items(self):
        self.joined()
        rows = [dict(item_id=ITEM, slot=1, price_mesos_candidate=180, bundle_quantity_candidate=2, available_quantity_candidate=10)]
        self.server.run['plan'] = plan(limit=5)
        self.engine.plan = configuration({'watches': [dict(item_id=ITEM, limit=5, groups=[group()])]})
        self.engine.on_shop_open(self.capture(items=rows), 'w')
        self.assertEqual(self.server.named('reserve')[-1]['quantity'], 2, '5 items // bundle 2')

    def test_unknown_result_settles_and_leaves(self):
        self.purchaser.result = lambda order: PurchaseResult('unknown', reason='timeout')
        self.joined()
        with self.assertRaises(PurchaseHalt):
            self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.server.named('settle')[-1]['status'], 'unknown')
        self.assertEqual(self.server.named('leave')[-1], dict(run='run-1', lease='lease-2', reason='unknown'))
        self.assertFalse(self.engine.buying())
        self.assertEqual(self.engine.spent, 300, 'unknown counts the whole reservation')
        self.engine.poll()
        self.assertEqual(len(self.server.named('join')), 1, 'never rejoins a run it left')

    def test_contract_breaking_result_and_purchaser_crash_are_unknown(self):
        self.purchaser.result = lambda order: PurchaseResult('bought', order.quantity+1, 0)
        self.joined()
        with self.assertRaises(PurchaseHalt):
            self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.server.named('settle')[-1]['status'], 'unknown')
        self.server.run['participant']['state'] = 'active'
        self.engine.left.clear()
        self.engine.poll()
        def crash(order):
            raise RuntimeError('window lost')
        self.purchaser.result = crash
        with self.assertRaises(PurchaseHalt) as caught:
            self.engine.on_shop_open(self.capture('shop_b.json', owner=9), 'w')
        self.assertIsInstance(caught.exception.__cause__, RuntimeError)
        self.assertEqual(self.server.named('settle')[-1]['status'], 'unknown')
        self.assertFalse(self.engine.buying())

    def test_trade_lock_settles_zero_and_stops_other_rows(self):
        self.purchaser.result = lambda order: PurchaseResult('not_bought', reason='trade_locked')
        self.joined()
        rows = [dict(item_id=ITEM, slot=slot, price_mesos_candidate=100,
                     bundle_quantity_candidate=1, available_quantity_candidate=3) for slot in (1, 2)]
        self.engine.on_shop_open(self.capture(items=rows), 'w')
        self.assertEqual(len(self.purchaser.orders), 1)
        self.assertEqual(self.server.named('settle')[-1], dict(
            reservation='res-1', status='not_bought', quantity=0, spent=0, reason='trade_locked'))
        self.assertEqual(self.engine.spent, 0)
        self.assertFalse(self.engine.buying())
        self.engine.poll()
        self.assertEqual(len(self.server.named('join')), 1)

    def test_known_result_with_unrestored_window_is_settled_before_halt(self):
        self.joined()
        self.server.down.add('settle')
        def halt(order):
            raise PurchaseHalt(PurchaseResult('not_bought', reason='stopped'))
        self.purchaser.result = halt
        with self.assertRaises(PurchaseHalt):
            self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.engine.pending[0]['body']['status'], 'not_bought')
        self.assertEqual(self.engine.pending[0]['body']['reason'], 'stopped')
        self.assertFalse(self.engine.buying())
        self.assertEqual(self.engine.spent, 0)

    def test_inflight_purchase_guard_stops_on_run_lease_plan_and_local_stop(self):
        self.joined()
        def verify(order):
            self.assertTrue(order.can_buy())
            self.assertLessEqual(order.deadline, self.engine.lease_deadline)
            for field, replacement in [('plan_version', 99), ('lease', 'new-lease'), ('plan', None)]:
                saved = getattr(self.engine, field)
                setattr(self.engine, field, replacement)
                self.assertFalse(order.can_buy(), field)
                setattr(self.engine, field, saved)
            self.engine.lease_deadline = time.monotonic()-1
            self.assertFalse(order.can_buy(), 'expired lease')
            self.engine.lease_deadline = time.monotonic()+15
            self.engine._stop_buying('stopped')
            self.assertFalse(order.can_buy(), 'stopped on web or device')
            return PurchaseResult('not_bought', reason='stopped')
        self.purchaser.result = verify
        self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.server.named('settle')[-1]['reason'], 'stopped')

    def test_failed_settle_is_queued_and_retried(self):
        self.joined()
        self.server.down.add('settle')
        self.engine.on_shop_open(self.capture(), 'w')
        pending = json.loads((self.folder/'sweep/pending.json').read_text())
        self.assertEqual(pending[0]['body']['reservation'], 'res-1')
        self.engine.retry_pending()
        self.assertEqual(len(self.engine.pending), 1)
        self.assertEqual(len(self.make().pending), 1, 'pending survives a restart')
        self.server.down.clear()
        self.engine.retry_pending()
        self.assertEqual(self.engine.pending, [])
        self.assertEqual(json.loads((self.folder/'sweep/pending.json').read_text()), [])

    def test_stop_while_reserving_settles_without_buying(self):
        self.joined()
        reserve = self.server.on_reserve
        def stopped_meanwhile(body):
            self.engine._stop_buying('stopped')
            return reserve(body)
        self.server.on_reserve = stopped_meanwhile
        self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.purchaser.orders, [])
        self.assertEqual(self.server.named('settle'), [dict(reservation='res-1', status='not_bought', quantity=0, spent=0, reason='stopped')])

    def test_logout_reports_pending_settles_before_revoking(self):
        self.joined()
        self.server.down.add('settle')
        self.engine.on_shop_open(self.capture(), 'w')
        self.server.down.clear()
        self.engine.logout()
        names = [name for name, _ in self.server.calls]
        self.assertLess(len(names)-1-names[::-1].index('settle'), names.index('logout'))
        self.assertEqual(self.engine.pending, [])

    def test_rejected_settle_without_token_is_kept(self):
        self.joined()
        def revoked(body):
            raise DeviceError(401, {'error': 'login_required'})
        self.server.on_settle = revoked
        self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(len(self.engine.pending), 1)

    def test_leaving_without_a_lease_refuses(self):
        self.joined()
        self.purchaser.ready = False
        self.engine._stop_buying('not ready')
        self.engine.poll()
        self.assertTrue(self.server.named('refuse'), self.server.calls)
        self.assertNotIn(None, [body.get('lease') for body in self.server.named('leave')])

    def test_unreachable_server_or_lost_lease_never_buys(self):
        self.joined()
        self.server.down.add('reserve')
        self.engine.on_shop_open(self.capture(), 'w')
        self.assertEqual(self.purchaser.orders, [])
        self.server.down.clear()
        self.server.on_reserve = lambda body: (_ for _ in ()).throw(DeviceError(409, {'error': 'lease_lost'}))
        self.engine.on_shop_open(self.capture('shop_b.json', owner=2), 'w')
        self.assertEqual(self.purchaser.orders, [])
        self.assertFalse(self.engine.buying())

    def test_capture_without_room_or_old_folder_is_skipped(self):
        self.joined()
        self.engine.on_shop_open(self.capture(room=None), 'w')
        self.assertEqual(self.server.named('reserve'), [])
        self.assertIn('洞频道', self.engine.message)
        outside = Path(tempfile.mkdtemp(dir=self.temp.name))/'shop_x.json'
        outside.write_text((self.folder/'shop_a.json').read_text())
        self.engine.on_shop_open({'file': str(outside)}, 'w')
        self.assertEqual(self.server.named('reserve'), [])

    def test_receipt_pairs_one_visit_with_one_collector_capture(self):
        self.assertIsNone(self.engine.receipt(), 'no receipt (and no scan slowdown) while not buying')
        self.joined()
        receipt = self.engine.receipt()
        self.assertIsNone(receipt.poll())
        self.capture()
        self.engine.collector_event({'type': 'captured', 'file': 'shop_a.json', 'items': 1})
        self.assertEqual(receipt.poll()['file'], str((self.folder/'shop_a.json').resolve()))
        self.capture('shop_b.json')
        self.engine.collector_event({'type': 'captured', 'file': 'shop_b.json', 'items': 1})
        with self.assertRaises(RuntimeError):
            receipt.poll()
        self.assertEqual(self.engine.receipt().poll(), None)

    def test_logout_stop_and_start(self):
        self.joined()
        self.engine.stop_run()
        self.assertEqual(self.server.named('stop'), [{'run': 'run-1'}])
        self.assertFalse(self.engine.buying())
        with self.assertRaises(ValueError):
            self.engine.start_run({'budget': 0, 'minutes': 60})
        self.server.run = None
        self.engine.start_run({'budget': 5000, 'minutes': 10080})
        self.assertEqual(self.server.named('start'), [{'budget': 5000, 'minutes': 10080, 'devices': None, 'scan': {'mode':'priority'}}])
        with self.assertRaises(ValueError):
            self.engine.start_run({'budget': 5000, 'minutes': 10081})
        self.assertTrue(self.engine.buying())
        self.engine.logout()
        self.assertFalse(self.engine.buying())
        status = self.engine.status()
        self.assertEqual((status['linked'], status['account'], status['sweep']['run']), (False, None, None))
        with self.assertRaises(ValueError):
            self.engine.start_run({'budget': 5000, 'minutes': 60})

    def test_start_requires_ready_executor(self):
        self.purchaser.ready = False
        with self.assertRaises(ValueError):
            self.engine.start_run({'budget': 5000, 'minutes': 60})
        self.assertEqual(self.server.named('start'), [])

    def test_shared_budget_ignores_legacy_local_caps_and_buys_other_shops(self):
        self.settings(allow_web_start=False, max_spend=0, max_order=1, reserve_mesos=10000)
        self.server.invite(plan=dict(plan(), scan={'mode':'priority'}))
        self.engine.poll()
        self.assertTrue(self.engine.buying())
        self.engine.on_shop_open(self.capture(), 12)
        self.assertEqual(len(self.purchaser.orders), 1)
        self.assertEqual(self.purchaser.orders[0][0].quantity, 3)

    def test_status_contract_shape(self):
        self.joined()
        status = self.engine.status()
        self.assertEqual(set(status), {'linked', 'account', 'device', 'sweep'})
        self.assertEqual(set(status['sweep']), {'settings', 'executor', 'run', 'recent', 'message', 'holdings', 'rules'})
        self.assertEqual(set(status['sweep']['run']), {'id', 'status', 'budget', 'remaining', 'ends_at', 'started_by',
                                                       'state', 'message', 'spent_here', 'plan_version',
                                                       'spent', 'bought', 'items', 'started_at', 'checked', 'devices', 'plan_stale'})
        # An older server sends no run totals: they stay unknown rather than zero.
        self.assertEqual((status['sweep']['run']['spent'], status['sweep']['run']['bought'], status['sweep']['run']['items']), (None, None, []))
        self.assertNotIn(TOKEN, json.dumps(status))
        self.assertEqual(self.engine.summary()['enabled'], True)


    def test_run_totals_rules_and_heartbeat_spent_reach_the_status(self):
        self.server.invite(spent=400, bought=3, items=[dict(item_id=ITEM, limit=10, units=4, bought=3)])
        self.settings()
        self.engine.poll()
        run = self.engine.status()['sweep']['run']
        self.assertEqual((run['spent'], run['bought'], run['items']), (400, 3, [dict(item_id=ITEM, limit=10, units=4, bought=3)]))
        rules = self.engine.status()['sweep']['rules']
        self.assertEqual(rules, {'watches': [dict(item_id=ITEM, name='测试帽', limit=10, groups=[group()])]})
        self.server.on_heartbeat = lambda body: {'plan_version': 1, 'remaining': 9000, 'spent': 1000}
        self.engine.heartbeat()
        self.assertEqual(self.engine.status()['sweep']['run']['spent'], 1000)

    def test_idle_rules_come_from_the_plan_endpoint_and_follow_data_events(self):
        self.server.on_plan = lambda body: {'plan': {'watches': [dict(item_id=4000000, limit=0, groups=[group()])]}}
        self.assertIsNone(self.engine.status()['sweep']['rules'])
        self.engine.refresh_rules()
        self.assertEqual(self.engine.status()['sweep']['rules'],
                         {'watches': [dict(item_id=4000000, name='蜗牛壳', limit=0, groups=[group()])]})
        self.server.on_plan = lambda body: {'plan': {'watches': []}}
        self.engine.rules_due = 10**9
        self.engine._event('data')
        self.assertLess(self.engine.rules_due, 10**9)
        self.engine.refresh_rules()
        self.assertEqual(self.engine.status()['sweep']['rules'], {'watches': []})
        def missing(body):
            raise DeviceError(404, {'error': 'not_found'})
        self.server.on_plan = missing  # An older server.
        self.engine.refresh_rules()
        self.assertIsNone(self.engine.status()['sweep']['rules'])

    def test_bought_rows_reach_listeners_with_price(self):
        seen = []
        self.engine.add_listener(seen.append)
        self.engine.add_listener(lambda entry: 1/0)  # A broken display never disturbs buying.
        self.joined()
        self.engine.on_shop_open(self.capture(), 'window')
        self.assertEqual([(e['name'], e['units'], e['price'], e['room'], e['channel'], e['owner']) for e in seen],
                         [('测试帽', 3, 100, 3, 8, 'Owner')])
        self.assertEqual(self.engine.status()['sweep']['recent'][0]['price'], 100)

    def test_devices_and_rename_use_the_device_token(self):
        self.server.on_devices = lambda body: {'devices': [dict(id='dev-1', name='PC', online=True), 'junk']}
        self.assertEqual(self.engine.devices(), {'devices': [dict(id='dev-1', name='PC', online=True)]})
        self.server.on_rename = lambda body: {'device': {'id': 'dev-1', 'name': body['name']}}
        self.server.store = Mock()
        self.engine.rename({'name': '  书房电脑 '})
        self.server.store.save.assert_called_once_with(dict(RECORD, device=dict(id='dev-1', name='书房电脑')))
        self.assertEqual(self.server.named('rename'), [{'name': '书房电脑'}])
        self.assertEqual(self.engine.status()['device'], {'id': 'dev-1', 'name': '书房电脑'})
        for bad in [{'name': ''}, {'name': '长'*41}, {'name': 'a\nb'}, {'name': 5}, None]:
            with self.assertRaises(ValueError):
                self.engine.rename(bad)
        self.assertEqual(len(self.server.named('rename')), 1)


class PlanTests(unittest.TestCase):
    def test_server_resolved_percentile_is_compatible_with_existing_executor(self):
        raw = plan(limit=0)
        raw['source_watches'] = copy.deepcopy(raw['watches'])
        resolved = raw['watches'][0]['groups'][0]
        resolved.update(cap=123.5, price_percentile='25')
        clean = configuration(raw)
        self.assertEqual(clean['watches'][0]['groups'][0]['cap'], 123.5)
        self.assertEqual(clean['watches'][0]['limit'], 0)

    def test_configuration_validates_the_server_plan(self):
        clean = configuration({'watches': [dict(item_id=ITEM, limit=2, name='Hat', groups=[group(minUpgrades=0, maxUpgrades=0)])]})
        self.assertEqual(clean['watches'][0]['groups'][0]['max_upgrades'], 0)
        for bad in [{'watches': []}, {'watches': [dict(item_id=ITEM, limit=2, groups=[dict(group(), buy=False)])]},
                    {'watches': [dict(item_id=ITEM, limit=2, groups=[dict(group(), cap=None)])]},
                    {'watches': [dict(item_id=ITEM, limit=-1, groups=[group()])]}, {'mode': 'simulate'}]:
            with self.assertRaises(ValueError):
                configuration(bad)

    def test_listing_identity_changes_with_price_and_owner(self):
        row = dict(item_id=ITEM, category=1, slot=1, price=100, bundle=1, equipment=None)
        key = listing_key(dict(room=1, channel=2), 7, row)
        self.assertNotEqual(key, listing_key(dict(room=1, channel=2), 8, row))
        self.assertNotEqual(key, listing_key(dict(room=1, channel=2), 7, dict(row, price=99)))

    def test_without_executor_module_purchases_are_unavailable(self):
        with patch.dict('sys.modules', {'sweep_purchaser_windows': None}):
            purchaser = load_purchaser()
        self.assertIsInstance(purchaser, UnavailablePurchaser)
        self.assertEqual(purchaser.status(), PurchaserStatus(False, '购买功能加载失败', None))

    def test_executor_start_failure_has_the_same_reason(self):
        broken = type('Module', (), {'create': staticmethod(lambda: 1/0)})
        with patch.dict('sys.modules', {'sweep_purchaser_windows': broken}):
            purchaser = load_purchaser()
        self.assertEqual(purchaser.status(), PurchaserStatus(False, '购买功能加载失败', None))


if __name__ == '__main__':
    unittest.main()
