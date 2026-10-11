"""Explainable trial prices for commodities and ordinary equipment."""
import math
import statistics
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP


def percentile(values, fraction):
    v=sorted(values);p=(len(v)-1)*fraction;i=int(p)
    return v[i]+(v[min(i+1,len(v)-1)]-v[i])*(p-i)


def recommend(product):
    equipment=product['category']=='装备'
    quotes=product['quotes']
    equipment_basis=[]
    if equipment:
        # An exhausted item may have failed scrolls despite zero successful upgrades.
        quotes=[r for r in quotes if (r.get('equipment') or {}).get('enhancements')==0
                and ((r.get('equipment') or {}).get('remaining_upgrades') or 0)>0]
        equipment_basis=[f'普通属性参考价：采用 {len(quotes)} 条未成功强化且仍有升级次数的同名装备报价；排除已强化、次数耗尽和属性未解析的记录。',
                         '按普通随机属性的市场中低位估价，不另计极品属性溢价；剩余次数不能证明从未使用过卷轴。']
    shops=defaultdict(list)
    for r in quotes:
        value=r.get('unit_price')
        if isinstance(value,(int,float)) and math.isfinite(value) and value>0:
            shops[r['shop_key']].append(value)
    values=[statistics.median(v) for v in shops.values()]
    if not values:
        return dict(price=None,label='暂无普通装备样本' if equipment else '暂无可用报价',confidence='样本不足',basis=equipment_basis+['近24小时没有符合条件的在售报价，暂不编造推荐价格。'])
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
    # Use the nearest lower 9-ending integer. Tiny unit prices retain cents.
    if price>=9:
        price=float(max(9, math.floor(price/10)*10-1 if int(price)%10<9 else math.floor(price)))
    else:
        price=float(max(Decimal('0.09'), (Decimal(str(price))*10).to_integral_value(rounding='ROUND_CEILING')/10-Decimal('0.01')))
    basis=equipment_basis+[f'近24小时 {count} 个摊位，每摊先取单位报价中位数，避免重复挂单影响权重。',
           f'排除 {removed} 个四分位距异常报价后，取第40百分位取整后向下调整为尾数9的价格（低于9金币的单位价保留小数，末位为9）。',
           f'参考报价中位数 {statistics.median(values):g}，中低位区间 {low:g}–{high:g} 金币/件。',
           '售光推定仅旁列参考，不作为真实成交样本参与计算。']
    if count<3: basis.append('不足3个摊位：仅为试挂参考，建议先核对游戏中的同类报价。')
    if any(r.get('requires_validation') for r in quotes): basis.append('价格和数量字段仍待画面核对，推荐不是保证成交价。')
    if price<1: basis.append(f'单价低于1金币：可按100件一组，参考整组价 {math.ceil(price*100)} 金币；上架时核对每组数量。')
    return dict(price=price,label='普通属性建议价' if equipment else '建议试挂价',confidence='样本少' if count<3 else '参考建议',
                shop_count=count,excluded_outliers=removed,reference_low=low,reference_high=high,basis=basis)
