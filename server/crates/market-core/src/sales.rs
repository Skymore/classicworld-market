//! Replay one shop's observations into its current listings and its sales,
//! ported from the visit loop in `market_dashboard.Repository.report`.
//!
//! A row is keyed by (slot, item, variant) within the shop and compared with
//! the last observation of that key:
//! - stock 0 after stock > 0: `sold_out`; stock 0 on first sight: `found_sold`;
//! - stock fell but stayed > 0 at the same price and bundle: `drop`.
//!
//! Replaying the whole shop on every upload makes late uploads safe: the
//! result depends only on the set of observations, not on arrival order.

use std::collections::HashMap;
use std::hash::Hash;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaleKind {
    Drop,
    SoldOut,
    FoundSold,
}

impl SaleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drop => "drop",
            Self::SoldOut => "sold_out",
            Self::FoundSold => "found_sold",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "drop" => Some(Self::Drop),
            "sold_out" => Some(Self::SoldOut),
            "found_sold" => Some(Self::FoundSold),
            _ => None,
        }
    }

    /// Kinds that count towards `sold_out_count` / `sold_out_median`.
    pub fn is_sold_out(self) -> bool {
        matches!(self, Self::SoldOut | Self::FoundSold)
    }

    /// `SALE_METHODS` in `market_dashboard.py`.
    pub fn method(self) -> &'static str {
        match self {
            Self::Drop => "库存减少推定成交",
            Self::SoldOut | Self::FoundSold => "售光推定成交",
        }
    }

    /// `SALE_EVIDENCE` in `market_dashboard.py`.
    pub fn evidence(self) -> &'static str {
        match self {
            Self::Drop => "两次观察之间库存减少；非订单回执，成交在两次观察之间",
            Self::SoldOut => "两次观察之间库存变为0；非订单回执，成交在两次观察之间",
            Self::FoundSold => "首次看到时库存已为0；非订单回执，成交数量和时间未知",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShopRow<V> {
    /// Encoded slot (category × 1000 + slot + repeat × 1000000).
    pub slot: i32,
    pub item_id: i32,
    pub variant: V,
    /// Listed price per bundle.
    pub price: i64,
    pub bundle: i32,
    pub stock: i32,
}

impl<V> ShopRow<V> {
    pub fn unit_price(&self) -> f64 {
        self.price as f64 / f64::from(self.bundle)
    }
}

/// One observation of the shop. Callers pass them sorted by
/// (observed time, visit key), rows in upload order.
#[derive(Debug, Clone, PartialEq)]
pub struct ShopVisit<V> {
    pub time: f64,
    pub rows: Vec<ShopRow<V>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sale {
    pub visit: usize,
    pub row: usize,
    pub kind: SaleKind,
    /// Price, bundle and unit price of the previous observation; the current
    /// row's for `found_sold`.
    pub sale_price: i64,
    pub sale_bundle: i32,
    pub sale_unit_price: f64,
    /// Items sold: (previous stock − stock) × previous bundle; `None` when
    /// unknown (`found_sold`).
    pub quantity: Option<i64>,
    pub previous_time: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Replay {
    /// Sales in detection order.
    pub sales: Vec<Sale>,
    /// Index of the latest visit; its rows are the shop's current listings.
    pub latest: Option<usize>,
    /// When each row of the latest visit was first seen under its key.
    pub first_seen: Vec<f64>,
}

struct Seen {
    time: f64,
    first_seen: f64,
    price: i64,
    bundle: i32,
    stock: i32,
}

pub fn replay<V: Clone + Eq + Hash>(visits: &[ShopVisit<V>]) -> Replay {
    let mut previous: HashMap<(i32, i32, V), Seen> = HashMap::new();
    let mut sales = Vec::new();
    for (v, visit) in visits.iter().enumerate() {
        for (r, row) in visit.rows.iter().enumerate() {
            let key = (row.slot, row.item_id, row.variant.clone());
            let old = previous.get(&key);
            let kind = match old {
                None if row.stock == 0 => Some(SaleKind::FoundSold),
                Some(old) if row.stock == 0 && old.stock > 0 => Some(SaleKind::SoldOut),
                Some(old)
                    if 0 < row.stock
                        && row.stock < old.stock
                        && (old.price, old.bundle) == (row.price, row.bundle) =>
                {
                    Some(SaleKind::Drop)
                }
                _ => None,
            };
            if let Some(kind) = kind {
                sales.push(match old {
                    Some(old) => Sale {
                        visit: v,
                        row: r,
                        kind,
                        sale_price: old.price,
                        sale_bundle: old.bundle,
                        sale_unit_price: old.price as f64 / f64::from(old.bundle),
                        quantity: Some(i64::from(old.stock - row.stock) * i64::from(old.bundle))
                            .filter(|q| *q != 0),
                        previous_time: Some(old.time),
                    },
                    None => Sale {
                        visit: v,
                        row: r,
                        kind,
                        sale_price: row.price,
                        sale_bundle: row.bundle,
                        sale_unit_price: row.unit_price(),
                        quantity: None,
                        previous_time: None,
                    },
                });
            }
            let first_seen = old.map_or(visit.time, |o| o.first_seen);
            previous.insert(
                key,
                Seen {
                    time: visit.time,
                    first_seen,
                    price: row.price,
                    bundle: row.bundle,
                    stock: row.stock,
                },
            );
        }
    }
    let latest = visits.len().checked_sub(1);
    let first_seen = latest
        .map(|v| {
            visits[v]
                .rows
                .iter()
                .map(|row| previous[&(row.slot, row.item_id, row.variant.clone())].first_seen)
                .collect()
        })
        .unwrap_or_default();
    Replay {
        sales,
        latest,
        first_seen,
    }
}

/// `market_sales.sale_id`: first 16 hex digits of sha256("{visit}:{slot}").
pub fn sale_id(visit_key: &str, slot: i32) -> String {
    crate::pyjson::sha256_hex(format!("{visit_key}:{slot}").as_bytes())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(time: f64, stock: i32, price: i64, bundle: i32) -> ShopVisit<()> {
        ShopVisit {
            time,
            rows: vec![ShopRow {
                slot: 4001,
                item_id: 4_000_008,
                variant: (),
                price,
                bundle,
                stock,
            }],
        }
    }

    fn kinds(r: &Replay) -> Vec<(SaleKind, Option<i64>)> {
        r.sales.iter().map(|s| (s.kind, s.quantity)).collect()
    }

    #[test]
    fn stock_drop_then_sold_out() {
        let r = replay(&[
            visit(1.0, 10, 100, 2),
            visit(2.0, 7, 100, 2),
            visit(3.0, 0, 100, 2),
        ]);
        assert_eq!(
            kinds(&r),
            vec![(SaleKind::Drop, Some(6)), (SaleKind::SoldOut, Some(14))]
        );
        assert_eq!(r.sales[1].previous_time, Some(2.0));
        assert_eq!(r.sales[1].sale_unit_price, 50.0);
    }

    #[test]
    fn first_seen_sold_has_unknown_quantity_and_time() {
        let r = replay(&[visit(1.0, 0, 100, 2)]);
        assert_eq!(kinds(&r), vec![(SaleKind::FoundSold, None)]);
        assert_eq!(r.sales[0].previous_time, None);
    }

    #[test]
    fn restock_and_relisting_are_not_sales() {
        let r = replay(&[
            visit(1.0, 3, 100, 2),
            visit(2.0, 9, 100, 2),
            visit(3.0, 5, 120, 2),
            visit(4.0, 4, 120, 1),
        ]);
        assert!(r.sales.is_empty());
    }

    #[test]
    fn sold_out_counts_once_and_price_change_still_sells_out() {
        let r = replay(&[
            visit(1.0, 3, 100, 1),
            visit(2.0, 0, 90, 1),
            visit(3.0, 0, 90, 1),
        ]);
        assert_eq!(kinds(&r), vec![(SaleKind::SoldOut, Some(3))]);
        assert_eq!(r.sales[0].sale_price, 100);
    }

    #[test]
    fn empty_snapshot_clears_listings_without_sales() {
        let r = replay(&[
            visit(1.0, 8, 500, 1),
            ShopVisit {
                time: 2.0,
                rows: vec![],
            },
        ]);
        assert!(r.sales.is_empty());
        assert_eq!(r.latest, Some(1));
        assert!(r.first_seen.is_empty());
    }

    #[test]
    fn a_key_remembers_its_last_state_across_gaps() {
        let other = ShopVisit {
            time: 2.0,
            rows: vec![ShopRow {
                slot: 4001,
                item_id: 4_000_009,
                variant: (),
                price: 1,
                bundle: 1,
                stock: 1,
            }],
        };
        let r = replay(&[visit(1.0, 5, 100, 1), other, visit(3.0, 0, 100, 1)]);
        assert_eq!(kinds(&r), vec![(SaleKind::SoldOut, Some(5))]);
        assert_eq!(r.first_seen, vec![1.0]);
    }

    #[test]
    fn sale_id_matches_python() {
        // python3 -c "from market_sales import sale_id; print(sale_id('abc', 4001))"
        assert_eq!(sale_id("abc", 4001), "30b47dc588e0bccb");
    }
}
