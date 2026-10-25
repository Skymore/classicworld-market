//! Personal deal alerts, ported from `market_realtime_alerts.visit_opportunities`,
//! `market_views.opportunities` and `SharedStore.personal_alerts`.
//!
//! A collector's own observation from the last two minutes is a candidate.
//! Each of its rows is compared with other shops' earlier listings of the item:
//! at least eight shops' median unit prices, a buy price below their first
//! quartile, and a quick-sell price (`pricing::recommend`) that leaves at least
//! 15 % after the 3 % market fee. Equipment is never a candidate: random rolls
//! need a market of their own.
//!
//! Nothing here reads the clock or the database; `market-web::alerts` loads
//! the reference and the candidate observations and passes `now`.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};

use crate::item::is_equipment;
use crate::pricing::{median, percentile, recommend, PricingInput, QuoteSample, SoldSample};
use crate::protocol::{MarketLocation, WORLD};
use crate::pyjson::{self, floordiv, Dumps};

/// Only observations this recent (seconds) are candidates.
pub const CANDIDATE_SECONDS: f64 = 120.0;
/// Shops with a positive asking price needed for a comparison.
pub const MIN_SHOPS: usize = 8;
pub const FEE_PERCENT: u32 = 3;
const AFTER_FEE: f64 = 0.97;
/// Margin after the fee that makes a deal, as a fraction of the buy price.
pub const MIN_MARGIN: f64 = 0.15;
pub const MAX_ALERTS: usize = 20;
const PRICING_VERSION: u32 = 2;
pub const BASIS: &str = "排除当前摊位，按其他摊位的更早报价比较，快卖价用于触发提醒，正常卖价用于较高报价参考；列出在售摊位、挂单和库存数量，价差已扣除3%手续费。";

/// What `same_shop` compares: the game's shop id, its title and where it stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub shop_id: i64,
    pub title: String,
    pub location: Option<MarketLocation>,
}

/// One live listing of another shop. `shop` keys `Reference::shops`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefQuote {
    pub shop: i64,
    /// The shop's latest observation.
    pub time: f64,
    pub unit_price: f64,
    pub stock: i64,
}

/// One sale of the item, any kind.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefSale {
    pub shop: i64,
    /// Detection time.
    pub time: f64,
    pub slot: i32,
    pub variant: Option<i64>,
    pub unit_price: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ItemReference {
    pub name: String,
    pub quotes: Vec<RefQuote>,
    pub sales: Vec<RefSale>,
}

/// The market the candidates are compared with (Python's report). Items
/// missing here are unknown and never alert.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reference {
    /// Quote window; `None` for all records.
    pub hours: Option<u32>,
    pub generated_at: f64,
    pub shops: HashMap<i64, Place>,
    pub items: HashMap<i64, ItemReference>,
}

/// One row of a candidate observation; `slot` carries the repeat counter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisitRow {
    pub slot: i32,
    pub item_id: i64,
    /// Per bundle, as uploaded.
    pub price: i64,
    pub bundle: i64,
    pub stock: i64,
}

/// One of the collector's observations.
#[derive(Debug, Clone, PartialEq)]
pub struct Visit {
    pub time: f64,
    pub place: Place,
    pub rows: Vec<VisitRow>,
}

/// One alert. Field names and order are the Python dict's.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Opportunity {
    pub id: String,
    pub item_id: i64,
    pub name: String,
    pub shop: String,
    pub location: Value,
    pub observed: f64,
    pub buy: f64,
    pub bundle: i64,
    pub bundle_cost: i64,
    pub stock: i64,
    pub q1: f64,
    pub sell: f64,
    pub fast_sell: f64,
    pub normal_sell: f64,
    pub pricing_version: u32,
    pub normal_profit: f64,
    pub normal_margin: f64,
    pub profit: f64,
    pub margin: f64,
    pub shops: usize,
    pub listing_count: usize,
    pub listed_quantity: i64,
    pub fee_percent: u32,
    pub basis: &'static str,
    pub reference_generated_at: f64,
}

fn utc_day(time: f64) -> i64 {
    floordiv(time, 86400.0) as i64
}

/// `same_shop(row, visit)`: same shop id, title and UTC day; the location
/// must agree only when both sides know it.
pub fn same_shop(place: &Place, time: f64, visit: &Visit) -> bool {
    if place.shop_id != visit.place.shop_id
        || place.title != visit.place.title
        || utc_day(time) != utc_day(visit.time)
    {
        return false;
    }
    match (place.location, visit.place.location) {
        (Some(a), Some(b)) => a.channel == b.channel && a.room == b.room,
        _ => true,
    }
}

