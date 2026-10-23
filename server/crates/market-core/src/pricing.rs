//! Suggested quick-sell and normal-sell prices, ported from `market_pricing.py`.
//!
//! Prices are f64 because Python's unit prices are `price / bundle` floats.
//! `ending_nine` rounds through the decimal digits of `repr(target)` exactly as
//! Python's `Decimal(str(target))` does, so results match digit for digit.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::pyjson::{self, format_g};

/// Equipment upgrade state that decides whether a row is "ordinary" gear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UpgradeState {
    pub enhancements: Option<i64>,
    pub remaining_upgrades: Option<i64>,
}

impl UpgradeState {
    /// Not successfully scrolled and upgrades left. Rows without parsed
    /// equipment (`None`) never qualify.
    fn is_ordinary(state: Option<UpgradeState>) -> bool {
        state.is_some_and(|s| s.enhancements == Some(0) && s.remaining_upgrades.unwrap_or(0) > 0)
    }
}

/// One live listing of the product.
#[derive(Debug, Clone, Copy)]
pub struct QuoteSample {
    pub shop: i64,
    pub unit_price: f64,
    pub equipment: Option<UpgradeState>,
}

/// One sale of the product inside the quote window (any kind).
#[derive(Debug, Clone, Copy)]
pub struct SoldSample {
    pub shop: i64,
    pub slot: i32,
    /// Variant id within the item; `None` for standard and unparsed rows.
    pub variant: Option<i64>,
    pub unit_price: f64,
    pub equipment: Option<UpgradeState>,
}

#[derive(Debug, Clone, Copy)]
pub struct PricingInput<'a> {
    pub equipment: bool,
    /// Quote window in hours; `None` for all records.
    pub hours: Option<u32>,
    pub quotes: &'a [QuoteSample],
    pub sales: &'a [SoldSample],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Recommendation {
    pub price: Option<f64>,
    pub fast_price: Option<f64>,
    /// Python's full dict (or the short dict when there is no sample).
    pub json: Value,
}

/// `percentile(values, fraction)`: linear interpolation on sorted values.
pub fn percentile(values: &[f64], fraction: f64) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    let p = (v.len() - 1) as f64 * fraction;
    let i = p as usize;
    let next = v[(i + 1).min(v.len() - 1)];
    v[i] + (next - v[i]) * (p - i as f64)
}

/// `statistics.median`.
pub fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    })
}

/// Drop values outside 1.5 IQR when there are at least five.
fn without_outliers(values: Vec<f64>) -> (Vec<f64>, usize) {
    if values.len() < 5 {
        return (values, 0);
    }
    let (q1, q3) = (percentile(&values, 0.25), percentile(&values, 0.75));
    let width = q3 - q1;
    if width <= 0.0 {
        return (values, 0);
    }
    let before = values.len();
    let kept: Vec<f64> = values
        .into_iter()
        .filter(|v| q1 - 1.5 * width <= *v && *v <= q3 + 1.5 * width)
        .collect();
    let removed = before - kept.len();
    (kept, removed)
}

