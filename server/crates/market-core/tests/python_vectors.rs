//! Replays vectors produced by `server/tools/gen_core_vectors.py` from the
//! Python reference and requires identical results.

use std::collections::HashMap;

use market_core::pricing::{
    ending_nine, recommend, PricingInput, QuoteSample, SoldSample, UpgradeState,
};
use market_core::protocol::validate;
use market_core::stats::{bucket_start, sales_stats, SaleSample};
use serde_json::Value;

fn vectors() -> Value {
    let text = include_str!("data/python_vectors.json");
    serde_json::from_str(text).expect("vectors parse")
}

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

#[test]
fn validate_matches_python() {
    let data = vectors();
    let now = data["now"].as_f64().unwrap();
    let mut checked = 0;
    for case in data["protocol"].as_array().unwrap() {
        let payload: Value = serde_json::from_str(case["payload"].as_str().unwrap()).unwrap();
        match (validate(&payload, now), case.get("fingerprint")) {
            (Ok(upload), Some(fp)) => {
                assert_eq!(upload.fingerprint(), fp.as_str().unwrap(), "{payload}")
            }
            (Err(err), None) => assert_eq!(
                err.python_class(),
                case["error"].as_str().unwrap(),
                "{payload}"
            ),
            (got, _) => panic!("{payload}\nrust: {got:?}\npython: {case}"),
        }
        checked += 1;
    }
    assert!(checked >= 500);
}

fn upgrade(eq: &Value) -> Option<UpgradeState> {
    eq.as_object().map(|eq| UpgradeState {
        enhancements: eq.get("enhancements").and_then(Value::as_i64),
        remaining_upgrades: eq.get("remaining_upgrades").and_then(Value::as_i64),
    })
}

#[test]
fn recommend_matches_python() {
    let data = vectors();
    for case in data["pricing"].as_array().unwrap() {
        let product = &case["product"];
        let mut ids = HashMap::<String, i64>::new();
        let mut id = |key: &Value| {
            let next = ids.len() as i64;
            *ids.entry(key.as_str().unwrap().to_string()).or_insert(next)
        };
        let quotes: Vec<QuoteSample> = product["quotes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| QuoteSample {
                shop: id(&q["shop_key"]),
                unit_price: q["unit_price"].as_f64().unwrap(),
                equipment: upgrade(&q["equipment"]),
            })
            .collect();
        let sales: Vec<SoldSample> = product["sales"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| SoldSample {
                shop: id(&s["shop_key"]),
                slot: s["slot"].as_i64().unwrap() as i32,
                variant: (s["variant"] != "standard").then_some(1),
                unit_price: s["sale_unit_price"].as_f64().unwrap(),
                equipment: upgrade(&s["equipment"]),
            })
            .collect();
        let result = recommend(PricingInput {
            equipment: product["category"] == "装备",
            hours: product["hours"].as_u64().map(|h| h as u32),
            quotes: &quotes,
            sales: &sales,
        });
        assert!(
            same(&result.json, &case["result"]),
            "{product}\nrust:   {}\npython: {}",
            result.json,
            case["result"]
        );
    }
}

#[test]
fn ending_nine_matches_python_digit_for_digit() {
    let data = vectors();
    for pair in data["ending_nine"].as_array().unwrap() {
        let (target, expected) = (pair[0].as_f64().unwrap(), pair[1].as_f64().unwrap());
        assert_eq!(
            ending_nine(target).to_bits(),
            expected.to_bits(),
            "{target}"
        );
    }
}

#[test]
fn sales_stats_match_python() {
    let data = vectors();
    for case in data["stats"].as_array().unwrap() {
        let now = case["now"].as_f64().unwrap();
        let sales: Vec<SaleSample> = case["sales"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| SaleSample {
                time: s["time"].as_f64().unwrap(),
                unit_price: s["sale_unit_price"].as_f64().unwrap(),
            })
            .collect();
        let s = sales_stats(&sales, now);
        let trend: Vec<Value> = s
            .trend_7d
            .iter()
            .enumerate()
            .map(|(i, b)| serde_json::json!({"start": bucket_start(now, i), "count": b.count, "median": b.median, "low": b.low, "high": b.high}))
            .collect();
        let got = serde_json::json!({
            "typical": s.typical, "typical_low": s.typical_low, "typical_high": s.typical_high,
            "typical_basis": s.typical_basis.as_str(), "typical_count": s.typical_count, "low_data": s.low_data,
            "sales_24h": s.sales_24h, "sales_prev_24h": s.sales_prev_24h, "change_24h": s.change_24h,
            "sales_10d": s.sales_10d, "last_sale_at": s.last_sale_at, "last_sale_price": s.last_sale_price,
            "last3_avg": s.last3_avg, "trend_7d": trend,
        });
        assert!(
            same(&got, &case["result"]),
            "rust:   {got}\npython: {}",
            case["result"]
        );
    }
}