/// Python's shop key of a shared visit; part of the alert id.
fn visit_shop_key(visit: &Visit) -> String {
    let key = json!([WORLD, "shared", 0, visit.place.shop_id, visit.place.title]);
    pyjson::dumps(&key, Dumps::ASCII)
}

/// Rows of the visit that can alert, grouped by item in first-seen order.
fn candidate_rows<'a>(reference: &Reference, visit: &'a Visit) -> Vec<(i64, Vec<&'a VisitRow>)> {
    let mut grouped: Vec<(i64, Vec<&VisitRow>)> = Vec::new();
    for row in &visit.rows {
        if is_equipment(row.item_id)
            || row.bundle <= 0
            || row.stock <= 0
            || !reference.items.contains_key(&row.item_id)
        {
            continue;
        }
        match grouped.iter_mut().find(|(item, _)| *item == row.item_id) {
            Some((_, rows)) => rows.push(row),
            None => grouped.push((row.item_id, vec![row])),
        }
    }
    grouped
}

/// The item's market as seen before the visit, from other shops only.
struct Evidence {
    quotes: Vec<QuoteSample>,
    sales: Vec<SoldSample>,
    shop_medians: Vec<f64>,
    listing_count: usize,
    listed_quantity: i64,
}

fn evidence(reference: &Reference, item: &ItemReference, visit: &Visit, cutoff: f64) -> Evidence {
    // `same_shop` on a shop missing from `shops` cannot match; treat it as other.
    let other = |shop: i64, time: f64| {
        reference
            .shops
            .get(&shop)
            .is_none_or(|place| !same_shop(place, time, visit))
    };
    let quotes: Vec<&RefQuote> = item
        .quotes
        .iter()
        .filter(|q| other(q.shop, q.time) && q.time >= cutoff && q.time < visit.time)
        .collect();
    let mut by_shop: HashMap<i64, Vec<f64>> = HashMap::new();
    for q in quotes.iter().filter(|q| q.unit_price > 0.0) {
        by_shop.entry(q.shop).or_default().push(q.unit_price);
    }
    let listed: Vec<&&RefQuote> = quotes
        .iter()
        .filter(|q| q.unit_price > 0.0 && q.stock > 0)
        .collect();
    Evidence {
        quotes: quotes
            .iter()
            .map(|q| QuoteSample {
                shop: q.shop,
                unit_price: q.unit_price,
                equipment: None,
            })
            .collect(),
        sales: item
            .sales
            .iter()
            .filter(|s| other(s.shop, s.time) && s.time >= cutoff && s.time < visit.time)
            .map(|s| SoldSample {
                shop: s.shop,
                slot: s.slot,
                variant: s.variant,
                unit_price: s.unit_price,
                equipment: None,
            })
            .collect(),
        shop_medians: by_shop.values().filter_map(|v| median(v)).collect(),
        listing_count: listed.len(),
        listed_quantity: listed.iter().map(|q| q.stock).sum(),
    }
}

/// Stable, newest first, then the larger margin: Python's
/// `sorted(key=(observed, margin), reverse=True)`.
fn rank(deals: &mut Vec<Opportunity>) {
    deals.sort_by(|a, b| {
        b.observed
            .total_cmp(&a.observed)
            .then(b.margin.total_cmp(&a.margin))
    });
    deals.truncate(MAX_ALERTS);
}

