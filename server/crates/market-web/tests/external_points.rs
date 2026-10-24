//! Merge actual evidence points; source medians are never samples.
mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    external::{self, Points},
    ingest::{ingest, Received},
    unix_now,
    views::{self, Hours},
};
use serde_json::{json, Value};

fn points(now: f64, item: i32, name: &str, unit: &str, prices: &[f64]) -> Points {
    let id = format!("basil:{item:08}");
    serde_json::from_value(json!({"version":1,"source":"mesowatch","world":"ClassicWorld","generated_at":now,
      "manifest":{"raw_points_only":true},"items":[{"source_item_id":id,"item_id":item,"name_en":name,
        "unit_basis":unit,"listings_generated_at":now}],
      "sales":prices.iter().enumerate().map(|(n,p)|json!({"source_key":format!("{id}:{n}"),"source_item_id":id,
        "time":now-50.0+n as f64,"kind":"found_sold","unit_price":p,"seller":format!("seller{n}"),
        "location":{"room":1,"channel":null},"raw":{"id":n,"qty":500}})).collect::<Vec<_>>(),
      "listings":[{"source_key":format!("{id}:listing"),"source_item_id":id,"time":now-5.0,"generated_at":now,
        "unit_price":500.0,"seller":"Listing seller","location":{"room":1},"up":true,"raw":{"stock":null}}]})).unwrap()
}

async fn native(db: &TestDb, now: f64, item: i32, price: i64, bundle: i32) {
    let c = db.collector("native").await;
    let value = json!({"version":1,"world":"ClassicWorld","complete":true,"observed_at":now-60.0,
      "observation_id":"native-sale","title":"Local shop","shop_id":1,"location":{"channel":1,"room":1},
      "items":[{"item_id":item,"slot":1,"price":price,"bundle":bundle,"stock":0}]});
    let upload = validate(&value, now).unwrap();
    ingest(
        &db.pool,
        Received {
            collector: &c,
            upload: &upload,
            raw: &serde_json::to_vec(&value).unwrap(),
            received_at: now,
            now,
        },
    )
    .await
    .unwrap();
}

async fn product(db: &TestDb, now: f64) -> Value {
    views::market_summary(&db.pool, Hours::Recent, now, true)
        .await
        .unwrap()
        .1["products"][0]
        .clone()
}

