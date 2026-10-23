"""Inventory-aware selling proposals. No game input or sale execution.

Inventory records are player-maintained until a client inventory decoder has
been verified. Venue ranks measure observed supply, not buyer traffic/sales.
"""
from collections import defaultdict
from decimal import Decimal, ROUND_CEILING
import math
import statistics
import time

from market_pricing import recommend


def positive(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value > 0)


def catalog(report, now=None, max_age=72*3600):
    now = time.time() if now is None else now
    items = []
    venues = defaultdict(dict)
    for product in report.get('products', []):
        quotes = [q for q in product.get('quotes', [])
                  if positive(q.get('unit_price')) and not q.get('experimental', False)
                  and isinstance(q.get('time'), (int, float))
                  and 0 <= now-q['time'] <= max_age and q.get('shop_key')]
        per_shop = defaultdict(list)
        for q in quotes:
            per_shop[q['shop_key']].append(q['unit_price'])
            loc = q.get('location') or {}
            channel, room = loc.get('channel'), loc.get('room')
            if (type(channel) is int and channel > 0 and type(room) is int and room > 0):
                key = (product.get('world', 'ClassicWorld'), channel, room)
                venues[key][q['shop_key']] = max(venues[key].get(q['shop_key'], 0), q['time'])
        prices = [statistics.median(v) for v in per_shop.values()]
        filtered = dict(product, quotes=quotes, sales=[])
        rec = recommend(filtered)
        items.append(dict(item_id=product['item_id'], world=product.get('world', 'ClassicWorld'),
                          name=product.get('name_zh') or str(product['item_id']), name_en=product.get('name_en',''),
                          category=product['category'], shops=len(prices),
                          newest=max((q['time'] for q in quotes), default=None),
                          fast=rec.get('fast_price'), normal=rec.get('normal_price'),
                          median=statistics.median(prices) if prices else None,
                          screen_validation_required=any(q.get('requires_validation', True) for q in quotes),
                          automatic_pricing_supported=product['category'] != '装备'))
    items.sort(key=lambda p: (-p['shops'], p['world'], p['item_id']))
    candidates = [dict(world=world, channel=channel, room=room, shops=len(shops),
                       activity_score=round(sum(2**(-(now-t)/86400) for t in shops.values()), 4),
                       newest=max(shops.values()), vacancy='unknown')
                  for (world, channel, room), shops in venues.items()]
    candidates.sort(key=lambda v: (-v['activity_score'], -v['shops'], v['world'], v['channel'], v['room']))
    presets = [dict(id=key, name=name, items=[dict(world=p['world'], item_id=p['item_id'])
                                           for p in items if p['shops'] >= 3 and predicate(p)][:30])
               for key, name, predicate in [
                   ('common', '市场常见出售品', lambda p: p['category'] not in ('装备', '商城物品')),
                   ('consumables', '常见消耗品', lambda p: p['category'] == '消耗品'),
                   ('materials', '常见材料', lambda p: p['category'] == '其他')]]
    return dict(generated_at=now, inventory_source='player_maintained',
                items=items, venues=candidates, presets=presets,
                venue_basis='近期观察到的不同摊位数，按24小时半衰期加权；不代表买家流量或成交率。',
                preset_basis='至少3个独立摊位的在售物品；预设只能选择玩家背包中已有的物品。',
                execution_ready=False)


def listing_proposal(item, inventory, strategy='normal'):
    """Return integer mesos per bundle and enforce player-owned quantity/floor."""
    if strategy not in ('fast', 'normal', 'median'):
        raise ValueError('Unknown pricing strategy')
    if inventory.get('item_id') != item['item_id'] or inventory.get('world') != item['world']:
        raise ValueError('Inventory item/world does not match quote')
    for key in ('quantity', 'reserve', 'bundle', 'groups'):
        value = inventory.get(key)
        if type(value) is not int or value < (1 if key in ('bundle','groups') else 0):
            raise ValueError(f'Invalid inventory {key}')
    if inventory['bundle']*inventory['groups'] > inventory['quantity']-inventory['reserve']:
        raise ValueError('Sale exceeds inventory after reserve')
    if not item['automatic_pricing_supported']:
        raise ValueError('Equipment requires instance attribute comparison')
    unit = item.get(strategy)
    if item['shops'] < 3 or not positive(unit):
        raise ValueError('At least three fresh independent shop quotes are required')
    floor = inventory.get('minimum_unit_price')
    if not positive(floor):
        raise ValueError('Player minimum unit price is required')
    unit = max(Decimal(str(unit)), Decimal(str(floor)))
    bundle_price = int((unit*inventory['bundle']).to_integral_value(rounding=ROUND_CEILING))
    # Int32 is a conservative proposal ceiling, not a confirmed client limit.
    if bundle_price > 2147483647:
        raise ValueError('Bundle price exceeds conservative proposal limit')
    return dict(item_id=item['item_id'], world=item['world'], strategy=strategy,
                bundle=inventory['bundle'], groups=inventory['groups'], bundle_price=bundle_price,
                unit_price=str(Decimal(bundle_price)/inventory['bundle']),
                inventory_source='player_maintained',
                requires_inventory_confirmation=True,
                requires_price_confirmation=item['screen_validation_required'],
                execution_ready=False)
