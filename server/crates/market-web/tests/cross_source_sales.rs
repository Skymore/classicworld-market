mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    external,
    ingest::{self, Received},
    stats, unix_now,
    views::{self, Hours},
};
use serde_json::{json, Value};

async fn setup() -> Option<TestDb> {
    let db = TestDb::new().await?;
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES (4010001,'Iron Ore','其他'),(2070000,'Subi','消耗品')")
        .execute(&db.pool).await.unwrap();
    Some(db)
}
fn native(time: f64, owner: bool, slots: usize, item: i32, price: i64, bundle: i32) -> Value {
    let mut v = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":"native",
        "observed_at":time,"title":"RoleName","shop_id":7,"location":{"channel":1,"room":1},
        "items":(1..=slots).map(|slot| json!({"item_id":item,"slot":slot,"price":price,"bundle":bundle,"stock":0})).collect::<Vec<_>>()});
    if owner {
        v["owner"] = json!({"character_id":42,"name":"RoleName","parser":"cw_shop_owner_v1"});
    }
    v
}
async fn send(db: &TestDb, c: &market_web::auth::Collector, v: &Value, repair: bool) {
    let now = unix_now();
    let upload = validate(v, now).unwrap();
    let raw = serde_json::to_vec(v).unwrap();
    let input = Received {
        collector: c,
        upload: &upload,
        raw: &raw,
        received_at: now,
        now,
    };
    if repair {
        ingest::repair_owner(&db.pool, input).await.unwrap();
    } else {
        ingest::ingest(&db.pool, input).await.unwrap();
    }
}
async fn external(db: &TestDb, times: &[f64], price: f64, seller: &str, item: i32, receipt: &str) {
    let now = unix_now();
    let id = format!("basil:{item:08}");
    let p: external::Points=serde_json::from_value(json!({"version":1,"source":"mesowatch","world":"ClassicWorld","generated_at":now,
        "manifest":{},"items":[{"source_item_id":id,"item_id":item,"name_en":if item==2070000 {"Subi"} else {"Iron Ore"},
        "unit_basis":if item==2070000 {"set"} else {"item"},"listings_generated_at":now}],
        "sales":times.iter().enumerate().map(|(i,t)|json!({"source_item_id":id,"source_key":format!("{id}:{receipt}:{i}"),
        "time":t,"kind":"drop","unit_price":price,"seller":seller,"location":{"room":22},"raw":{"qty":999}})).collect::<Vec<_>>(),"listings":[]})).unwrap();
    external::import(&db.pool, &p, receipt, now).await.unwrap();
}
async fn counts(db: &TestDb) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM sales),(SELECT count(*) FROM market_sales),(SELECT count(*) FROM cross_source_sale_matches)")
        .fetch_one(&db.pool).await.unwrap()
}

#[tokio::test]
async fn unknown_equipment_duplicate_keeps_the_native_captured_piece() {
    let Some(db) = setup().await else { return };
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES (1402007,'Iron Ore','装备')")
        .execute(&db.pool)
        .await
        .unwrap();
    let now = unix_now();
    let c = db.collector("native").await;
    let mut captured = native(now - 100., true, 1, 1402007, 50000, 1);
    captured["items"][0]["equipment"] = json!({"status":"candidate","stats":[{"key":"weapon_attack","value":55}],"enhancements":1,"remaining_upgrades":6,"unknown_fields":[]});
    send(&db, &c, &captured, false).await;
    external(&db, &[now - 200.], 50000., "RoleName", 1402007, "equipment").await;
    assert_eq!(counts(&db).await, (2, 1, 1));
    let row: (String, Option<i64>) =
        sqlx::query_as("SELECT source,variant_id FROM market_sales WHERE item_id=1402007")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(row.0, "collector");
    assert!(
        row.1.is_some(),
        "matched evidence keeps the native piece's captured stats"
    );
    db.close().await;
}

