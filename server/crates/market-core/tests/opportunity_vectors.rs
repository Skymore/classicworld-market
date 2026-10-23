//! Replays the personal-alert vectors of `server/tools/gen_core_vectors.py`:
//! each case is a reference market, a collector's uploads and
//! `SharedStore.personal_alerts`' answer, which must match field for field.

use std::collections::HashMap;

use market_core::opportunities::{
    personal_alerts, ItemReference, Place, RefQuote, RefSale, Reference, Visit, VisitRow,
};
use market_core::protocol::{validate, MarketLocation};
use serde_json::Value;

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn location(value: &Value) -> Option<MarketLocation> {
    value.as_object().map(|l| MarketLocation {
        channel: l["channel"].as_u64().unwrap() as u16,
        room: l["room"].as_u64().unwrap() as u16,
    })
}

/// Shop keys `k0`, `k1`, ... become ids 0, 1, ...
fn shop_id(key: &Value) -> i64 {
    key.as_str().unwrap()[1..].parse().unwrap()
}

fn reference(case: &Value) -> Reference {
    let shops: HashMap<i64, Place> = case["shops"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, p)| {
            let place = Place {
                shop_id: p["shop_id"].as_i64().unwrap(),
                title: p["title"].as_str().unwrap().into(),
                location: location(&p["location"]),
            };
            (shop_id(&Value::String(key.clone())), place)
        })
        .collect();
    let items = case["products"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let quotes = p["quotes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|q| RefQuote {
                    shop: shop_id(&q[0]),
                    time: q[1].as_f64().unwrap(),
                    unit_price: q[2].as_f64().unwrap(),
                    stock: q[3].as_i64().unwrap(),
                })
                .collect();
            let sales = p["sales"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| RefSale {
                    shop: shop_id(&s[0]),
                    time: s[1].as_f64().unwrap(),
                    slot: s[2].as_i64().unwrap() as i32,
                    variant: None,
                    unit_price: s[3].as_f64().unwrap(),
                })
                .collect();
            let item = ItemReference {
                name: p["name_zh"].as_str().unwrap().into(),
                quotes,
                sales,
            };
            (p["item_id"].as_i64().unwrap(), item)
        })
        .collect();
    Reference {
        hours: case["hours"].as_u64().map(|h| h as u32),
        generated_at: case["generated_at"].as_f64().unwrap(),
        shops,
        items,
    }
}

/// `SELECT ... WHERE received >= now - 120 ORDER BY received DESC`, then the
/// cleaned upload as the store keeps it.
fn visits(case: &Value, now: f64) -> Vec<Visit> {
    let mut uploads: Vec<&Value> = case["uploads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| u["received"].as_f64().unwrap() >= now - 120.0)
        .collect();
    uploads.sort_by(|a, b| {
        b["received"]
            .as_f64()
            .unwrap()
            .total_cmp(&a["received"].as_f64().unwrap())
    });
    uploads
        .into_iter()
        .map(|u| {
            let upload = validate(&u["payload"], now).expect("generator sends valid uploads");
            Visit {
                time: upload.observed_seconds(),
                place: Place {
                    shop_id: i64::from(upload.shop_id),
                    title: upload.title.clone(),
                    location: upload.location,
                },
                rows: upload
                    .encoded_rows()
                    .into_iter()
                    .map(|(slot, r)| VisitRow {
                        slot,
                        item_id: i64::from(r.item_id),
                        price: r.price as i64,
                        bundle: i64::from(r.bundle),
                        stock: i64::from(r.stock),
                    })
                    .collect(),
            }
        })
        .collect()
}

#[test]
fn personal_alerts_match_python() {
    let cases: Value =
        serde_json::from_str(include_str!("data/opportunity_vectors.json")).expect("vectors parse");
    let (mut checked, mut deals) = (0, 0);
    for case in cases.as_array().unwrap() {
        let now = case["now"].as_f64().unwrap();
        let found = personal_alerts(&reference(case), &visits(case, now), now);
        let got = serde_json::to_value(&found).unwrap();
        assert!(
            same(&got, &case["result"]),
            "case {checked}\nrust:   {got}\npython: {}",
            case["result"]
        );
        checked += 1;
        deals += found.len();
    }
    assert!(
        checked >= 200 && deals >= 40,
        "{checked} cases, {deals} deals"
    );
}
