//! Per-item sale figures, ported from `market_sales.sales_stats`.
//!
//! The 24h, previous-24h, 7-day and 10-day windows end at the anchor: the
//! minute after the latest observation, not the wall clock, because collection
//! is bursty.

use serde::{Deserialize, Serialize};

use crate::pricing::{median, percentile};
use crate::pyjson;

pub const DAY: f64 = 86400.0;
pub const TYPICAL_MIN: usize = 5;
pub const TYPICAL_FALLBACK: usize = 10;
pub const TREND_DAYS: usize = 7;

/// One sale, in detection order (observation order, then row order).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SaleSample {
    pub time: f64,
    pub unit_price: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TypicalBasis {
    #[serde(rename = "24h")]
    Day,
    Recent,
}

impl TypicalBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Recent => "recent",
        }
    }
}

/// A trend bucket without its start; the start follows from the anchor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bucket {
    pub count: usize,
    pub median: Option<f64>,
    pub low: Option<f64>,
    pub high: Option<f64>,
}

impl Bucket {
    fn of(prices: &[f64]) -> Self {
        Self {
            count: prices.len(),
            median: median(prices),
            low: prices.iter().copied().reduce(f64::min),
            high: prices.iter().copied().reduce(f64::max),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SalesStats {
    pub typical: Option<f64>,
    pub typical_low: Option<f64>,
    pub typical_high: Option<f64>,
    pub typical_basis: TypicalBasis,
    pub typical_count: usize,
    pub low_data: bool,
    pub sales_24h: usize,
    pub sales_prev_24h: usize,
    pub change_24h: Option<f64>,
    pub sales_10d: usize,
    pub last_sale_at: Option<f64>,
    pub last_sale_price: Option<f64>,
    pub last3_avg: Option<f64>,
    pub trend_7d: [Bucket; TREND_DAYS],
}

/// Where the sale windows end: the minute after `as_of`, else `now`.
pub fn anchor(as_of: Option<f64>, now: f64) -> f64 {
    match as_of {
        Some(t) => (pyjson::floordiv(t, 60.0) + 1.0) * 60.0,
        None => now,
    }
}

/// Start of trend bucket `index` (0 = oldest).
pub fn bucket_start(anchor: f64, index: usize) -> f64 {
    anchor - ((TREND_DAYS - index) as f64) * DAY
}

fn prices(sales: &[&SaleSample]) -> Vec<f64> {
    sales.iter().map(|s| s.unit_price).collect()
}

/// `sales_stats(sales, now)` with `now` = the anchor.
pub fn sales_stats(sales: &[SaleSample], now: f64) -> SalesStats {
    let mut ordered: Vec<&SaleSample> = sales.iter().filter(|s| s.unit_price > 0.0).collect();
    // Newest first; a stable sort keeps detection order among equal times,
    // as Python's sorted(reverse=True) does.
    ordered.sort_by(|a, b| b.time.total_cmp(&a.time));
    let day: Vec<&SaleSample> = ordered
        .iter()
        .copied()
        .filter(|s| now - DAY <= s.time && s.time <= now)
        .collect();
    let previous: Vec<&SaleSample> = ordered
        .iter()
        .copied()
        .filter(|s| now - 2.0 * DAY <= s.time && s.time < now - DAY)
        .collect();
    let use_day = day.len() >= TYPICAL_MIN;
    let basis = if use_day {
        prices(&day)
    } else {
        prices(&ordered[..ordered.len().min(TYPICAL_FALLBACK)])
    };
    let change_24h = if use_day && previous.len() >= TYPICAL_MIN {
        let before = median(&prices(&previous)).expect("five previous sales");
        let today = median(&prices(&day)).expect("five sales today");
        (before != 0.0).then(|| pyjson::round((today / before - 1.0) * 100.0, 1))
    } else {
        None
    };
    let trend_7d = std::array::from_fn(|index| {
        let start = bucket_start(now, index);
        let bucket: Vec<f64> = ordered
            .iter()
            .filter(|s| start <= s.time && s.time < start + DAY)
            .map(|s| s.unit_price)
            .collect();
        Bucket::of(&bucket)
    });
    let has_values = !basis.is_empty();
    let latest = ordered.first();
    SalesStats {
        typical: median(&basis),
        typical_low: has_values.then(|| percentile(&basis, 0.25)),
        typical_high: has_values.then(|| percentile(&basis, 0.75)),
        typical_basis: if use_day {
            TypicalBasis::Day
        } else {
            TypicalBasis::Recent
        },
        typical_count: basis.len(),
        low_data: basis.len() < TYPICAL_MIN,
        sales_24h: day.len(),
        sales_prev_24h: previous.len(),
        change_24h,
        sales_10d: ordered
            .iter()
            .filter(|s| s.time >= now - 10.0 * DAY)
            .count(),
        last_sale_at: latest.map(|s| s.time),
        last_sale_price: latest.map(|s| s.unit_price),
        last3_avg: latest.map(|_| {
            let last3 = prices(&ordered[..ordered.len().min(3)]);
            pyjson::fsum(&last3) / last3.len() as f64
        }),
        trend_7d,
    }
}

/// Sales per UTC calendar day, for `item_daily`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DailyBucket {
    /// Days since 1970-01-01 (UTC).
    pub day: i64,
    pub bucket: Bucket,
}

pub fn daily_buckets(sales: &[SaleSample]) -> Vec<DailyBucket> {
    let mut by_day = std::collections::BTreeMap::<i64, Vec<f64>>::new();
    for s in sales.iter().filter(|s| s.unit_price > 0.0) {
        by_day
            .entry((s.time / DAY).floor() as i64)
            .or_default()
            .push(s.unit_price);
    }
    by_day
        .into_iter()
        .map(|(day, prices)| DailyBucket {
            day,
            bucket: Bucket::of(&prices),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 2_000_000_000.0;

    fn sale(age: f64, price: f64) -> SaleSample {
        SaleSample {
            time: NOW - age,
            unit_price: price,
        }
    }

    #[test]
    fn typical_uses_last_day_when_it_has_five_sales() {
        let mut sales: Vec<SaleSample> = (1..=5)
            .map(|i| sale(3600.0 * i as f64, 100.0 + i as f64))
            .collect();
        sales.push(sale(3.0 * DAY, 999.0));
        let s = sales_stats(&sales, NOW);
        assert_eq!(
            (s.typical, s.typical_basis, s.typical_count),
            (Some(103.0), TypicalBasis::Day, 5)
        );
        assert!(!s.low_data);
        assert_eq!((s.typical_low, s.typical_high), (Some(102.0), Some(104.0)));
        assert_eq!((s.last_sale_price, s.last3_avg), (Some(101.0), Some(102.0)));
    }

    #[test]
    fn typical_falls_back_to_last_ten_and_flags_low_data() {
        let few: Vec<SaleSample> = (0..3).map(|i| sale(DAY * 2.0 + i as f64, 50.0)).collect();
        let s = sales_stats(&few, NOW);
        assert_eq!(
            (s.typical, s.typical_basis, s.sales_24h),
            (Some(50.0), TypicalBasis::Recent, 0)
        );
        assert!(s.low_data);
        let many: Vec<SaleSample> = (0..15)
            .map(|i| sale(DAY * 2.0 + i as f64, 10.0 * (i + 1) as f64))
            .collect();
        let s = sales_stats(&many, NOW);
        assert_eq!((s.typical_count, s.typical), (10, Some(55.0)));
    }

    #[test]
    fn change_needs_five_sales_in_both_days() {
        let day: Vec<SaleSample> = (1..=5).map(|i| sale(3600.0 * i as f64, 110.0)).collect();
        let before: Vec<SaleSample> = (1..=5)
            .map(|i| sale(DAY + 3600.0 * i as f64, 100.0))
            .collect();
        let both = [day.clone(), before.clone()].concat();
        assert_eq!(sales_stats(&both, NOW).change_24h, Some(10.0));
        let short = [day, before[..4].to_vec()].concat();
        assert_eq!(sales_stats(&short, NOW).change_24h, None);
    }

    #[test]
    fn trend_has_seven_daily_buckets() {
        let s = sales_stats(
            &[
                sale(DAY * 0.5, 10.0),
                sale(DAY * 0.6, 30.0),
                sale(DAY * 6.5, 5.0),
            ],
            NOW,
        );
        let last = s.trend_7d[6];
        assert_eq!(
            (last.count, last.median, last.low, last.high),
            (2, Some(20.0), Some(10.0), Some(30.0))
        );
        assert_eq!(s.trend_7d[0].median, Some(5.0));
        assert!(s.trend_7d[1..6].iter().all(|b| b.count == 0));
    }

    #[test]
    fn no_sales() {
        let s = sales_stats(&[], NOW);
        assert_eq!(s.typical, None);
        assert!(s.low_data);
        assert_eq!(s.last3_avg, None);
    }

    #[test]
    fn equal_times_keep_detection_order_for_the_fallback_cut() {
        // Eleven sales at one moment: the first ten detected form the basis.
        let mut sales: Vec<SaleSample> = (0..10).map(|_| sale(5.0 * DAY, 10.0)).collect();
        sales.push(sale(5.0 * DAY, 1000.0));
        assert_eq!(sales_stats(&sales, NOW).typical, Some(10.0));
    }

    #[test]
    fn anchor_is_the_next_minute() {
        assert_eq!(anchor(Some(1792387302.8281226), 0.0), 1792387320.0);
        assert_eq!(anchor(Some(1792387320.0), 0.0), 1792387380.0);
        assert_eq!(anchor(None, 5.0), 5.0);
    }

    #[test]
    fn daily_buckets_group_by_utc_day() {
        let days = daily_buckets(&[
            SaleSample {
                time: 86400.0 * 3.0 + 1.0,
                unit_price: 10.0,
            },
            SaleSample {
                time: 86400.0 * 3.0 + 2.0,
                unit_price: 30.0,
            },
            SaleSample {
                time: 86400.0 * 4.0,
                unit_price: 5.0,
            },
            SaleSample {
                time: 86400.0 * 4.0,
                unit_price: 0.0,
            },
        ]);
        assert_eq!(days.len(), 2);
        assert_eq!((days[0].day, days[0].bucket.median), (3, Some(20.0)));
        assert_eq!((days[1].day, days[1].bucket.count), (4, 1));
    }
}
