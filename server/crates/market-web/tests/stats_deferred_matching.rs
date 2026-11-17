mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    external,
    ingest::{self, Received},
    stats, unix_now,
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


// Its own test binary: the deferred switch is process-wide.
#[tokio::test]
async fn deferred_writes_leave_cross_source_matching_to_the_background_pass() {
    let Some(db) = setup().await else { return };
    stats::defer_recompute(true);
    let now = unix_now();
    let c = db.collector("native").await;
    send(&db, &c, &native(now - 100., true, 1, 4010001, 300, 1), false).await;
    external(&db, &[now - 200.], 300., "RoleName", 4010001, "first").await;
    // The upload and the import only mark the item; no matching under the write lock.
    assert_eq!(counts(&db).await, (2, 2, 0));
    stats::recompute_dirty(&db.pool, now).await.unwrap();
    assert_eq!(counts(&db).await, (2, 1, 1));
}