fn usable(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

/// (slot, variant, unit price bits): one sold listing within a shop.
type SoldListing = (i32, Option<i64>, u64);

/// `market_pricing.recommend(product)`.
pub fn recommend(input: PricingInput<'_>) -> Recommendation {
    let window = match input.hours {
        None => "全部记录".to_string(),
        Some(h) => format!("近{h}小时"),
    };
    let quotes: Vec<&QuoteSample> = input
        .quotes
        .iter()
        .filter(|q| !input.equipment || UpgradeState::is_ordinary(q.equipment))
        .collect();
    let mut basis = Vec::new();
    if input.equipment {
        basis.push(format!("普通属性参考价：采用 {} 条未成功强化且仍有升级次数的同名装备报价；排除已强化、次数耗尽和属性未解析的记录。", quotes.len()));
        basis.push(
            "按普通随机属性的市场中低位估价，不另计极品属性溢价；剩余次数不能证明从未使用过卷轴。"
                .to_string(),
        );
    }

    // One value per shop: the median of its listings. Python dict order does
    // not matter here because every later step sorts.
    let mut by_shop: Vec<(i64, Vec<f64>)> = Vec::new();
    for q in quotes.iter().filter(|q| usable(q.unit_price)) {
        match by_shop.iter_mut().find(|(shop, _)| *shop == q.shop) {
            Some((_, prices)) => prices.push(q.unit_price),
            None => by_shop.push((q.shop, vec![q.unit_price])),
        }
    }
    let values: Vec<f64> = by_shop.iter().filter_map(|(_, v)| median(v)).collect();

    // A sold listing seen repeatedly counts once per (slot, variant, price).
    let mut sold_by_shop: HashMap<i64, HashMap<SoldListing, f64>> = HashMap::new();
    for s in input.sales {
        if input.equipment && !UpgradeState::is_ordinary(s.equipment) {
            continue;
        }
        if !usable(s.unit_price) {
            continue;
        }
        sold_by_shop
            .entry(s.shop)
            .or_default()
            .insert((s.slot, s.variant, s.unit_price.to_bits()), s.unit_price);
    }
    let sold_values: Vec<f64> = sold_by_shop
        .values()
        .filter_map(|rows| median(&rows.values().copied().collect::<Vec<_>>()))
        .collect();

    if values.is_empty() && sold_values.is_empty() {
        basis.push(format!("{window}没有符合条件的在售或售光推定样本。"));
        let label = if input.equipment {
            "暂无普通装备样本"
        } else {
            "暂无可用报价"
        };
        return Recommendation {
            price: None,
            fast_price: None,
            json: json!({"price": null, "label": label, "confidence": "样本不足", "basis": basis}),
        };
    }

    let count = values.len();
    let (values, removed) = without_outliers(values);
    let sold_count = sold_values.len();
    let (sold_values, sold_removed) = without_outliers(sold_values);
    let sold_reference = median(&sold_values);
    let ask_reference = (!values.is_empty()).then(|| percentile(&values, 0.4));
    let (low, high) = if values.is_empty() {
        (None, None)
    } else {
        (
            Some(percentile(&values, 0.25)),
            Some(percentile(&values, 0.5)),
        )
    };
    let (fast_target, normal_target) = match (sold_reference, ask_reference) {
        (Some(sold), Some(ask)) => (sold.min(ask), ((sold + ask) / 2.0).min(ask)),
        (None, Some(ask)) => (low.expect("values are non-empty"), ask),
        (Some(sold), None) => (sold, sold),
        (None, None) => unreachable!("returned early when both are empty"),
    };
    let fast_price = ending_nine(fast_target);
    let price = fast_price.max(ending_nine(normal_target));

    basis.push(format!("{window}在售报价来自 {count} 个摊位，售光推定来自 {sold_count} 个摊位；每摊先取中位数，同一售光挂单重复观察不增加权重。"));
    basis.push(format!(
        "在售报价排除 {removed} 个异常摊位样本，售光推定排除 {sold_removed} 个异常摊位样本。"
    ));
    if let Some(sold) = sold_reference {
        basis.push(format!(
            "售光推定参考价 {}；采用发现售光时记录的单位价。",
            format_g(sold)
        ));
    }
    if let Some(ask) = ask_reference {
        basis.push(format!("在售报价第40百分位 {}。", format_g(ask)));
    }
    basis.push(
        match (sold_reference, ask_reference) {
            (Some(_), Some(_)) => "快卖价贴近售光参考；正常卖价取售光参考与在售第40百分位的中点。若当前挂价更低，两档均跟随当前挂价。",
            (None, Some(_)) => "暂无售光参考：快卖取在售第25百分位，正常卖取第40百分位。",
            _ => "暂无在售报价，两档暂用售光参考价。",
        }
        .to_string(),
    );
    basis.push(format!(
        "快卖参考 {}、正常卖参考 {}，两档均整理为尾数9。",
        format_g(fast_target),
        format_g(normal_target)
    ));
    let few = count.max(sold_count) < 3;
    if few {
        basis.push("当前仅有少量摊位样本。".to_string());
    }
    if price < 1.0 {
        basis.push(format!(
            "单价低于1金币：可按100件一组，参考整组价 {} 金币；上架时核对每组数量。",
            (price * 100.0).ceil() as i64
        ));
    }
    let confidence = if few {
        "样本少"
    } else if sold_count > 0 {
        "售光与在售综合"
    } else {
        "在售参考"
    };
    let label = if input.equipment {
        "普通属性建议价"
    } else {
        "建议试挂价"
    };
    Recommendation {
        price: Some(price),
        fast_price: Some(fast_price),
        json: json!({
            "price": price, "normal_price": price, "fast_price": fast_price, "pricing_version": 2,
            "label": label, "confidence": confidence, "shop_count": count, "sold_shop_count": sold_count,
            "sold_reference": sold_reference, "ask_reference": ask_reference, "excluded_outliers": removed,
            "reference_low": low, "reference_high": high, "basis": basis,
        }),
    }
}

/// Round to two significant digits with a trailing 9 (`ending_nine` inside
/// `recommend`). Below 9 the result has cents, e.g. 0.39 or 5.29.
pub fn ending_nine(target: f64) -> f64 {
    let step = (target.log10().floor() as i32 - 1).max(-2);
    let rounded = scaled_round_half_up(target, step);
    if rounded >= 9.0 {
        let value = if (rounded.trunc() as i64) % 10 < 9 {
            (rounded / 10.0).floor() * 10.0 - 1.0
        } else {
            rounded.floor()
        };
        return value.max(9.0);
    }
    // Decimal(str(rounded)) * 10, ceiling, / 10 - 0.01, at least 0.09.
    let (digits, scale) = pyjson::repr_decimal(rounded);
    let tenths = ceil_scaled(digits, scale + 1);
    let cents = (tenths * 10).saturating_sub(1).max(9);
    format!("{cents}e-2")
        .parse()
        .expect("decimal string parses")
}

/// `float((Decimal(str(x)) / 10**step).quantize(1, ROUND_HALF_UP) * 10**step)`.
fn scaled_round_half_up(x: f64, step: i32) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    let (digits, scale) = pyjson::repr_decimal(x);
    let shift = scale - step; // x / 10^step == digits × 10^shift
    let units: u128 = if shift >= 0 {
        digits * 10u128.pow(shift as u32)
    } else if -shift > 38 {
        0
    } else {
        let divisor = 10u128.pow((-shift) as u32);
        let (q, r) = (digits / divisor, digits % divisor);
        if r * 2 >= divisor {
            q + 1
        } else {
            q
        }
    };
    format!("{units}e{step}")
        .parse()
        .expect("decimal string parses")
}