#[tokio::test]
async fn six_hour_rule_is_one_to_one_and_ignores_unknown_quantity_kind_and_location() {
    let Some(db) = setup().await else { return };
    let now = unix_now();
    let c = db.collector("native").await;
    send(
        &db,
        &c,
        &native(now - 100., true, 3, 4010001, 3000, 10),
        false,
    )
    .await;
    external(
        &db,
        &[now - 200., now - 300.],
        300.,
        "RoleName",
        4010001,
        "first",
    )
    .await;
    assert_eq!(counts(&db).await, (5, 3, 2));
    assert_eq!(
        market_web::sale_matching::backfill(&db.pool, now)
            .await
            .unwrap(),
        2
    );
    assert_eq!(counts(&db).await, (5, 3, 2));
    // Two more external rows consume only the single remaining native slot.
    external(
        &db,
        &[now - 400., now - 500.],
        300.,
        "RoleName",
        4010001,
        "second",
    )
    .await;
    assert_eq!(counts(&db).await, (7, 4, 3));
    let feed = views::latest_records(&db.pool, Hours::All, true, now)
        .await
        .unwrap();
    assert_eq!(feed["records"][0]["shop"], "RoleName");
    assert_eq!(feed["records"][0]["owner_name"], "RoleName");
    let (samples,): (i32,) =
        sqlx::query_as("SELECT sample_size FROM item_stats WHERE item_id=4010001")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(samples, 4);
    let links = "SELECT external_sale_id,collector_sale_id,matched_at::text FROM cross_source_sale_matches ORDER BY external_sale_id";
    let before: Vec<(i64, i64, String)> = sqlx::query_as(links).fetch_all(&db.pool).await.unwrap();
    assert!(stats::refresh_if_due(&db.pool, now + 65.).await.unwrap());
    let after: Vec<(i64, i64, String)> = sqlx::query_as(links).fetch_all(&db.pool).await.unwrap();
    assert_eq!(before, after, "clock-only refresh reuses existing links");
    db.close().await;
}

#[tokio::test]
async fn boundary_price_identity_and_item_are_required() {
    let Some(db) = setup().await else { return };
    let now = unix_now();
    let c = db.collector("native").await;
    send(
        &db,
        &c,
        &native(now - 100., true, 1, 4010001, 300, 1),
        false,
    )
    .await;
    external(
        &db,
        &[now - 21700.001],
        300.,
        "RoleName",
        4010001,
        "outside",
    )
    .await;
    external(&db, &[now - 100.], 301., "RoleName", 4010001, "price").await;
    external(&db, &[now - 100.], 300., "DifferentRole", 4010001, "owner").await;
    external(&db, &[now - 100.], 300., "RoleName", 2070000, "item").await;
    assert_eq!(counts(&db).await, (5, 5, 0));
    external(&db, &[now - 21700.], 300., "RoleName", 4010001, "boundary").await;
    assert_eq!(counts(&db).await, (6, 5, 1));
    db.close().await;
}

#[tokio::test]
async fn late_owner_enrichment_matches_without_using_the_shop_title_and_replay_restores_external() {
    let Some(db) = setup().await else { return };
    let now = unix_now();
    let c = db.collector("native").await;
    external(
        &db,
        &[now - 200.],
        300.,
        "RoleName",
        4010001,
        "before-native",
    )
    .await;
    let mut v = native(now - 100., false, 1, 4010001, 300, 1);
    send(&db, &c, &v, false).await;
    assert_eq!(
        counts(&db).await,
        (2, 2, 0),
        "title equality is not owner equality"
    );
    v["owner"] = json!({"character_id":42,"name":"RoleName","parser":"cw_shop_owner_v1"});
    send(&db, &c, &v, true).await;
    assert_eq!(counts(&db).await, (2, 1, 1));
    let mut tx = db.pool.begin().await.unwrap();
    stats::lock_writes(&mut tx).await.unwrap();
    sqlx::query("DELETE FROM sales WHERE source='collector'")
        .execute(&mut *tx)
        .await
        .unwrap();
    stats::recompute_items(&mut tx, &[4010001], now, now, &Default::default())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(counts(&db).await, (1, 1, 0));
    let feed = views::latest_records(&db.pool, Hours::All, true, now)
        .await
        .unwrap();
    assert_eq!(feed["records"][0]["shop"], "");
    assert_eq!(feed["records"][0]["owner_name"], "RoleName");
    db.close().await;
}

#[tokio::test]
async fn collector_arriving_last_uses_set_prices_and_prefers_the_nearest_external_event() {
    let Some(db) = setup().await else { return };
    let now = unix_now();
    let c = db.collector("native").await;
    external(
        &db,
        &[now - 200., now - 110.],
        1000.,
        "RoleName",
        2070000,
        "stars",
    )
    .await;
    send(
        &db,
        &c,
        &native(now - 100., true, 1, 2070000, 1000, 500),
        false,
    )
    .await;
    assert_eq!(counts(&db).await, (3, 2, 1));
    let delta: f64 = sqlx::query_scalar("SELECT delta_seconds FROM cross_source_sale_matches")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!((delta - 10.).abs() < 0.001);
    db.close().await;
}
