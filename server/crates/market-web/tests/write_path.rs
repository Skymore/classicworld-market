//! Write path against Postgres. Cases follow `test_shared_market.py` and
//! `test_market_sales.py`, plus late uploads and the stats refresh.

mod common;

use common::TestDb;
use market_core::protocol::validate;
use market_web::auth::Collector;
use market_web::ingest::{ingest, IngestError, IngestOutcome, Received};
use market_web::stats::refresh_if_due;
use market_web::unix_now;
use market_web::views::{self, Hours};
use serde_json::{json, Value};

const DAY: f64 = 86400.0;

fn base(now: f64) -> Value {
    json!({
        "version": 1, "world": "ClassicWorld", "observation_id": "first", "complete": true,
        "observed_at": now - 60.0, "title": "Shop", "shop_id": 77, "location": {"channel": 9, "room": 8},
        "items": [{"item_id": 4010001, "slot": 1, "price": 500, "bundle": 1, "stock": 8}]
    })
}

async fn send(
    db: &TestDb,
    who: &Collector,
    data: &Value,
    now: f64,
) -> Result<IngestOutcome, IngestError> {
    let upload = validate(data, now).expect("valid upload");
    let raw = serde_json::to_vec(data).unwrap();
    ingest(
        &db.pool,
        Received {
            collector: who,
            upload: &upload,
            raw: &raw,
            received_at: now,
            now,
        },
    )
    .await
}

async fn summary(db: &TestDb, now: f64) -> Value {
    views::market_summary(&db.pool, Hours::Recent, now, true)
        .await
        .unwrap()
        .1
}

async fn item(db: &TestDb, id: i32, hours: Hours, now: f64) -> Value {
    views::market_item(&db.pool, id, hours, now, true)
        .await
        .unwrap()["products"][0]
        .clone()
}

async fn sale_kinds(db: &TestDb) -> Vec<(String, Option<i64>)> {
    sqlx::query_as(
        "SELECT kind, quantity FROM sales ORDER BY detected_at, observation_id, position",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

fn with(mut value: Value, f: impl FnOnce(&mut Value)) -> Value {
    f(&mut value);
    value
}

#[tokio::test]
async fn retry_is_a_no_op_and_changed_content_conflicts() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    let data = base(now);
    assert!(matches!(
        send(&db, &a, &data, now).await,
        Ok(IngestOutcome::Created(_))
    ));
    assert_eq!(
        send(&db, &a, &data, now).await.unwrap(),
        IngestOutcome::Duplicate
    );
    let changed = with(data, |v| v["items"][0]["price"] = json!(700));
    assert!(matches!(
        send(&db, &a, &changed, now).await,
        Err(IngestError::Conflict)
    ));
    let raw: i64 = sqlx::query_scalar("SELECT count(*) FROM uploads_raw")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(raw, 1);
    db.close().await;
}

#[tokio::test]
async fn two_collectors_one_quote_not_double_stock() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    send(&db, &a, &base(now), now).await.unwrap();
    send(&db, &b, &base(now), now).await.unwrap();
    let report = summary(&db, now).await;
    assert_eq!(report["manual_visits"], 2);
    assert_eq!(report["products"][0]["listings"], 1);
    assert_eq!(
        item(&db, 4010001, Hours::Recent, now).await["quotes"][0]["stock"],
        8
    );
    db.close().await;
}

#[tokio::test]
async fn location_is_part_of_identity_and_unlocated_shops_stay_per_collector() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    send(&db, &a, &base(now), now).await.unwrap();
    send(
        &db,
        &b,
        &with(base(now), |v| v["location"]["channel"] = json!(10)),
        now,
    )
    .await
    .unwrap();
    assert_eq!(summary(&db, now).await["products"][0]["shops"], 2);
    let unlocated = |id: &str| {
        with(base(now), |v| {
            v["location"] = Value::Null;
            v["observation_id"] = json!(id);
        })
    };
    send(&db, &a, &unlocated("u"), now).await.unwrap();
    send(&db, &b, &unlocated("u"), now).await.unwrap();
    assert_eq!(summary(&db, now).await["products"][0]["shops"], 4);
    db.close().await;
}

#[tokio::test]
async fn older_upload_cannot_replace_new_price() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    send(&db, &a, &base(now), now).await.unwrap();
    let old = with(base(now), |v| {
        v["observed_at"] = json!(now - 90.0);
        v["items"][0]["price"] = json!(1);
    });
    send(&db, &b, &old, now).await.unwrap();
    assert_eq!(summary(&db, now).await["products"][0]["low"], 500.0);
    db.close().await;
}

#[tokio::test]
async fn sold_out_not_counted_twice() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    send(&db, &a, &base(now), now).await.unwrap();
    let sold = with(base(now), |v| {
        v["observation_id"] = json!("sold");
        v["observed_at"] = json!(now - 50.0);
        v["items"][0]["stock"] = json!(0);
    });
    send(&db, &a, &sold, now).await.unwrap();
    send(&db, &b, &sold, now).await.unwrap();
    assert_eq!(
        sale_kinds(&db).await,
        vec![("sold_out".to_string(), Some(8))]
    );
    db.close().await;
}

