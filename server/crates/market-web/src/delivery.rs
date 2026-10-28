//! Small public projections and conditional responses. Market clocks describe
//! freshness, not a change to an item's offers or statistics.
use axum::{
    http::{header, HeaderMap, HeaderValue},
    response::Response,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) fn tag(scope: &str, value: &mut Value) -> String {
    let paths = [
        "/generated_at",
        "/as_of",
        "/page/market/as_of",
        "/page/stats/as_of",
    ];
    let clocks: Vec<_> = paths
        .iter()
        .map(|path| value.pointer_mut(path).map(Value::take))
        .collect();
    struct Hasher(Sha256);
    impl std::io::Write for Hasher {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hash = Hasher(Sha256::new());
    hash.0.update(scope.as_bytes());
    serde_json::to_writer(&mut hash, &value).expect("snapshot JSON");
    // Weak comparison permits freshness clocks to differ. All prices, counts,
    // filters, memberships and rolling-window results remain in the digest.
    let tag = format!("W/\"{}\"", hex::encode(hash.0.finalize()));
    for (path, clock) in paths.iter().zip(clocks) {
        if let Some(clock) = clock {
            *value.pointer_mut(path).unwrap() = clock;
        }
    }
    tag
}

pub(crate) fn revalidate(headers: &HeaderMap, scope: &str, mut value: Value) -> Response {
    let tag = tag(scope, &mut value);
    let mut response = if crate::api::not_modified(headers, &tag) {
        crate::api::unchanged(&tag)
    } else {
        crate::api::json_response(
            Some(&tag),
            serde_json::to_vec(&value).expect("snapshot JSON"),
        )
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response
}

pub(crate) fn selected(market: &Value, ids: &[i32]) -> Value {
    let products: Vec<_> = market["products"]
        .as_array()
        .expect("market products")
        .iter()
        .filter(|row| {
            row["item_id"]
                .as_i64()
                .is_some_and(|id| ids.contains(&(id as i32)))
        })
        .collect();
    json!({"products":products,"hours":market["hours"],"as_of":market["as_of"]})
}

pub(crate) fn overview(market: &Value) -> Value {
    let products = market["products"].as_array().expect("market products");
    let number = |row: &Value, field: &str| row[field].as_f64().unwrap_or(0.);
    let mut changes: Vec<_> = products
        .iter()
        .filter(|r| number(r, "change_window").abs() >= 0.5)
        .collect();
    // Changes measured on a few sales stay listed, after the reliable ones (as on the price page).
    let thin = |row: &Value| {
        let few = |field: &str| {
            row[field]
                .as_f64()
                .is_some_and(|n| n < market_core::stats::TYPICAL_MIN as f64)
        };
        few("sales_prev_window")
            || number(row, "sales_window") < market_core::stats::TYPICAL_MIN as f64
    };
    changes.sort_by(|a, b| {
        thin(a)
            .cmp(&thin(b))
            .then_with(|| {
                number(b, "change_window")
                    .abs()
                    .total_cmp(&number(a, "change_window").abs())
            })
            .then_with(|| number(b, "sales_window").total_cmp(&number(a, "sales_window")))
    });
    let mut busy: Vec<_> = products
        .iter()
        .filter(|r| number(r, "sales_window") > 0.)
        .collect();
    busy.sort_by(|a, b| {
        number(b, "sales_window")
            .total_cmp(&number(a, "sales_window"))
            .then_with(|| number(b, "listings").total_cmp(&number(a, "listings")))
            .then_with(|| number(a, "item_id").total_cmp(&number(b, "item_id")))
    });
    changes.truncate(8);
    busy.truncate(8);
    json!({"product_count":products.len(),"changes":changes,"busy":busy,"hours":market["hours"],"as_of":market["as_of"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overview_matches_rank_ties_and_keeps_only_top_eight() {
        let products: Vec<_> = (1..=20)
            .map(|id| {
                json!({"item_id":id,"sales_window":id/2,
            "listings":id%2,"change_window":if id%2==0 {-(id as f64)} else {id as f64}})
            })
            .collect();
        let value = overview(&json!({"products":products,"as_of":12,"hours":72}));
        assert_eq!(value["product_count"], 20);
        for key in ["changes", "busy"] {
            assert_eq!(
                value[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r["item_id"].as_i64().unwrap())
                    .collect::<Vec<_>>(),
                (13..=20).rev().collect::<Vec<_>>()
            );
        }
    }
    #[test]
    fn changes_on_a_few_sales_rank_after_reliable_ones() {
        let products = json!([
            {"item_id":1,"sales_window":40,"sales_prev_window":2,"change_window":-90.0},
            {"item_id":2,"sales_window":40,"sales_prev_window":30,"change_window":10.0},
            {"item_id":3,"sales_window":3,"sales_prev_window":30,"change_window":50.0},
            {"item_id":4,"sales_window":40,"sales_prev_window":30,"change_window":-20.0},
        ]);
        let value = overview(&json!({"products":products,"as_of":1,"hours":72}));
        let order: Vec<_> = value["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["item_id"].as_i64().unwrap())
            .collect();
        assert_eq!(order, vec![4, 2, 1, 3]);
    }
    #[test]
    fn semantic_validator_ignores_only_clocks_and_restores_payload() {
        let mut value = json!({"generated_at":1,"page":{"stats":{"as_of":1},"market":{"as_of":1,"listings":[{"stock":5}]}}});
        let original = value.clone();
        let first = tag("item", &mut value);
        assert_eq!(value, original);
        value["generated_at"] = json!(2);
        value["page"]["market"]["as_of"] = json!(2);
        assert_eq!(tag("item", &mut value), first);
        value["page"]["market"]["listings"][0]["stock"] = json!(4);
        assert_ne!(tag("item", &mut value), first);
    }
}
