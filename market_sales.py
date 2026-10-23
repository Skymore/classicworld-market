"""Sale statistics behind "typical sale" prices and the recent-sales feed.

A sale is a shop row seen sold: its stock dropped between two observations
("drop"), reached zero ("sold_out"), or was already zero when first seen
("found_sold"). Prices are the shop's listed unit price, not order receipts,
and a sale's time is when it was discovered.
"""
import hashlib
import statistics
from market_pricing import percentile

DAY = 86400
TYPICAL_MIN = 5
TYPICAL_FALLBACK = 10
TREND_DAYS = 7
SOLD_OUT_KINDS = ('sold_out', 'found_sold')
CATEGORY_NAMES = ('装备', '消耗品', '装饰', '其他', '商城物品')
SALE_FIELDS = ('id', 'time', 'kind', 'item_id', 'name_zh', 'name_en', 'icon_url', 'category', 'subcategory',
               'variant', 'sale_price', 'sale_unit_price', 'bundle', 'quantity', 'previous_time', 'shop',
               'location', 'equipment')


def sale_id(visit_id, slot):
    return hashlib.sha256(f'{visit_id}:{slot}'.encode()).hexdigest()[:16]


def _prices(sales):
    return [s['sale_unit_price'] for s in sales if isinstance(s.get('sale_unit_price'), (int, float)) and s['sale_unit_price'] > 0]


def _median(values):
    return statistics.median(values) if values else None


def sales_stats(sales, now):
    """Per-item sale figures. `sales` may be in any order and outside any quote window."""
    ordered = sorted((s for s in sales if _prices([s])), key=lambda s: s['time'], reverse=True)
    day = [s for s in ordered if now-DAY <= s['time'] <= now]
    previous = [s for s in ordered if now-2*DAY <= s['time'] < now-DAY]
    basis = day if len(day) >= TYPICAL_MIN else ordered[:TYPICAL_FALLBACK]
    values = _prices(basis)
    change = None
    if len(day) >= TYPICAL_MIN and len(previous) >= TYPICAL_MIN:
        before = _median(_prices(previous))
        change = round((_median(_prices(day))/before-1)*100, 1) if before else None
    trend = []
    for index in range(TREND_DAYS):
        start = now-(TREND_DAYS-index)*DAY
        bucket = _prices([s for s in ordered if start <= s['time'] < start+DAY])
        trend.append(dict(start=start, count=len(bucket), median=_median(bucket),
                          low=min(bucket) if bucket else None, high=max(bucket) if bucket else None))
    return dict(
        typical=_median(values),
        typical_low=percentile(values, .25) if values else None,
        typical_high=percentile(values, .75) if values else None,
        typical_basis='24h' if basis is day else 'recent',
        typical_count=len(values),
        low_data=len(values) < TYPICAL_MIN,
        sales_24h=len(day),
        sales_prev_24h=len(previous),
        change_24h=change,
        sales_10d=sum(1 for s in ordered if s['time'] >= now-10*DAY),
        last_sale_at=ordered[0]['time'] if ordered else None,
        last_sale_price=ordered[0]['sale_unit_price'] if ordered else None,
        last3_avg=statistics.fmean(_prices(ordered[:3])) if ordered else None,
        trend_7d=trend,
    )


def sales_query(args):
    """Validated recent_sales() arguments from a query mapping (single values)."""
    def one(name):
        value = args.get(name, '')
        return value[0] if isinstance(value, list) else value
    limit, before, item, category = one('limit'), one('before'), one('item_id'), one('category')
    query = dict(limit=50)
    if limit:
        if not limit.isdecimal() or not 1 <= int(limit) <= 100:
            raise ValueError('limit')
        query['limit'] = int(limit)
    if before:
        query['before'] = float(before)
        if not 0 < query['before'] < 1e11:
            raise ValueError('before')
    if item:
        if not item.isdecimal() or not 1000000 <= int(item) <= 5999999:
            raise ValueError('item_id')
        query['item_id'] = int(item)
    if category:
        if category not in CATEGORY_NAMES:
            raise ValueError('category')
        query['category'] = category
    return query


def recent_sales(report, limit=50, before=None, item_id=None, category=None):
    """Newest-first sales feed. A page never splits sales discovered at the same
    moment, so `before=next_before` continues without skipping any."""
    found = []
    for sale in report['sales']:
        if before is not None and sale['time'] >= before:
            continue
        if item_id is not None and sale['item_id'] != item_id:
            continue
        if category and sale.get('category') != category:
            continue
        if len(found) >= limit and sale['time'] != found[-1]['time']:
            return dict(sales=found, next_before=found[-1]['time'], generated_at=report['generated_at'])
        found.append({k: sale.get(k) for k in SALE_FIELDS})
    return dict(sales=found, next_before=None, generated_at=report['generated_at'])