/// `visit_opportunities(report, visit, now)`.
pub fn visit_opportunities(reference: &Reference, visit: &Visit, now: f64) -> Vec<Opportunity> {
    if !(0.0..=CANDIDATE_SECONDS).contains(&(now - visit.time)) {
        return vec![];
    }
    let cutoff = reference
        .hours
        .map_or(f64::NEG_INFINITY, |h| now - f64::from(h) * 3600.0);
    let shop_key = visit_shop_key(visit);
    let mut found = Vec::new();
    for (item_id, rows) in candidate_rows(reference, visit) {
        let item = &reference.items[&item_id];
        let market = evidence(reference, item, visit, cutoff);
        if market.shop_medians.len() < MIN_SHOPS {
            continue;
        }
        let q1 = percentile(&market.shop_medians, 0.25);
        let recommendation = recommend(PricingInput {
            equipment: false,
            hours: reference.hours,
            quotes: &market.quotes,
            sales: &market.sales,
        });
        let (Some(sell), Some(normal_sell)) = (
            recommendation.fast_price,
            recommendation.json["normal_price"].as_f64(),
        ) else {
            continue;
        };
        for row in rows {
            let buy = row.price as f64 / row.bundle as f64;
            if buy == 0.0 || sell == 0.0 || buy >= q1 {
                continue;
            }
            let profit = sell * AFTER_FEE - buy;
            if profit / buy < MIN_MARGIN {
                continue;
            }
            found.push(Opportunity {
                id: format!(
                    "{shop_key}:{}:{item_id}:{}",
                    row.slot,
                    pyjson::float_repr(buy)
                ),
                item_id,
                name: item.name.clone(),
                shop: visit.place.title.clone(),
                location: visit
                    .place
                    .location
                    .map_or(Value::Null, MarketLocation::to_json),
                observed: visit.time,
                buy,
                bundle: row.bundle,
                bundle_cost: row.price,
                stock: row.stock,
                q1,
                sell,
                fast_sell: sell,
                normal_sell,
                pricing_version: PRICING_VERSION,
                normal_profit: pyjson::round(normal_sell * AFTER_FEE - buy, 2),
                normal_margin: pyjson::round((normal_sell * AFTER_FEE / buy - 1.0) * 100.0, 1),
                profit: pyjson::round(profit, 2),
                margin: pyjson::round(profit / buy * 100.0, 1),
                shops: market.shop_medians.len(),
                listing_count: market.listing_count,
                listed_quantity: market.listed_quantity,
                fee_percent: FEE_PERCENT,
                basis: BASIS,
                reference_generated_at: reference.generated_at,
            });
        }
    }
    rank(&mut found);
    found
}

/// Python's `personal_alerts` key: one snapshot per shop and UTC day.
type SnapshotKey = (i64, i64, String, Option<u16>, Option<u16>);

fn snapshot_key(visit: &Visit) -> SnapshotKey {
    let location = visit.place.location;
    (
        utc_day(visit.time),
        visit.place.shop_id,
        visit.place.title.clone(),
        location.map(|l| l.channel),
        location.map(|l| l.room),
    )
}

