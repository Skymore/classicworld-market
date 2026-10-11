"""Explainable trial prices for comparable non-equipment items, not sale guarantees."""
import math
import statistics
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP


def percentile(values, fraction):
    v=sorted(values);p=(len(v)-1)*fraction;i=int(p)
    return v[i]+(v[min(i+1,len(v)-1)]-v[i])*(p-i)


def recommend(product):
    if product['category']=='装备':
        return dict(price=None,label='需按实际属性估价',confidence='不可混合估价',
                    basis=['同名装备可能有不同随机属性、强化值和剩余升级次数。',
                           '各件装备分开列价；实际属性尚未可靠解析，不把同名中位价作为建议售价。'])
    shops=defaultdict(list)
    for r in product['quotes']:
        value=r.get('unit_price')
        if isinstance(value,(int,float)) and math.isfinite(value) and value>0:
            shops[r['shop_key']].append(value)
    values=[statistics.median(v) for v in shops.values()]
    if not values:
        return dict(price=None,label='暂无可用报价',confidence='样本不足',basis=['近24小时没有有效在售报价，不用售光推定价冒充当前市场价。'])
    count=len(values); removed=0
    if count>=5:
        q1,q3=percentile(values,.25),percentile(values,.75);width=q3-q1
        if width>0:
            kept=[v for v in values if q1-1.5*width<=v<=q3+1.5*width]
            removed=len(values)-len(kept);values=kept
    target=percentile(values,.4)
    step=Decimal(str(10**max(-2,math.floor(math.log10(target))-1)))
    price=float((Decimal(str(target))/step).quantize(Decimal('1'),rounding=ROUND_HALF_UP)*step)
    low,high=percentile(values,.25),percentile(values,.5)
    price=max(.01,price)
    basis=[f'近24小时 {count} 个摊位，每摊先取单位报价中位数，避免重复挂单影响权重。',
           f'排除 {removed} 个四分位距异常报价后，取第40百分位并取易输入的价格。',
           f'参考报价中位数 {statistics.median(values):g}，中低位区间 {low:g}–{high:g} 金币/件。',
           '售光推定仅旁列参考，不作为真实成交样本参与计算。']
    if count<3: basis.append('不足3个摊位：仅为试挂参考，建议先核对游戏中的同类报价。')
    if any(r.get('requires_validation') for r in product['quotes']): basis.append('价格和数量字段仍待画面核对，推荐不是保证成交价。')
    if price<1: basis.append(f'单价低于1金币：可按100件一组，参考整组价 {math.ceil(price*100)} 金币；上架时核对每组数量。')
    return dict(price=price,label='建议试挂价',confidence='样本少' if count<3 else '参考建议',
                shop_count=count,excluded_outliers=removed,reference_low=low,reference_high=high,basis=basis)