#[tokio::test]
async fn merges_points_recomputes_and_retries_without_duplicate_samples() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let now = unix_now();
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES (4010001,'Iron Ore','其他')")
        .execute(&db.pool)
        .await
        .unwrap();
    native(&db, now, 4010001, 900, 1).await;
    let input = points(now, 4010001, "Iron Ore", "item", &[100., 300., 500., 700.]);
    assert_eq!(
        external::import(&db.pool, &input, "first", now)
            .await
            .unwrap()
            .sales_added,
        4
    );
    let p = product(&db, now).await;
    assert_eq!(p["typical"], 500.0);
    assert_eq!(p["typical_count"], 5);
    assert_eq!(p["sales_24h"], 5);
    assert_eq!(p["low"], 500.0);
    let quotes = views::latest_records(&db.pool, Hours::Recent, false, now)
        .await
        .unwrap();
    assert_eq!(quotes["records"][0]["unit_price"], 500.0);
    assert_eq!(quotes["records"][0]["stock"], Value::Null);
    assert_eq!(quotes["records"][0]["shop"], "Listing seller");
    let sales = views::latest_records(&db.pool, Hours::Recent, true, now)
        .await
        .unwrap();
    assert_eq!(sales["records"][0]["sale_unit_price"], 700.0);
    assert_eq!(sales["records"][0]["quantity"], Value::Null);
    assert_eq!(sales["records"][0]["shop"], "seller3");

    assert!(
        external::import(&db.pool, &input, "first", now)
            .await
            .unwrap()
            .duplicate_import
    );
    let repeated = external::import(&db.pool, &input, "another-manifest", now)
        .await
        .unwrap();
    assert_eq!((repeated.sales_added, repeated.duplicate_sales), (0, 4));
    assert_eq!(product(&db, now).await["typical_count"], 5);
    let page = views::item_page(&db.pool, 4010001, now)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page["sales"].as_array().unwrap().len(), 5);
    let external_sale = page["sales"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["source"] == "mesowatch")
        .unwrap();
    assert!(external_sale["quantity"].is_null());
    assert!(external_sale["bundle"].is_null());
    assert!(external_sale["visit_id"].is_null());
    let quote = page["listings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["source"] == "mesowatch")
        .unwrap();
    assert!(quote["stock"].is_null());
    let ssr = market_web::bestiary::queries::item_page(&db.pool, 4010001, now)
        .await
        .unwrap()
        .unwrap();
    assert!(ssr
        .market
        .listings
        .iter()
        .any(|q| q.stock.is_none() && q.shop == "Listing seller"));
    assert!(ssr.market.sales.iter().any(|s| s.shop == "seller0"));
    let query = views::SalesQuery {
        limit: 2,
        before: None,
        item_id: None,
        category: None,
    };
    let recent = views::recent_sales(&db.pool, &query, now + 1.)
        .await
        .unwrap();
    assert_eq!(recent["sales"].as_array().unwrap().len(), 2);
    assert_eq!(recent["sales"][0]["source"], "mesowatch");
    assert!(recent["next_before"].is_number());
    let mut changed = points(now, 4010001, "Iron Ore", "item", &[123.]);
    changed.sales[0].raw = json!({"id":"changed"});
    assert!(external::import(&db.pool, &changed, "conflict", now)
        .await
        .is_err());
    assert_eq!(product(&db, now).await["typical_count"], 5);
    db.close().await;
}

#[tokio::test]
async fn stars_share_set_prices_and_item_name_conflicts_are_not_guessed() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let now = unix_now();
    sqlx::query(
        "INSERT INTO items(id,name_en,category) VALUES (2070001,'Wolbi Throwing Stars','消耗品')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    native(&db, now, 2070001, 50000, 500).await;
    let input = points(now, 2070001, "Wolbi Throwing Stars", "set", &[60000.]);
    external::import(&db.pool, &input, "stars", now)
        .await
        .unwrap();
    assert_eq!(product(&db, now).await["typical"], 55000.0);
    let mismatch = points(now, 2070001, "A different item", "set", &[1.]);
    let result = external::import(&db.pool, &mismatch, "bad-name", now)
        .await
        .unwrap();
    assert_eq!(result.skipped_items.len(), 1);
    assert_eq!(result.sales_added, 0);
    let mut bad = points(now, 2070001, "Wolbi Throwing Stars", "set", &[1.]);
    bad.items[0].unit_basis = "item".into();
    assert!(external::import(&db.pool, &bad, "bad-unit", now)
        .await
        .is_err());
    db.close().await;
}

#[tokio::test]
async fn older_quotes_cannot_return_after_a_newer_empty_snapshot() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let now = unix_now();
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES (4010001,'Iron Ore','其他')")
        .execute(&db.pool)
        .await
        .unwrap();
    let original = points(now - 100., 4010001, "Iron Ore", "item", &[500.]);
    external::import(&db.pool, &original, "old", now)
        .await
        .unwrap();
    assert_eq!(
        external::quote_rows(&db.pool, &[4010001], now - 3600.)
            .await
            .unwrap()
            .len(),
        1
    );
    let mut empty = points(now - 50., 4010001, "Iron Ore", "item", &[]);
    empty.listings.clear();
    external::import(&db.pool, &empty, "new-empty", now)
        .await
        .unwrap();
    assert!(external::quote_rows(&db.pool, &[4010001], now - 3600.)
        .await
        .unwrap()
        .is_empty());
    external::import(&db.pool, &original, "late-old-export", now)
        .await
        .unwrap();
    assert!(external::quote_rows(&db.pool, &[4010001], now - 3600.)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(product(&db, now).await["typical_count"], 1);
    db.close().await;
}
