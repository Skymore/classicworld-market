mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    auth::Collector,
    ingest::{ingest, repair_owner, IngestError, Received},
    unix_now,
};
use serde_json::{json, Value};

fn visit(id: &str, shop: u32, time: f64, owner: bool) -> Value {
    let mut v = json!({"version":1,"world":"ClassicWorld","complete":true,
        "observation_id":id,"observed_at":time,"shop_id":shop,"title":format!("Shop {shop}"),
        "location":{"channel":10,"room":6},
        "items":[{"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":8}]});
    if owner {
        v["owner"] = json!({"character_id":84954,"name":"ExampleHost","parser":"cw_shop_owner_v1"});
    }
    v
}
async fn send(db: &TestDb, who: &Collector, v: &Value, repair: bool) -> Result<bool, IngestError> {
    let upload = validate(v, v["observed_at"].as_f64().unwrap()).unwrap();
    let raw = serde_json::to_vec(v).unwrap();
    let input = Received {
        collector: who,
        upload: &upload,
        raw: &raw,
        received_at: unix_now(),
        now: unix_now(),
    };
    if repair {
        repair_owner(&db.pool, input).await
    } else {
        ingest(&db.pool, input).await.map(|_| true)
    }
}
async fn live(db: &TestDb) -> Vec<(i64, i64)> {
    sqlx::query_as("SELECT s.shop_id,l.price FROM listings l JOIN shops s ON s.id=l.shop_id WHERE l.stock>0 ORDER BY s.shop_id")
        .fetch_all(&db.pool).await.unwrap()
}
#[tokio::test]
async fn latest_owner_visit_retires_old_instances_without_fabricating_sales() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = db.collector("a").await;
    let b = db.collector("b").await;
    let now = unix_now();
    let old = visit("old", 3052, now - 90., true);
    send(&db, &a, &old, false).await.unwrap();
    let mut new = visit("new", 3109, now - 30., true);
    new["items"][0]["price"] = json!(399);
    send(&db, &b, &new, false).await.unwrap();
    assert_eq!(live(&db).await, vec![(3109, 399)]);
    let late = visit("late", 3052, now - 60., true);
    send(&db, &a, &late, false).await.unwrap();
    assert_eq!(live(&db).await, vec![(3109, 399)]);
    let mut empty = visit("empty", 3200, now, true);
    empty["items"] = json!([]);
    send(&db, &a, &empty, false).await.unwrap();
    assert!(live(&db).await.is_empty());
    let observations: i64 = sqlx::query_scalar("SELECT count(*) FROM observations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let sales: i64 = sqlx::query_scalar("SELECT count(*) FROM sales")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(observations, 4);
    assert_eq!(sales, 0);
    db.close().await;
}
#[tokio::test]
async fn historical_enrichment_is_authenticated_idempotent_and_preserves_facts() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = db.collector("a").await;
    let b = db.collector("b").await;
    let now = unix_now();
    let old = visit("old", 3052, now - 60. * 86400., false);
    let new = visit("new", 3109, now - 30., false);
    send(&db, &a, &old, false).await.unwrap();
    send(&db, &a, &new, false).await.unwrap();
    assert_eq!(live(&db).await.len(), 2);
    let before: Vec<(i64, String)> =
        sqlx::query_as("SELECT id,fingerprint FROM observations ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    let mut repaired_old = old.clone();
    repaired_old["owner"] = visit("x", 1, now, true)["owner"].clone();
    assert!(matches!(
        send(&db, &b, &repaired_old, true).await,
        Err(IngestError::Conflict)
    ));
    let mut changed = repaired_old.clone();
    changed["items"][0]["price"] = json!(999);
    assert!(matches!(
        send(&db, &a, &changed, true).await,
        Err(IngestError::Conflict)
    ));
    assert!(send(&db, &a, &repaired_old, true).await.unwrap());
    assert!(!send(&db, &a, &repaired_old, true).await.unwrap());
    let mut repaired_new = new.clone();
    repaired_new["owner"] = repaired_old["owner"].clone();
    assert!(send(&db, &a, &repaired_new, true).await.unwrap());
    assert_eq!(live(&db).await, vec![(3109, 500)]);
    let after: Vec<(i64, String)> =
        sqlx::query_as("SELECT id,fingerprint FROM observations ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let visits: i64 = sqlx::query_scalar("SELECT visits FROM market_state")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(visits, 2);
    db.close().await;
}
#[tokio::test]
async fn unknown_owners_are_not_merged_and_conflicting_owner_rolls_back() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = db.collector("a").await;
    let now = unix_now();
    send(&db, &a, &visit("a", 1, now - 20., true), false)
        .await
        .unwrap();
    send(&db, &a, &visit("b", 2, now - 10., false), false)
        .await
        .unwrap();
    assert_eq!(live(&db).await.len(), 2);
    let mut bad = visit("bad", 1, now, true);
    bad["owner"]["character_id"] = json!(999);
    assert!(matches!(
        send(&db, &a, &bad, false).await,
        Err(IngestError::Conflict)
    ));
    assert_eq!(live(&db).await.len(), 2);
    db.close().await;
}