/// `SharedStore.personal_alerts`. `visits`: the collector's observations
/// received in the last two minutes, most recently received first. The
/// latest snapshot per shop is the candidate; repeated alerts keep the newest.
pub fn personal_alerts(reference: &Reference, visits: &[Visit], now: f64) -> Vec<Opportunity> {
    let mut latest: Vec<(SnapshotKey, &Visit)> = Vec::new();
    for visit in visits {
        let key = snapshot_key(visit);
        match latest.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) if visit.time > entry.1.time => entry.1 = visit,
            Some(_) => {}
            None => latest.push((key, visit)),
        }
    }
    let mut found: Vec<Opportunity> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (_, visit) in latest {
        for deal in visit_opportunities(reference, visit, now) {
            match index.get(&deal.id) {
                Some(&i) if deal.observed > found[i].observed => found[i] = deal,
                Some(_) => {}
                None => {
                    index.insert(deal.id.clone(), found.len());
                    found.push(deal);
                }
            }
        }
    }
    rank(&mut found);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_792_000_000.0;

    fn place(shop_id: i64, room: Option<u16>) -> Place {
        Place {
            shop_id,
            title: "Shop".into(),
            location: room.map(|room| MarketLocation { channel: 1, room }),
        }
    }

    /// Ten shops asking 100..=190 a few minutes ago.
    fn market() -> Reference {
        let mut reference = Reference {
            hours: Some(72),
            generated_at: NOW,
            ..Reference::default()
        };
        let mut item = ItemReference {
            name: "铁矿石".into(),
            ..ItemReference::default()
        };
        for shop in 0..10 {
            reference.shops.insert(shop, place(100 + shop, Some(5)));
            item.quotes.push(RefQuote {
                shop,
                time: NOW - 600.0,
                unit_price: 100.0 + 10.0 * shop as f64,
                stock: 2,
            });
        }
        reference.items.insert(4_010_001, item);
        reference
    }

    fn visit(price: i64, bundle: i64) -> Visit {
        Visit {
            time: NOW - 30.0,
            place: place(7, Some(3)),
            rows: vec![VisitRow {
                slot: 4001,
                item_id: 4_010_001,
                price,
                bundle,
                stock: 1,
            }],
        }
    }

    #[test]
    fn a_cheap_row_alerts_with_python_fields() {
        let deals = visit_opportunities(&market(), &visit(50, 1), NOW);
        assert_eq!(deals.len(), 1);
        let deal = &deals[0];
        // Asks 100..190: q1 = 122.5, P25 = 122.5 -> quick sell 119.
        assert_eq!((deal.q1, deal.sell), (122.5, 119.0));
        assert_eq!(deal.margin, 130.9); // (119 × 0.97 − 50) / 50
        assert_eq!(
            deal.id,
            r#"["ClassicWorld", "shared", 0, 7, "Shop"]:4001:4010001:50.0"#
        );
        assert_eq!(
            (deal.shops, deal.listing_count, deal.listed_quantity),
            (10, 10, 20)
        );
        let json = serde_json::to_value(deal).unwrap();
        assert_eq!(
            json["location"],
            json!({"channel": 1, "room": 3, "map_id": 80_002_003})
        );
    }

    #[test]
    fn thresholds_reject() {
        let reference = market();
        // Not under q1, or under q1 but less than 15 % after the fee.
        assert!(visit_opportunities(&reference, &visit(123, 1), NOW).is_empty());
        assert!(visit_opportunities(&reference, &visit(101, 1), NOW).is_empty());
        // Unit price is per bundle.
        assert_eq!(
            visit_opportunities(&reference, &visit(500, 10), NOW).len(),
            1
        );
        // Too old, from the future, or seven shops only.
        assert!(visit_opportunities(&reference, &visit(50, 1), NOW + 200.0).is_empty());
        assert!(visit_opportunities(&reference, &visit(50, 1), NOW - 60.0).is_empty());
        let mut few = reference.clone();
        few.items.get_mut(&4_010_001).unwrap().quotes.truncate(7);
        assert!(visit_opportunities(&few, &visit(50, 1), NOW).is_empty());
    }

    #[test]
    fn own_shop_later_and_equipment_rows_are_not_evidence() {
        let mut reference = market();
        // Shop 0 is the visited shop seen earlier today without a location:
        // it drops out and nine shops remain.
        reference.shops.insert(
            0,
            Place {
                location: None,
                ..place(7, None)
            },
        );
        assert_eq!(
            visit_opportunities(&reference, &visit(50, 1), NOW)[0].shops,
            9
        );
        // Two more seen after the visit leave seven.
        for q in &mut reference.items.get_mut(&4_010_001).unwrap().quotes[1..3] {
            q.time = NOW - 10.0;
        }
        assert!(visit_opportunities(&reference, &visit(50, 1), NOW).is_empty());
        let mut equipment = visit(50, 1);
        equipment.rows[0].item_id = 1_452_003;
        assert!(visit_opportunities(&market(), &equipment, NOW).is_empty());
    }

    #[test]
    fn earlier_sales_set_the_quick_sell_price_later_ones_do_not() {
        let mut reference = market();
        let sale = RefSale {
            shop: 1,
            time: NOW - 900.0,
            slot: 4001,
            variant: None,
            unit_price: 80.0,
        };
        reference
            .items
            .get_mut(&4_010_001)
            .unwrap()
            .sales
            .push(sale);
        assert_eq!(
            visit_opportunities(&reference, &visit(50, 1), NOW)[0].sell,
            79.0
        );
        reference.items.get_mut(&4_010_001).unwrap().sales[0].time = NOW - 10.0;
        assert_eq!(
            visit_opportunities(&reference, &visit(50, 1), NOW)[0].sell,
            119.0
        );
    }

    #[test]
    fn personal_alerts_keep_the_latest_snapshot_per_shop() {
        let reference = market();
        let older = visit(50, 1);
        let mut newer = visit(60, 1);
        newer.time = NOW - 5.0;
        // Received order: older first in the slice means received later.
        let deals = personal_alerts(&reference, &[older.clone(), newer.clone()], NOW);
        assert_eq!(deals.len(), 1);
        assert_eq!(deals[0].buy, 60.0);
        let mut elsewhere = older;
        elsewhere.place.shop_id = 8;
        let deals = personal_alerts(&reference, &[elsewhere, newer], NOW);
        assert_eq!(
            deals.iter().map(|d| d.buy).collect::<Vec<_>>(),
            vec![60.0, 50.0]
        );
    }
}