/// Ceiling of `digits × 10^shift` as an integer.
fn ceil_scaled(digits: u128, shift: i32) -> u128 {
    if digits == 0 {
        0
    } else if shift >= 0 {
        digits * 10u128.pow(shift as u32)
    } else if -shift > 38 {
        1
    } else {
        let divisor = 10u128.pow((-shift) as u32);
        digits.div_ceil(divisor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quotes(values: &[f64]) -> Vec<QuoteSample> {
        values
            .iter()
            .enumerate()
            .map(|(i, &v)| QuoteSample {
                shop: i as i64,
                unit_price: v,
                equipment: None,
            })
            .collect()
    }

    fn other(quotes: &[QuoteSample], sales: &[SoldSample]) -> Recommendation {
        recommend(PricingInput {
            equipment: false,
            hours: Some(72),
            quotes,
            sales,
        })
    }

    fn sold(shop: i64, price: f64) -> SoldSample {
        SoldSample {
            shop,
            slot: 1,
            variant: None,
            unit_price: price,
            equipment: None,
        }
    }

    const ORDINARY: UpgradeState = UpgradeState {
        enhancements: Some(0),
        remaining_upgrades: Some(7),
    };

    #[test]
    fn equipment_is_not_given_mixed_price() {
        let r = recommend(PricingInput {
            equipment: true,
            hours: Some(72),
            quotes: &quotes(&[100.0, 200.0]),
            sales: &[],
        });
        assert_eq!(r.price, None);
        assert_eq!(r.json["label"], "暂无普通装备样本");
    }

    #[test]
    fn normal_equipment_excludes_scrolled_and_unknown() {
        let mut q = quotes(&[20000.0, 21000.0, 450000.0, 1.0]);
        q[0].equipment = Some(ORDINARY);
        q[1].equipment = Some(ORDINARY);
        q[2].equipment = Some(UpgradeState {
            enhancements: Some(4),
            remaining_upgrades: Some(0),
        });
        let r = recommend(PricingInput {
            equipment: true,
            hours: Some(72),
            quotes: &q,
            sales: &[],
        });
        assert_eq!(r.json["shop_count"], 2);
        assert_eq!(r.price, Some(19999.0));
        assert_eq!(r.json["label"], "普通属性建议价");
    }

    #[test]
    fn recommended_integer_prices_end_in_nine() {
        for value in [9.0, 10.0, 99.0, 100.0, 499.0, 1000.0, 450000.0] {
            assert_eq!(
                other(&quotes(&[value]), &[]).price.unwrap() % 10.0,
                9.0,
                "{value}"
            );
        }
    }

    #[test]
    fn outliers_removed_and_does_not_chase_minimum() {
        let r = other(
            &quotes(&[1.0, 100.0, 110.0, 120.0, 130.0, 140.0, 10000.0]),
            &[],
        );
        assert_eq!(r.json["excluded_outliers"], 2);
        assert!((110.0..=130.0).contains(&r.price.unwrap()));
    }

    #[test]
    fn duplicate_shop_does_not_change_weight() {
        let mut q = quotes(&[100.0, 200.0, 300.0]);
        let base = other(&q, &[]).price;
        q.extend(std::iter::repeat_n(q[0], 50));
        assert_eq!(other(&q, &[]).price, base);
    }

    #[test]
    fn sold_prices_dominate_with_enough_distinct_shops() {
        let q = quotes(&[200.0; 8]);
        let sales: Vec<SoldSample> = (0..5).map(|i| sold(100 + i, 100.0)).collect();
        let r = other(&q, &sales);
        assert_eq!(r.fast_price, Some(99.0));
        assert_eq!(r.price, Some(149.0));
        let many: Vec<SoldSample> = sales.iter().copied().cycle().take(100).collect();
        let r = other(&q, &many);
        assert_eq!(r.price, Some(149.0));
        assert_eq!(r.json["sold_shop_count"], 5);
    }

    #[test]
    fn sparse_sold_samples_and_sold_only() {
        let q = quotes(&[200.0; 8]);
        assert_eq!(other(&q, &[sold(100, 100.0)]).json["normal_price"], 149.0);
        let r = other(&[], &[sold(100, 100.0)]);
        assert_eq!((r.fast_price, r.price), (Some(99.0), Some(99.0)));
    }

    #[test]
    fn current_asking_below_sold_reference() {
        let r = other(&quotes(&[100.0; 8]), &[sold(100, 200.0)]);
        assert_eq!((r.fast_price, r.price), (Some(99.0), Some(99.0)));
    }

    #[test]
    fn scrolled_sold_equipment_is_excluded() {
        let mut s = sold(1, 100.0);
        s.equipment = Some(UpgradeState {
            enhancements: Some(4),
            remaining_upgrades: Some(0),
        });
        let r = recommend(PricingInput {
            equipment: true,
            hours: Some(72),
            quotes: &[],
            sales: &[s],
        });
        assert_eq!(r.price, None);
    }

    #[test]
    fn no_sample_and_fractional_prices() {
        assert_eq!(other(&[], &[]).price, None);
        assert_eq!(other(&quotes(&[0.4]), &[]).price, Some(0.39));
        assert_eq!(other(&quotes(&[100.0]), &[]).json["confidence"], "样本少");
    }

    #[test]
    fn ending_nine_examples() {
        for (target, expected) in [
            (9.5, 9.0),
            (12.34, 9.0),
            (19.0, 19.0),
            (25.5, 19.0),
            (149.6, 149.0),
            (5.3, 5.29),
            (0.4, 0.39),
            (0.001, 0.09),
            (100.0, 99.0),
        ] {
            assert_eq!(ending_nine(target), expected, "{target}");
        }
    }
}