#[tokio::test]
async fn slot_multiplicity_and_categories_are_preserved() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    let rows = with(base(now), |v| {
        let first = v["items"][0].clone();
        let items = v["items"].as_array_mut().unwrap();
        items.push(with(first.clone(), |r| r["slot"] = json!(2)));
        items.push(first); // the same source slot twice: two real rows
        items.push(json!({"item_id": 2040000, "slot": 1, "price": 100, "bundle": 1, "stock": 1}));
    });
    send(&db, &a, &rows, now).await.unwrap();
    send(&db, &b, &rows, now).await.unwrap();
    let report = summary(&db, now).await;
    let products = report["products"].as_array().unwrap();
    assert_eq!(products.len(), 2);
    let ore = products.iter().find(|p| p["item_id"] == 4010001).unwrap();
    assert_eq!(ore["listings"], 3);
    let slots: Vec<i64> = sqlx::query_scalar("SELECT slot::int8 FROM listings ORDER BY slot")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(slots, vec![2001, 4001, 4002, 1_004_001]);
    db.close().await;
}

#[tokio::test]
async fn empty_snapshot_removes_quotes_not_sale() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    send(&db, &a, &base(now), now).await.unwrap();
    let empty = with(base(now), |v| {
        v["observation_id"] = json!("empty");
        v["observed_at"] = json!(now - 59.0);
        v["items"] = json!([]);
    });
    send(&db, &b, &empty, now).await.unwrap();
    assert_eq!(summary(&db, now).await["products"][0]["listings"], 0);
    assert!(sale_kinds(&db).await.is_empty());
    db.close().await;
}

fn visit(now: f64, n: usize, ago: f64, stock: i64, price: i64, bundle: i64) -> Value {
    json!({
        "version": 1, "world": "ClassicWorld", "observation_id": format!("v{n}"), "complete": true,
        "observed_at": now - ago, "title": "pig", "shop_id": 1, "location": {"channel": 1, "room": 1},
        "items": [{"item_id": 4000008, "slot": 1, "price": price, "bundle": bundle, "stock": stock}]
    })
}

#[tokio::test]
async fn stock_drop_then_sold_out() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    for (n, (ago, stock)) in [(300.0, 10), (200.0, 7), (100.0, 0)]
        .into_iter()
        .enumerate()
    {
        send(&db, &a, &visit(now, n, ago, stock, 200, 2), now)
            .await
            .unwrap();
    }
    assert_eq!(
        sale_kinds(&db).await,
        vec![("drop".into(), Some(6)), ("sold_out".into(), Some(14))]
    );
    let product = item(&db, 4000008, Hours::Recent, now).await;
    let kinds: Vec<&str> = product["sales"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["sold_out", "drop"]);
    assert_eq!(
        (
            product["sold_out_count"].clone(),
            product["sales_count"].clone()
        ),
        (json!(1), json!(2))
    );
    assert_eq!(product["sales"][0]["sale_unit_price"], 100.0);
    db.close().await;
}

#[tokio::test]
async fn screen_source_sales_have_unknown_quantity() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    // The reader sends stock 1 (unsold) then 0 (sold): a sold_out whose
    // quantity cannot be known.
    for (n, (ago, stock)) in [(200.0, 1), (100.0, 0)].into_iter().enumerate() {
        let data = with(visit(now, n, ago, stock, 200, 2), |v| {
            v["source"] = json!("screen");
        });
        send(&db, &a, &data, now).await.unwrap();
    }
    assert_eq!(sale_kinds(&db).await, vec![("sold_out".into(), None)]);
    db.close().await;
}

#[tokio::test]
async fn restock_and_relisting_are_not_sales() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    for (n, (ago, stock, price, bundle)) in [
        (300.0, 3, 200, 2),
        (200.0, 9, 200, 2),
        (150.0, 5, 240, 2),
        (100.0, 4, 240, 1),
    ]
    .into_iter()
    .enumerate()
    {
        send(&db, &a, &visit(now, n, ago, stock, price, bundle), now)
            .await
            .unwrap();
    }
    assert!(sale_kinds(&db).await.is_empty());
    db.close().await;
}

#[tokio::test]
async fn a_late_upload_replays_its_shop() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    send(&db, &a, &visit(now, 2, 100.0, 0, 200, 1), now)
        .await
        .unwrap();
    assert_eq!(sale_kinds(&db).await, vec![("found_sold".into(), None)]);
    let Ok(IngestOutcome::Created(done)) =
        send(&db, &a, &visit(now, 1, 300.0, 5, 200, 1), now).await
    else {
        panic!("created");
    };
    assert_eq!((done.sales_added, done.sales_removed), (1, 1));
    assert_eq!(sale_kinds(&db).await, vec![("sold_out".into(), Some(5))]);
    // The later observation stays the shop's current state.
    assert_eq!(summary(&db, now).await["products"][0]["listings"], 0);
    db.close().await;
}

