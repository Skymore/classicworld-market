//! Per-item figures of `market_dashboard.Repository.report`: quote window
//! aggregates, sold-out figures, the recommendation and the sale stats.
//!
//! The caller passes every live listing and every sale of one item; sales in
//! detection order. Nothing here reads the clock: `now` and the anchor come in.

use std::collections::HashSet;

use crate::item::is_equipment;
use crate::pricing::{
    median, recommend, PricingInput, QuoteSample, Recommendation, SoldSample, UpgradeState,
};
use crate::sales::SaleKind;
use crate::stats::{daily_buckets, sales_stats, DailyBucket, SaleSample, SalesStats};

/// Default quote window of the list and the price suggestions.
pub const RECENT_HOURS: u32 = 72;

/// One row of a shop's latest observation with stock > 0.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Listing {
    pub shop: i64,
    /// Time of the shop's latest observation; decides the quote window.
    pub shop_seen: f64,
    pub variant: Option<i64>,
    pub unit_price: f64,
    pub upgrade: Option<UpgradeState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SaleEvent {
    pub time: f64,
    pub kind: SaleKind,
    pub shop: i64,
    pub slot: i32,
    pub variant: Option<i64>,
    pub unit_price: f64,
    pub upgrade: Option<UpgradeState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    /// `None` for all records.
    pub hours: Option<u32>,
    pub cutoff: f64,
}

impl Window {
    pub fn recent(now: f64) -> Self {
        Self {
            hours: Some(RECENT_HOURS),
            cutoff: now - f64::from(RECENT_HOURS) * 3600.0,
        }
    }

    pub const ALL: Window = Window {
        hours: None,
        cutoff: f64::NEG_INFINITY,
    };
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowFigures {
    pub low: Option<f64>,
    pub median: Option<f64>,
    pub high: Option<f64>,
    pub listings: usize,
    pub shops: usize,
    pub variants: usize,
    pub sold_out_count: usize,
    pub sold_out_median: Option<f64>,
    /// Sales of any kind inside the window.
    pub sales_count: usize,
    pub recommendation: Recommendation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ItemFigures {
    pub stats: SalesStats,
    pub recent: WindowFigures,
    pub all: WindowFigures,
    pub daily: Vec<DailyBucket>,
}

pub fn window_figures(
    item_id: i64,
    listings: &[Listing],
    sales: &[SaleEvent],
    window: Window,
) -> WindowFigures {
    let quotes: Vec<&Listing> = listings
        .iter()
        .filter(|l| l.shop_seen >= window.cutoff)
        .collect();
    let prices: Vec<f64> = quotes.iter().map(|l| l.unit_price).collect();
    let in_window: Vec<&SaleEvent> = sales.iter().filter(|s| s.time >= window.cutoff).collect();
    let sold_out: Vec<f64> = in_window
        .iter()
        .filter(|s| s.kind.is_sold_out())
        .map(|s| s.unit_price)
        .collect();
    let quote_samples: Vec<QuoteSample> = quotes
        .iter()
        .map(|l| QuoteSample {
            shop: l.shop,
            unit_price: l.unit_price,
            equipment: l.upgrade,
        })
        .collect();
    let sold_samples: Vec<SoldSample> = in_window
        .iter()
        .map(|s| SoldSample {
            shop: s.shop,
            slot: s.slot,
            variant: s.variant,
            unit_price: s.unit_price,
            equipment: s.upgrade,
        })
        .collect();
    WindowFigures {
        low: prices.iter().copied().reduce(f64::min),
        median: median(&prices),
        high: prices.iter().copied().reduce(f64::max),
        listings: prices.len(),
        shops: quotes.iter().map(|l| l.shop).collect::<HashSet<_>>().len(),
        variants: quotes
            .iter()
            .map(|l| l.variant)
            .collect::<HashSet<_>>()
            .len(),
        sold_out_count: sold_out.len(),
        sold_out_median: median(&sold_out),
        sales_count: in_window.len(),
        recommendation: recommend(PricingInput {
            equipment: is_equipment(item_id),
            hours: window.hours,
            quotes: &quote_samples,
            sales: &sold_samples,
        }),
    }
}

/// Everything the list and the item page show for one item.
pub fn item_figures(
    item_id: i64,
    listings: &[Listing],
    sales: &[SaleEvent],
    anchor: f64,
    now: f64,
) -> ItemFigures {
    let samples: Vec<SaleSample> = sales
        .iter()
        .map(|s| SaleSample {
            time: s.time,
            unit_price: s.unit_price,
        })
        .collect();
    ItemFigures {
        stats: sales_stats(&samples, anchor),
        recent: window_figures(item_id, listings, sales, Window::recent(now)),
        all: window_figures(item_id, listings, sales, Window::ALL),
        daily: daily_buckets(&samples),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 2_000_000_000.0;

    fn listing(shop: i64, seen_ago: f64, price: f64) -> Listing {
        Listing {
            shop,
            shop_seen: NOW - seen_ago,
            variant: None,
            unit_price: price,
            upgrade: None,
        }
    }

    fn sale(ago: f64, kind: SaleKind, price: f64) -> SaleEvent {
        SaleEvent {
            time: NOW - ago,
            kind,
            shop: 9,
            slot: 4001,
            variant: None,
            unit_price: price,
            upgrade: None,
        }
    }

    #[test]
    fn quote_window_drops_shops_last_seen_before_the_cutoff() {
        let listings = [
            listing(1, 60.0, 100.0),
            listing(1, 60.0, 300.0),
            listing(2, 80.0 * 3600.0, 50.0),
        ];
        let recent = window_figures(4_000_000, &listings, &[], Window::recent(NOW));
        assert_eq!(
            (recent.low, recent.median, recent.high),
            (Some(100.0), Some(200.0), Some(300.0))
        );
        assert_eq!((recent.listings, recent.shops, recent.variants), (2, 1, 1));
        let all = window_figures(4_000_000, &listings, &[], Window::ALL);
        assert_eq!((all.low, all.listings, all.shops), (Some(50.0), 3, 2));
    }

    #[test]
    fn sold_out_figures_ignore_drops_but_sales_count_does_not() {
        let sales = [
            sale(60.0, SaleKind::Drop, 10.0),
            sale(60.0, SaleKind::SoldOut, 20.0),
            sale(60.0, SaleKind::FoundSold, 40.0),
            sale(100.0 * 3600.0, SaleKind::SoldOut, 99.0),
        ];
        let recent = window_figures(4_000_000, &[], &sales, Window::recent(NOW));
        assert_eq!(
            (
                recent.sold_out_count,
                recent.sold_out_median,
                recent.sales_count
            ),
            (2, Some(30.0), 3)
        );
        let figures = item_figures(4_000_000, &[], &sales, NOW, NOW);
        assert_eq!(figures.stats.sales_24h, 3);
        assert_eq!(figures.all.sales_count, 4);
    }

    #[test]
    fn equipment_needs_ordinary_rows_for_a_price() {
        let mut rows = [listing(1, 60.0, 100.0)];
        assert_eq!(
            window_figures(1_040_000, &rows, &[], Window::ALL)
                .recommendation
                .price,
            None
        );
        rows[0].upgrade = Some(UpgradeState {
            enhancements: Some(0),
            remaining_upgrades: Some(7),
        });
        assert_eq!(
            window_figures(1_040_000, &rows, &[], Window::ALL)
                .recommendation
                .price,
            Some(99.0)
        );
    }
}
