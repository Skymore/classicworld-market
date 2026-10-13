"""Explainable trial prices for commodities and ordinary equipment."""
import math
import statistics
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP


def percentile(values, fraction):
    v=sorted(values);p=(len(v)-1)*fraction;i=int(p)
    return v[i]+(v[min(i+1,len(v)-1)]-v[i])*(p-i)


def recommend(product):
    window='全部记录' if product.get('hours',72) is None else f"近{product.get('hours',72)}小时"
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
    sold_by_shop=defaultdict(dict)
    for row in product.get('sales',[]):
        eq=row.get('equipment') or {}
        if equipment and not (eq.get('enhancements')==0 and (eq.get('remaining_upgrades') or 0)>0):continue
        value=row.get('sale_unit_price')
        if not isinstance(value,(int,float)) or not math.isfinite(value) or value<=0:continue
        # Repeated observations of the same sold listing carry no extra weight.
        key=(row.get('slot'),row.get('variant'),value)
        sold_by_shop[row['shop_key']][key]=value
    sold_values=[statistics.median(list(rows.values())) for rows in sold_by_shop.values()]
    if not values and not sold_values:
        return dict(price=None,label='暂无普通装备样本' if equipment else '暂无可用报价',confidence='样本不足',basis=equipment_basis+[f'{window}没有符合条件的在售或售光推定样本。'])
    count=len(values); removed=0
    if count>=5:
        q1,q3=percentile(values,.25),percentile(values,.75);width=q3-q1
        if width>0:
            kept=[v for v in values if q1-1.5*width<=v<=q3+1.5*width]
            removed=len(values)-len(kept);values=kept
    sold_count=len(sold_values)
    sold_removed=0
    if sold_count>=5:
        q1,q3=percentile(sold_values,.25),percentile(sold_values,.75);width=q3-q1
        if width>0:
            kept=[v for v in sold_values if q1-1.5*width<=v<=q3+1.5*width]
            sold_removed=len(sold_values)-len(kept);sold_values=kept
    sold_reference=statistics.median(sold_values) if sold_values else None
    ask_reference=percentile(values,.4) if values else None
    low,high=(percentile(values,.25),percentile(values,.5)) if values else (None,None)
    if sold_reference is not None and ask_reference is not None:
        fast_target=min(sold_reference,ask_reference)
        normal_target=min((sold_reference+ask_reference)/2,ask_reference)
    elif ask_reference is not None:
        fast_target=low;normal_target=ask_reference
    else:
        fast_target=normal_target=sold_reference
    def ending_nine(target):
        step=Decimal(str(10**max(-2,math.floor(math.log10(target))-1)))
        rounded=float((Decimal(str(target))/step).quantize(Decimal('1'),rounding=ROUND_HALF_UP)*step)
        if rounded>=9:return float(max(9,math.floor(rounded/10)*10-1 if int(rounded)%10<9 else math.floor(rounded)))
        return float(max(Decimal('0.09'),(Decimal(str(rounded))*10).to_integral_value(rounding='ROUND_CEILING')/10-Decimal('0.01')))
    fast_price=ending_nine(fast_target);price=max(fast_price,ending_nine(normal_target))
    basis=equipment_basis+[f'{window}在售报价来自 {count} 个摊位，售光推定来自 {sold_count} 个摊位；每摊先取中位数，同一售光挂单重复观察不增加权重。',
           f'在售报价排除 {removed} 个异常摊位样本，售光推定排除 {sold_removed} 个异常摊位样本。']
    if sold_reference is not None:basis.append(f'售光推定参考价 {sold_reference:g}；采用发现售光时记录的单位价。')
    if ask_reference is not None:basis.append(f'在售报价第40百分位 {ask_reference:g}。')
    if sold_reference is not None and ask_reference is not None:
        basis.append('快卖价贴近售光参考；正常卖价取售光参考与在售第40百分位的中点。若当前挂价更低，两档均跟随当前挂价。')
    elif ask_reference is not None:basis.append('暂无售光参考：快卖取在售第25百分位，正常卖取第40百分位。')
    else:basis.append('暂无在售报价，两档暂用售光参考价。')
    basis.append(f'快卖参考 {fast_target:g}、正常卖参考 {normal_target:g}，两档均整理为尾数9。')
    if max(count,sold_count)<3:basis.append('当前仅有少量摊位样本。')
    if price<1: basis.append(f'单价低于1金币：可按100件一组，参考整组价 {math.ceil(price*100)} 金币；上架时核对每组数量。')
    return dict(price=price,normal_price=price,fast_price=fast_price,pricing_version=2,label='普通属性建议价' if equipment else '建议试挂价',confidence='样本少' if max(count,sold_count)<3 else '售光与在售综合' if sold_count else '在售参考',
                shop_count=count,sold_shop_count=sold_count,sold_reference=sold_reference,ask_reference=ask_reference,excluded_outliers=removed,reference_low=low,reference_high=high,basis=basis)