#[tokio::test]
async fn listing_state_does_not_reset_at_utc_midnight() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, b, now) = (db.collector("a").await, db.collector("b").await, unix_now());
    let midnight = ((now / DAY).floor() - 1.0) * DAY;
    let at = |id: &str, offset: f64, stock: i64| {
        with(base(now), |v| {
            v["observation_id"] = json!(id);
            v["observed_at"] = json!(midnight + offset);
            v["items"][0]["stock"] = json!(stock);
        })
    };
    send(&db, &a, &at("1", -600.0, 0), now).await.unwrap();
    send(&db, &b, &at("2", 600.0, 0), now).await.unwrap();
    assert_eq!(sale_kinds(&db).await.len(), 1);
    send(&db, &a, &at("3", 700.0, 8), now).await.unwrap();
    send(&db, &a, &at("4", 800.0, 5), now).await.unwrap();
    let product = item(&db, 4010001, Hours::All, now).await;
    assert_eq!(
        (product["shops"].clone(), product["listings"].clone()),
        (json!(1), json!(1))
    );
    assert_eq!(product["quotes"][0]["stock"], 5);
    db.close().await;
}

#[tokio::test]
async fn equipment_variants_are_listed_separately() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    let gear = |luk: i64| {
        json!({"item_id": 1040020, "slot": luk, "price": 2499, "bundle": 1, "stock": 1,
               "equipment": {"status": "candidate", "remaining_upgrades": 7, "enhancements": 0,
                             "stats": [{"key": "luk", "value": luk}]}})
    };
    let data = with(
        base(now),
        |v| v["items"] = json!([gear(1), gear(2), gear(2), {"item_id": 1040020, "slot": 9, "price": 1, "bundle": 1, "stock": 1}]),
    );
    send(&db, &a, &data, now).await.unwrap();
    let product = item(&db, 1040020, Hours::Recent, now).await;
    assert_eq!(product["variants"].as_array().unwrap().len(), 3);
    assert!(product["variants"]
        .as_array()
        .unwrap()
        .contains(&json!("unknown")));
    // Only ordinary rows price equipment: 2499 from the two candidate shops' rows.
    assert_eq!(product["recommendation"]["fast_price"], 2499.0);
    let variants: i64 = sqlx::query_scalar("SELECT count(*) FROM equipment_variants")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(variants, 2);
    db.close().await;
}

#[tokio::test]
async fn quote_window_and_refresh_follow_the_clock() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (a, now) = (db.collector("a").await, unix_now());
    // Five sales of the pig item four days ago.
    for n in 0..10 {
        let stock = if n % 2 == 0 { 3 } else { 0 };
        let mut data = visit(now, n, 4.0 * DAY - n as f64 * 60.0, stock, 200, 1);
        data["observation_id"] = json!(format!("pig{n}"));
        send(&db, &a, &data, now).await.unwrap();
    }
    let pig = |report: &Value| {
        report["products"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["item_id"] == 4000008)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        pig(&summary(&db, now).await)["sales_24h"],
        0,
        "historical imports must not become today's sales"
    );
    assert_eq!(
        pig(&summary(&db, now).await)["listings"],
        0,
        "shop last seen 4 days ago"
    );
    let all = views::market_summary(&db.pool, Hours::All, now, true)
        .await
        .unwrap()
        .1;
    assert_eq!(pig(&all)["sales_count"], 5);

    // A newer upload of another item cannot make historical sales recent.
    send(&db, &a, &base(now), now).await.unwrap();
    assert_eq!(pig(&summary(&db, now).await)["sales_24h"], 0);
    assert!(refresh_if_due(&db.pool, now).await.unwrap());
    assert_eq!(pig(&summary(&db, now).await)["sales_24h"], 0);
    assert_eq!(pig(&summary(&db, now).await)["sales_10d"], 5);
    assert!(
        !refresh_if_due(&db.pool, now + 1.0).await.unwrap(),
        "nothing moved"
    );
    // A real recent sale ages out as wall time passes even without new uploads.
    send(&db, &a, &visit(now, 10, 120.0, 3, 200, 1), now)
        .await
        .unwrap();
    send(&db, &a, &visit(now, 11, 60.0, 0, 200, 1), now)
        .await
        .unwrap();
    assert_eq!(pig(&summary(&db, now).await)["sales_24h"], 1);
    let later = now + DAY + 120.0;
    assert!(refresh_if_due(&db.pool, later).await.unwrap());
    assert_eq!(pig(&summary(&db, later).await)["sales_24h"], 0);
    assert_eq!(pig(&summary(&db, later).await)["sales_10d"], 6);
    db.close().await;
}
