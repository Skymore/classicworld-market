"""Market summaries and cautious, local browsing opportunities."""
import statistics
import time
from collections import defaultdict
from market_pricing import percentile, recommend


def opportunities(report, now=None):
    now=time.time() if now is None else now
    found=[]
    for product in report['products']:
        # Random equipment rolls need a comparable attribute market of their own.
        if product['category']=='装备':continue
        recent=[r for r in product['quotes'] if 0<=now-r['time']<=120 and r.get('collector')=='local']
        for row in recent:
            others=[r for r in product['quotes'] if r['shop_key']!=row['shop_key'] and r['time']<row['time']]
            shops=defaultdict(list)
            for r in others:
                if r.get('unit_price',0)>0:shops[r['shop_key']].append(r['unit_price'])
            values=[statistics.median(v) for v in shops.values()]
            if len(values)<8:continue
            # Current supply is evidence of listings, never of completed sales.
            listed=[r for r in others if (r.get('unit_price') or 0)>0 and (r.get('stock') or 0)>0]
            listed_quantity=sum(r['stock'] for r in listed)
            q1=percentile(values,.25);buy=row['unit_price']
            prior_sales=[s for s in product.get('sales',[]) if s.get('shop_key')!=row['shop_key'] and s.get('time',0)<row['time']]
            recommendation=recommend(dict(product,quotes=others,sales=prior_sales))
            sell=recommendation.get('fast_price');normal_sell=recommendation.get('normal_price')
            if not buy or not sell or buy>=q1:continue
            net=sell*.97;profit=net-buy
            if profit/buy<.15:continue
            found.append(dict(id=f"{row['shop_key']}:{row['slot']}:{row['item_id']}:{buy}",
                item_id=row['item_id'],name=product['name_zh'],shop=row['shop'],location=row['location'],
                observed=row['time'],buy=buy,bundle=row['bundle'],bundle_cost=row['price'],stock=row['stock'],
                q1=q1,sell=sell,fast_sell=sell,normal_sell=normal_sell,pricing_version=2,normal_profit=round(normal_sell*.97-buy,2),normal_margin=round((normal_sell*.97/buy-1)*100,1),profit=round(profit,2),margin=round(profit/buy*100,1),
                shops=len(values),listing_count=len(listed),listed_quantity=listed_quantity,fee_percent=3,
                basis='排除当前摊位，按其他摊位的更早报价比较，快卖价用于触发提醒，正常卖价用于较高报价参考；列出在售摊位、挂单和库存数量，价差已扣除3%手续费。'))
    return sorted(found,key=lambda a:(a['observed'],a['margin']),reverse=True)[:20]


def view(report, summary=False, item_id=None):
    if item_id is not None:
        return dict(products=[p for p in report['products'] if p['item_id']==item_id],
                    history=[r for r in report['history'] if r['item_id']==item_id])
    if not summary:return report
    result={k:v for k,v in report.items() if k not in ('items','sales','history','products')}
    result['products']=[dict({k:v for k,v in p.items() if k not in ('quotes','sales','variants')},
                             variant_count=len(p['variants'])) for p in report['products']]
    return result