#[tokio::test]
async fn older_equipment_parser_can_enrich_owner_without_rewriting_equipment() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = db.collector("a").await;
    let now = unix_now();
    let mut old = visit("old-equip", 11, now - 60., false);
    old["items"][0]["item_id"] = json!(1060048);
    old["items"][0]["equipment"] = json!({"status":"candidate","stats":[{"key":"str","value":4}],"remaining_upgrades":null,"unknown_fields":[]});
    send(&db, &a, &old, false).await.unwrap();
    let before: String = sqlx::query_scalar("SELECT fingerprint FROM observations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut enriched = old.clone();
    enriched["owner"] = visit("x", 1, now, true)["owner"].clone();
    enriched["items"][0]["equipment"]["enhancements"] = json!(0);
    enriched["items"][0]["equipment"]["remaining_upgrades"] = json!(7);
    let mut tampered = enriched.clone();
    tampered["items"][0]["equipment"]["stats"][0]["value"] = json!(99);
    assert!(matches!(
        send(&db, &a, &tampered, true).await,
        Err(IngestError::Conflict)
    ));
    assert!(send(&db, &a, &enriched, true).await.unwrap());
    let after: String = sqlx::query_scalar("SELECT fingerprint FROM observations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    db.close().await;
}
#[tokio::test]
async fn stall_follows_the_newest_reading_and_the_shop_view_lists_the_family() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = db.collector("a").await;
    let now = unix_now();
    let mut first = visit("stall-1", 3052, now - 60., true);
    first["stall"] = json!({"x":444,"y":-416,"permit":5140002,"parser":"cw_stall_v1"});
    first["items"] = json!([{"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":8},
                            {"item_id":2040001,"slot":2,"price":9000,"bundle":1,"stock":1}]);
    send(&db, &a, &first, false).await.unwrap();
    // An older reading arriving late never moves the stall back.
    let mut late = visit("stall-0", 3052, now - 120., true);
    late["stall"] = json!({"x":10,"y":34,"permit":5140000,"parser":"cw_stall_v1"});
    send(&db, &a, &late, false).await.unwrap();
    let key: String = sqlx::query_scalar("SELECT public_key FROM shops WHERE shop_id=3052")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let view = market_web::views::shop_view(&db.pool, &key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(view["stall"]["x"], 444);
    assert_eq!(view["stall"]["permit"], 5140002);
    assert_eq!(view["room"], 6);
    assert_eq!(view["items"].as_array().unwrap().len(), 2);
    // Every stall of the room, the shop itself included.
    let neighbors = view["neighbors"].as_array().unwrap();
    assert_eq!(neighbors.len(), 1);
    assert_eq!(neighbors[0]["shop_key"], json!(key));
    // A screen upload may not claim a stall; an unknown parser is refused.
    let mut screen = visit("screen", 3052, now, false);
    screen["source"] = json!("screen");
    screen["stall"] = json!({"x":1,"y":2,"permit":5140002,"parser":"cw_stall_v1"});
    assert!(validate(&screen, now).is_err());
    let mut odd = visit("odd", 3052, now, true);
    odd["stall"] = json!({"x":1,"y":2,"permit":5000004,"parser":"cw_stall_v1"});
    assert!(validate(&odd, now).is_err());
    assert!(market_web::views::shop_view(&db.pool, "missing")
        .await
        .unwrap()
        .is_none());
    db.close().await;
}
